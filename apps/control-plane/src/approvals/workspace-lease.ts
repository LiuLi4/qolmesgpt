import type { PrismaClient } from "../generated/prisma/client.js";

export interface RepairLease {
  readonly projectId: string;
  readonly owner: string;
  readonly fencingToken: bigint;
}

export class PrismaWorkspaceLeaseManager {
  constructor(private readonly prisma: PrismaClient, private readonly ttlMs = 30 * 60_000) {}

  async acquireLock(projectId: string, owner: string): Promise<RepairLease> {
    const now = new Date();
    const updated = await this.prisma.projectWorkspace.updateMany({
      where: {
        projectId,
        status: { in: ["READY", "OCCUPIED"] },
        OR: [{ lockOwner: null }, { lockExpiresAt: { lt: now } }],
      },
      data: { lockOwner: owner, lockExpiresAt: new Date(now.getTime() + this.ttlMs), status: "OCCUPIED", fencingToken: { increment: 1n } },
    });
    if (updated.count !== 1) throw new Error("Workspace is currently occupied or unavailable");
    const workspace = await this.prisma.projectWorkspace.findUnique({ where: { projectId }, select: { fencingToken: true } });
    if (!workspace) throw new Error("Workspace disappeared after lock acquisition");
    return { projectId, owner, fencingToken: workspace.fencingToken };
  }

  async assertLease(lease: RepairLease): Promise<void> {
    const now = new Date();
    const renewed = await this.prisma.projectWorkspace.updateMany({
      where: { projectId: lease.projectId, lockOwner: lease.owner, fencingToken: lease.fencingToken, lockExpiresAt: { gt: new Date() } },
      data: { lockExpiresAt: new Date(now.getTime() + this.ttlMs) },
    });
    if (renewed.count !== 1) throw new Error("Workspace fencing lease is no longer valid");
  }

  async releaseLock(lease: RepairLease): Promise<void> {
    const released = await this.prisma.projectWorkspace.updateMany({
      where: { projectId: lease.projectId, lockOwner: lease.owner, fencingToken: lease.fencingToken },
      data: { lockOwner: null, lockExpiresAt: null, status: "READY" },
    });
    if (released.count !== 1) throw new Error("Workspace lock is no longer owned by this repair");
  }
}
