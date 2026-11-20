import type { Prisma, PrismaClient } from "../generated/prisma/client.js";

export interface InvestigationJob {
  readonly outboxId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly errorEventId: string;
  readonly errorEvidence: Prisma.JsonValue;
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
}

export class PrismaInvestigationStore {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(owner: string, now = new Date(), leaseMs = 300_000): Promise<InvestigationJob | null> {
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.outboxMessage.findFirst({
        where: {
          eventType: "InvestigationRequested",
          availableAt: { lte: now },
          OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - leaseMs) } }],
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, aggregateId: true, attempts: true },
      });
      if (!candidate) return null;
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
          errorEventId: true,
          errorEvent: { select: { logEvidenceJson: true } },
          project: { select: { pathWithNamespace: true, workspace: { select: { relativePath: true } } } },
        },
      });
      if (!task) return null;
      await tx.investigationTask.updateMany({ where: { id: task.id, status: "INVESTIGATION_PENDING" }, data: { status: "INVESTIGATING" } });
      return {
        outboxId: candidate.id,
        taskId: task.id,
        projectId: task.projectId,
        errorEventId: task.errorEventId,
        errorEvidence: task.errorEvent.logEvidenceJson,
        projectPath: task.project.pathWithNamespace,
        workspacePath: task.project.workspace?.relativePath ?? null,
        attempts: candidate.attempts + 1,
      };
    });
  }

  async complete(outboxId: string, owner: string, result: InvestigationResult): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const message = await tx.outboxMessage.findUnique({ where: { id: outboxId }, select: { aggregateId: true, claimOwner: true } });
      if (!message || message.claimOwner !== owner) throw new Error("Investigation outbox lease lost");
      await tx.investigationTask.update({ where: { id: message.aggregateId }, data: { status: "AWAITING_APPROVAL", investigationResultJson: result as unknown as Prisma.InputJsonValue } });
      await tx.outboxMessage.delete({ where: { id: outboxId } });
    });
  }

  async fail(outboxId: string, owner: string, error: { code: string; message: string }, retryAt: Date | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const message = await tx.outboxMessage.findUnique({ where: { id: outboxId }, select: { aggregateId: true, claimOwner: true } });
      if (!message || message.claimOwner !== owner) throw new Error("Investigation outbox lease lost");
      await tx.investigationTask.update({ where: { id: message.aggregateId }, data: { status: retryAt ? "INVESTIGATING" : "FAILED", investigationResultJson: { errorCode: error.code, errorMessage: error.message } } });
      if (retryAt) await tx.outboxMessage.update({ where: { id: outboxId }, data: { claimedAt: null, claimOwner: null, availableAt: retryAt } });
      else await tx.outboxMessage.delete({ where: { id: outboxId } });
    });
  }
}
