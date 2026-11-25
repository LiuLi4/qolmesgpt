import type { PrismaClient } from "../generated/prisma/client.js";

export class WorkspaceAutomationService {
  constructor(private readonly prisma: PrismaClient) {}

  async set(userId: string, workspaceId: string, enabled: boolean): Promise<{ automationEnabled: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.groupWorkspace.updateMany({ where: { id: workspaceId, group: { connection: { userId, status: "ACTIVE" } } }, data: { automationEnabled: enabled } });
      if (updated.count !== 1) throw new Error("Workspace not found");
      if (!enabled) {
        // Match the investigation store's task-before-outbox lock order and fence concurrent claims.
        await tx.$queryRaw`SELECT id FROM "InvestigationTask" WHERE "workspaceId" = ${workspaceId}::uuid ORDER BY id FOR UPDATE`;
        await tx.sLSConsumerState.updateMany({ where: { connection: { workspaceId } }, data: { status: "STOPPED", workerId: null, leaseExpiresAt: null, shardAssignments: [] } });
        await tx.outboxMessage.updateMany({ where: { eventType: "InvestigationRequested", claimedAt: { not: null }, attempts: { gt: 0 }, task: { workspaceId, approvals: { none: {} } } }, data: { claimedAt: null, claimOwner: null, attempts: { decrement: 1 } } });
        await tx.investigationTask.updateMany({ where: { workspaceId, status: "INVESTIGATING", approvals: { none: {} } }, data: { status: "INVESTIGATION_PENDING" } });
      }
      return { automationEnabled: enabled };
    });
  }
}
