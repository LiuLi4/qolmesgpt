import type { PrismaClient } from "../generated/prisma/client.js";
import type { RepairAuthorization, RepairStore } from "./repair-types.js";
import type { ExecutionResult } from "@qolmesgpt/security";
interface RepairCommand { readonly command: string; readonly args: readonly string[]; }
interface RepairOutboxJob { readonly outboxId: string; readonly taskId: string; readonly owner: string; readonly attempts: number; readonly commands: readonly RepairCommand[]; }
interface RepairOutboxStore {
  claimRequested(owner: string): Promise<RepairOutboxJob | null>;
  acknowledgeRequested(outboxId: string, owner: string): Promise<void>;
  failRequested(outboxId: string, owner: string, error: { code: string; message: string }, retryAt: Date | null): Promise<void>;
}

function parseCommands(value: unknown): RepairCommand[] {
  if (!value || typeof value !== "object") return [];
  const commands = (value as { repairCommands?: unknown }).repairCommands;
  if (!Array.isArray(commands)) return [];
  return commands.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const command = (entry as { command?: unknown }).command;
    const args = (entry as { args?: unknown }).args;
    if (typeof command !== "string" || !command.startsWith("/usr/bin/") || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return [];
    return [{ command, args: args as string[] }];
  });
}

export class PrismaRepairStore implements RepairStore, RepairOutboxStore {
  constructor(private readonly prisma: PrismaClient, private readonly workspaceRoot: string) {}

  async claimRequested(owner: string): Promise<RepairOutboxJob | null> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const message = await tx.outboxMessage.findFirst({
        where: { eventType: "RepairRequested", availableAt: { lte: now }, OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - 300_000) } }] },
        orderBy: { createdAt: "asc" },
        select: { id: true, aggregateId: true, attempts: true },
      });
      if (!message) return null;
      const claimed = await tx.outboxMessage.updateMany({ where: { id: message.id, OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - 300_000) } }] }, data: { claimedAt: now, claimOwner: owner, attempts: { increment: 1 } } });
      if (claimed.count !== 1) return null;
      const task = await tx.investigationTask.findUnique({ where: { id: message.aggregateId }, select: { investigationResultJson: true } });
      return { outboxId: message.id, taskId: message.aggregateId, owner, attempts: message.attempts + 1, commands: parseCommands(task?.investigationResultJson) };
    });
  }

  async acknowledgeRequested(outboxId: string, owner: string): Promise<void> {
    const result = await this.prisma.outboxMessage.deleteMany({ where: { id: outboxId, eventType: "RepairRequested", claimOwner: owner } });
    if (result.count !== 1) throw new Error("Repair outbox lease lost");
  }

  async failRequested(outboxId: string, owner: string, error: { code: string; message: string }, retryAt: Date | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const message = await tx.outboxMessage.findFirst({ where: { id: outboxId, eventType: "RepairRequested", claimOwner: owner }, select: { aggregateId: true } });
      if (!message) throw new Error("Repair outbox lease lost");
      if (retryAt) {
        await tx.outboxMessage.update({ where: { id: outboxId }, data: { payload: { errorCode: error.code, errorMessage: error.message }, claimedAt: null, claimOwner: null, availableAt: retryAt } });
      } else {
        await tx.investigationTask.updateMany({ where: { id: message.aggregateId, status: "REPAIRING" }, data: { status: "FAILED", investigationResultJson: { errorCode: error.code, errorMessage: error.message } } });
        await tx.outboxMessage.delete({ where: { id: outboxId } });
      }
    });
  }

  async authorize(taskId: string): Promise<RepairAuthorization | null> {
    const task = await this.prisma.investigationTask.findUnique({
      where: { id: taskId },
      select: {
        id: true, projectId: true, status: true,
        approvals: { select: { id: true, decision: true, approverUserId: true } },
        project: { select: { connectionId: true, groupId: true, workspace: { select: { relativePath: true, status: true } } } },
      },
    });
    const approval = task?.approvals[0];
    if (!task || !approval || approval.decision !== "APPROVED" || (task.status !== "AWAITING_APPROVAL" && task.status !== "REPAIRING") || !task.project.workspace || task.project.workspace.status !== "READY" && task.project.workspace.status !== "OCCUPIED") return null;
    return {
      taskId,
      projectId: task.projectId,
      workspacePath: `${this.workspaceRoot.replace(/\/$/, "")}/${task.project.workspace.relativePath}`,
      taskStatus: task.status,
      approvalId: approval.id,
      approverUserId: approval.approverUserId,
      gitLabConnectionId: task.project.connectionId,
      groupId: task.project.groupId,
    };
  }

  async start(taskId: string, workspacePath: string, owner: string, fencingToken: bigint): Promise<{ repairRunId: string; fencingToken: bigint }> {
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.investigationTask.findUnique({ where: { id: taskId }, select: { projectId: true, status: true, approvals: { where: { decision: "APPROVED" }, select: { id: true } }, project: { select: { workspace: { select: { id: true, relativePath: true } } } } } });
      if (!task || task.status !== "AWAITING_APPROVAL" || !task.approvals.length || !task.project.workspace) throw new Error("Approved repair task or workspace is unavailable");
      const expectedPath = `${this.workspaceRoot.replace(/\/$/, "")}/${task.project.workspace.relativePath}`;
      if (workspacePath !== expectedPath) throw new Error("Repair workspace path does not match the project record");
      const lease = await tx.projectWorkspace.findFirst({ where: { id: task.project.workspace.id, lockOwner: owner, fencingToken, lockExpiresAt: { gt: new Date() } }, select: { id: true } });
      if (!lease) throw new Error("Repair workspace fencing lease is invalid");
      const idempotencyKey = `repair:${taskId}:${fencingToken}`;
      const existing = await tx.repairRun.findUnique({ where: { idempotencyKey }, select: { id: true } });
      if (existing) return { repairRunId: existing.id, fencingToken };
      const moved = await tx.investigationTask.updateMany({ where: { id: taskId, status: "AWAITING_APPROVAL", approvals: { some: { decision: "APPROVED" } } }, data: { status: "REPAIRING" } });
      if (moved.count !== 1) throw new Error("Repair task approval or state changed");
      const run = await tx.repairRun.create({ data: { taskId, workspaceId: task.project.workspace.id, branch: `qolmesgpt/repair/${taskId}`, fencingToken, idempotencyKey, status: "RUNNING", startedAt: new Date() }, select: { id: true } });
      return { repairRunId: run.id, fencingToken };
    });
  }

  async setTaskStatus(taskId: string, status: "FAILED"): Promise<void> {
    const updated = await this.prisma.investigationTask.updateMany({
      where: { id: taskId, status: "REPAIRING" },
      data: { status },
    });
    if (updated.count !== 1) throw new Error("Repair task state or approval changed");
  }

  async finish(repairRunId: string, status: "TESTS_PASSED" | "FAILED", output: readonly ExecutionResult[]): Promise<void> {
    await this.prisma.repairRun.update({
      where: { id: repairRunId },
      data: { status: status === "TESTS_PASSED" ? "TESTS_PASSED" : "FAILED", testResult: output as unknown as object, finishedAt: new Date() },
    });
  }
}
