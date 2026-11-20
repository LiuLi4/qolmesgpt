import type { ExecutionResult } from "@qolmesgpt/security";

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
