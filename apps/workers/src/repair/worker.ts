import type { ExecutionResult, NsjailExecutionRunner } from "@qolmesgpt/security";

export interface RepairCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface RepairOutboxJob {
  readonly outboxId: string;
  readonly taskId: string;
  readonly owner: string;
  readonly attempts: number;
  readonly commands: readonly RepairCommand[];
}

export interface RepairOutboxStore {
  claimRequested(owner: string): Promise<RepairOutboxJob | null>;
  acknowledgeRequested(outboxId: string, owner: string): Promise<void>;
  failRequested(outboxId: string, owner: string, error: { code: string; message: string }, retryAt: Date | null): Promise<void>;
}

export interface RepairAuthorization {
  readonly taskId: string;
  readonly projectId: string;
  readonly workspacePath: string;
  readonly taskStatus: "AWAITING_APPROVAL" | "REPAIRING";
  readonly approvalId: string;
  readonly approverUserId: string;
  readonly gitLabConnectionId: string;
  readonly groupId: string;
}

export interface RepairStore {
  authorize(taskId: string): Promise<RepairAuthorization | null>;
  start(taskId: string, workspacePath: string, owner: string, fencingToken: bigint): Promise<{ repairRunId: string; fencingToken: bigint }>;
  setTaskStatus(taskId: string, status: "FAILED"): Promise<void>;
  finish(repairRunId: string, status: "TESTS_PASSED" | "FAILED", output: readonly ExecutionResult[]): Promise<void>;
}

export interface RepairWorkspace {
  acquireLock(projectId: string, owner: string): Promise<{ projectId: string; owner: string; fencingToken: bigint }>;
  assertLease(lease: { projectId: string; owner: string; fencingToken: bigint }): Promise<void>;
  releaseLock(lease: { projectId: string; owner: string; fencingToken: bigint }): Promise<void>;
}

export interface RepairRoleVerifier {
  getApprovalRole(userId: string, connectionId: string, groupId: string): Promise<{ role: string; eligible: boolean }>;
}

export interface RepairRuntimeConfig {
  readonly workspaceRoot: string;
  readonly jailRoot: string;
}

export async function runApprovedRepair(store: RepairStore, workspace: RepairWorkspace, executor: Pick<NsjailExecutionRunner, "execute">, roles: RepairRoleVerifier, taskId: string, owner: string, commands: readonly RepairCommand[], config: RepairRuntimeConfig): Promise<void> {
  if (commands.length === 0) throw new Error("Approved repair requires at least one bounded command");
  const authorization = await store.authorize(taskId);
  if (!authorization || authorization.taskStatus !== "AWAITING_APPROVAL" || !authorization.approvalId) throw new Error("Repair requires a valid approval");
  const verifyRole = async () => {
    const current = await roles.getApprovalRole(authorization.approverUserId, authorization.gitLabConnectionId, authorization.groupId);
    if (!current.eligible || !["DEVELOPER", "MAINTAINER", "OWNER"].includes(current.role)) throw new Error("Repair approver no longer has an eligible GitLab Group role");
  };
  await verifyRole();
  const lease = await workspace.acquireLock(authorization.projectId, owner);
  let runId: string | undefined;
  const output: ExecutionResult[] = [];
  try {
    const run = await store.start(taskId, authorization.workspacePath, owner, lease.fencingToken);
    runId = run.repairRunId;
    for (const command of commands) {
      await verifyRole();
      const current = await store.authorize(taskId);
      if (!current || current.approvalId !== authorization.approvalId || current.taskStatus !== "REPAIRING") throw new Error("Repair authorization changed");
      await workspace.assertLease(lease);
      const result = await executor.execute({ ...command, workspacePath: authorization.workspacePath, ...config });
      output.push(result);
      if (result.exitCode !== 0 || result.timedOut) {
        await store.setTaskStatus(taskId, "FAILED");
        await store.finish(runId, "FAILED", output);
        return;
      }
    }
    await workspace.assertLease(lease);
    await store.finish(runId, "TESTS_PASSED", output);
  } catch (error) {
    if (runId) await store.finish(runId, "FAILED", output);
    await store.setTaskStatus(taskId, "FAILED").catch(() => undefined);
    throw error;
  } finally {
    await workspace.releaseLock(lease);
  }
}

const RETRY_DELAYS_MS = [30_000, 120_000];

export async function runRepairWorkerOnce(outbox: RepairOutboxStore, repair: RepairStore, workspace: RepairWorkspace, executor: Pick<NsjailExecutionRunner, "execute">, roles: RepairRoleVerifier, owner: string, config: RepairRuntimeConfig): Promise<boolean> {
  const job = await outbox.claimRequested(owner);
  if (!job) return false;
  try {
    if (!job.commands.length) throw new Error("REPAIR_PLAN_MISSING");
    await runApprovedRepair(repair, workspace, executor, roles, job.taskId, owner, job.commands, config);
    await outbox.acknowledgeRequested(job.outboxId, owner);
  } catch (error) {
    const message = error instanceof Error ? error.message : "REPAIR_EXECUTION_FAILED";
    const retryDelay = RETRY_DELAYS_MS[job.attempts - 1];
    await outbox.failRequested(job.outboxId, owner, { code: message.startsWith("REPAIR_") ? message : "REPAIR_EXECUTION_FAILED", message: message.startsWith("REPAIR_") ? message : "Repair execution failed" }, retryDelay ? new Date(Date.now() + retryDelay) : null);
  }
  return true;
}

export async function runRepairWorker(outbox: RepairOutboxStore, repair: RepairStore, workspace: RepairWorkspace, executor: Pick<NsjailExecutionRunner, "execute">, roles: RepairRoleVerifier, owner: string, config: RepairRuntimeConfig, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const claimed = await runRepairWorkerOnce(outbox, repair, workspace, executor, roles, owner, config);
    if (!claimed) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
