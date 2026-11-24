import assert from "node:assert/strict";
import test from "node:test";
import { runApprovedRepair, runRepairWorkerOnce } from "../dist/repair/worker.js";

test("repair worker requires approval, fencing and records bounded command results", async () => {
  const events: string[] = [];
  let status: "AWAITING_APPROVAL" | "REPAIRING" = "AWAITING_APPROVAL";
  const store = {
    async authorize() { return { taskId: "task", projectId: "project", workspacePath: process.cwd(), taskStatus: status, approvalId: "approval", approverUserId: "user", gitLabConnectionId: "connection", groupId: "group" }; },
    async start() { events.push("start"); status = "REPAIRING"; return { repairRunId: "run", fencingToken: 1n }; },
    async setTaskStatus(_task: string, next: "FAILED") { events.push(next); },
    async finish(_run: string, status: "TESTS_PASSED" | "FAILED") { events.push(status); },
  };
  const workspace = {
    async acquireLock() { events.push("lock"); return { projectId: "project", owner: "worker", fencingToken: 1n }; },
    async assertLease() { events.push("fence"); },
    async releaseLock() { events.push("unlock"); },
  };
  const roles = { async getApprovalRole() { events.push("role"); return { role: "DEVELOPER", eligible: true }; } };
  const executor = { async execute() { events.push("execute"); return { command: "/usr/bin/node", args: [], exitCode: 0, stdout: "ok", stderr: "", timedOut: false }; } };
  await runApprovedRepair(store, workspace, executor, roles, "task", "worker", [{ command: "/usr/bin/node", args: ["-e", "process.stdout.write('ok')"] }], { workspaceRoot: "/workspaces", jailRoot: "/srv/qolmesgpt/repair-rootfs" });
  assert.deepEqual(events, ["role", "lock", "start", "role", "fence", "execute", "fence", "TESTS_PASSED", "unlock"]);
});

test("repair outbox dispatcher rejects missing structured commands and retries", async () => {
  const events: string[] = [];
  let calls = 0;
  const outbox = {
    async claimRequested() { calls++; return calls === 1 ? { outboxId: "outbox", taskId: "task", owner: "worker", attempts: 1, commands: [] } : null; },
    async acknowledgeRequested() { events.push("ack"); },
    async failRequested(_id: string, _owner: string, error: { code: string }, retryAt: Date | null) { events.push(`${error.code}:${retryAt ? "retry" : "final"}`); },
  };
  const repair = { authorize: async () => null, start: async () => { throw new Error("unexpected"); }, setTaskStatus: async () => {}, finish: async () => {} };
  assert.equal(await runRepairWorkerOnce(outbox, repair, {} as never, {} as never, {} as never, "worker", { workspaceRoot: "/workspaces", jailRoot: "/jail" }), true);
  assert.deepEqual(events, ["REPAIR_PLAN_MISSING:retry"]);
});
