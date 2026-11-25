import { Prisma, type PrismaClient } from "../generated/prisma/client.js";

export interface InvestigationJob {
  readonly outboxId: string;
  readonly taskId: string;
  readonly projectId: string | null;
  readonly workspaceId?: string | null;
  readonly repositories?: readonly { id: string; projectPath: string; workspacePath: string | null }[];
  readonly errorEventId: string;
  readonly errorEvidence: Prisma.JsonValue;
  readonly relatedLogs: readonly Prisma.JsonValue[];
  readonly evidenceVersion: number;
  readonly projectPath: string;
  readonly workspacePath: string | null;
  readonly attempts: number;
}

export interface InvestigationResult {
  readonly summary: string;
  readonly rootCause: string;
  readonly codeContext: string[];
  readonly proposedFix: string;
  readonly confidence: "low" | "medium" | "high";
  readonly affectedProjectIds?: string[];
}

export class PrismaInvestigationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(owner: string, now = new Date(), leaseMs = 300_000): Promise<InvestigationJob | null> {
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.outboxMessage.findFirst({
        where: {
          eventType: "InvestigationRequested",
          task: { OR: [{ workspaceId: null }, { workspace: { automationEnabled: true } }], mergedIntoTaskId: null, status: { in: ["INVESTIGATION_PENDING", "INVESTIGATING"] }, approvals: { none: {} } },
          availableAt: { lte: now },
          OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - leaseMs) } }],
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, aggregateId: true, attempts: true },
      });
      if (!candidate) return null;
      await tx.$queryRaw`SELECT id FROM "InvestigationTask" WHERE id = ${candidate.aggregateId}::uuid FOR UPDATE`;
      const enabled = await tx.investigationTask.findFirst({ where: { id: candidate.aggregateId, mergedIntoTaskId: null, status: { in: ["INVESTIGATION_PENDING", "INVESTIGATING"] }, approvals: { none: {} }, OR: [{ workspaceId: null }, { workspace: { automationEnabled: true } }] }, select: { id: true } });
      if (!enabled) return null;
      const claimed = await tx.outboxMessage.updateMany({
        where: { id: candidate.id, OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - leaseMs) } }] },
        data: { claimedAt: now, claimOwner: owner, attempts: { increment: 1 } },
      });
      if (claimed.count !== 1) return null;
      const task = await tx.investigationTask.findUnique({
        where: { id: candidate.aggregateId },
        select: {
          id: true,
          projectId: true,
          workspaceId: true,
          workspace: { select: { relativePath: true, group: { select: { fullPath: true } }, repositories: { where: { active: true }, select: { project: { select: { id: true, pathWithNamespace: true, workspace: { select: { relativePath: true, status: true } } } } } } } },
          errorEventId: true,
          errorEvent: { select: { logEvidenceJson: true } },
          events: { orderBy: { sourceTimestamp: "desc" }, take: 50, select: { logEvidenceJson: true, correlationKey: true, traceId: true, requestId: true, sourceTimestamp: true } },
          evidenceVersion: true,
          project: { select: { pathWithNamespace: true, workspace: { select: { relativePath: true } } } },
        },
      });
      if (!task) return null;

      await tx.investigationTask.updateMany({ where: { id: task.id, status: "INVESTIGATION_PENDING" }, data: { status: "INVESTIGATING" } });
      return {
        outboxId: candidate.id,
        taskId: task.id,
        projectId: task.projectId,
        workspaceId: task.workspaceId,
        repositories: task.workspace?.repositories.map(({ project }) => ({ id: project.id, projectPath: project.pathWithNamespace, workspacePath: project.workspace?.status === "READY" ? project.workspace.relativePath : null })),
        errorEventId: task.errorEventId,
        errorEvidence: task.errorEvent.logEvidenceJson,
        relatedLogs: task.events.map((event) => ({ timestamp: event.sourceTimestamp.toISOString(), correlationKey: event.correlationKey, traceId: event.traceId, requestId: event.requestId, log: event.logEvidenceJson })) as unknown as Prisma.JsonValue[],
        evidenceVersion: task.evidenceVersion,
        projectPath: task.workspace?.group.fullPath ?? task.project?.pathWithNamespace ?? "Unknown scope",
        workspacePath: task.workspace?.relativePath ?? task.project?.workspace?.relativePath ?? null,
        attempts: candidate.attempts + 1,
      };
    });
  }

  async complete(outboxId: string, owner: string, result: InvestigationResult, evidenceVersion: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const message = await tx.outboxMessage.findUnique({ where: { id: outboxId }, select: { aggregateId: true, claimOwner: true } });
      if (!message || message.claimOwner !== owner) throw new Error("Investigation outbox lease lost");
      await tx.$queryRaw`SELECT id FROM "InvestigationTask" WHERE id = ${message.aggregateId}::uuid FOR UPDATE`;
      if (!(await tx.outboxMessage.findFirst({ where: { id: outboxId, claimOwner: owner } }))) throw new Error("Investigation outbox lease lost");
      const task = await tx.investigationTask.findUniqueOrThrow({ where: { id: message.aggregateId }, select: { workspaceId: true, projectId: true, evidenceVersion: true } });
      if (task.evidenceVersion !== evidenceVersion) {
        await tx.investigationTask.update({ where: { id: message.aggregateId }, data: { status: "INVESTIGATION_PENDING", investigationResultJson: Prisma.DbNull, analyzedVersion: 0 } });
        await tx.outboxMessage.update({ where: { id: outboxId }, data: { claimedAt: null, claimOwner: null, attempts: 0, availableAt: new Date(Date.now() + 10_000) } });
        return;
      }
      const targets = [...new Set(result.affectedProjectIds ?? (task.projectId ? [task.projectId] : []))];
      if (task.workspaceId && targets.length) {
        const count = await tx.workspaceRepository.count({ where: { workspaceId: task.workspaceId, active: true, projectId: { in: targets }, project: { workspace: { status: "READY" } } } });
        if (count !== targets.length) throw new Error("HOLMES_INVALID_REPOSITORY_TARGET");
      } else if (!task.workspaceId && targets.some((id) => id !== task.projectId)) throw new Error("HOLMES_INVALID_REPOSITORY_TARGET");
      await tx.taskRepository.deleteMany({ where: { taskId: message.aggregateId } });
      if (targets.length) await tx.taskRepository.createMany({ data: targets.map((projectId) => ({ taskId: message.aggregateId, projectId })) });
      await tx.investigationTask.update({ where: { id: message.aggregateId }, data: { status: "AWAITING_APPROVAL", investigationResultJson: result as unknown as Prisma.InputJsonValue, analyzedVersion: evidenceVersion } });
      await tx.outboxMessage.delete({ where: { id: outboxId } });
    });
  }

  async isAutomationEnabled(taskId: string): Promise<boolean> {
    return Boolean(await this.prisma.investigationTask.findFirst({ where: { id: taskId, mergedIntoTaskId: null, approvals: { none: {} }, OR: [{ workspaceId: null }, { workspace: { automationEnabled: true } }] }, select: { id: true } }));
  }

  async defer(outboxId: string, owner: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const message = await tx.outboxMessage.findUnique({ where: { id: outboxId }, select: { aggregateId: true, claimOwner: true } });
      if (!message || message.claimOwner !== owner) return;
      await tx.$queryRaw`SELECT id FROM "InvestigationTask" WHERE id = ${message.aggregateId}::uuid FOR UPDATE`;
      const released = await tx.outboxMessage.updateMany({ where: { id: outboxId, claimOwner: owner }, data: { claimedAt: null, claimOwner: null, attempts: { decrement: 1 } } });
      if (released.count) await tx.investigationTask.updateMany({ where: { id: message.aggregateId, mergedIntoTaskId: null, approvals: { none: {} }, status: "INVESTIGATING" }, data: { status: "INVESTIGATION_PENDING" } });
    });
  }

  async retry(taskId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.investigationTask.updateMany({ where: { id: taskId, mergedIntoTaskId: null, status: { in: ["FAILED", "INVESTIGATION_PENDING", "AWAITING_APPROVAL"] }, approvals: { none: {} }, repairRuns: { none: {} }, OR: [{ workspaceId: null }, { workspace: { automationEnabled: true } }] }, data: { status: "INVESTIGATION_PENDING", investigationResultJson: Prisma.DbNull, analyzedVersion: 0 } });
      if (claimed.count !== 1) throw new Error("Task cannot be retried while investigating, approved or repairing");
      await tx.outboxMessage.deleteMany({ where: { aggregateId: taskId, eventType: "InvestigationRequested" } });
      await tx.outboxMessage.create({ data: { aggregateType: "InvestigationTask", aggregateId: taskId, eventType: "InvestigationRequested", payload: { taskId } } });
    });
  }

  async fail(outboxId: string, owner: string, error: { code: string; message: string }, retryAt: Date | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const message = await tx.outboxMessage.findUnique({ where: { id: outboxId }, select: { aggregateId: true, claimOwner: true } });
      if (!message || message.claimOwner !== owner) throw new Error("Investigation outbox lease lost");
      await tx.$queryRaw`SELECT id FROM "InvestigationTask" WHERE id = ${message.aggregateId}::uuid FOR UPDATE`;
      if (!(await tx.outboxMessage.findFirst({ where: { id: outboxId, claimOwner: owner } }))) throw new Error("Investigation outbox lease lost");
      await tx.investigationTask.update({ where: { id: message.aggregateId }, data: { status: retryAt ? "INVESTIGATING" : "FAILED", investigationResultJson: { errorCode: error.code, errorMessage: error.message } } });
      if (retryAt) await tx.outboxMessage.update({ where: { id: outboxId }, data: { claimedAt: null, claimOwner: null, availableAt: retryAt } });
      else await tx.outboxMessage.delete({ where: { id: outboxId } });
    });
  }
}
