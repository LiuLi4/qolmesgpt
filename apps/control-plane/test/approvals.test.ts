import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalRoutes } from "../dist/routes/approvals.js";

test("approval requires a live eligible GitLab Group role and allows one approval", async () => {
  let approved = false;
  const routes = new ApprovalRoutes({
    async findTask() { return { taskId: "task", projectId: "project", groupId: "group", gitLabConnectionId: "connection", status: "AWAITING_APPROVAL" as const }; },
    async findDecision() { return approved ? { id: "approval", taskId: "task", approverUserId: "user", role: "DEVELOPER" as const, decision: "APPROVED" as const, approvedAt: new Date().toISOString(), roleCheckedAt: new Date().toISOString() } : null; },
    async createApproval(input) { approved = true; return { ...input, id: "approval", approvedAt: new Date().toISOString() }; },
  }, { async getApprovalRole() { return { role: "DEVELOPER" as const, eligible: true, checkedAt: new Date().toISOString() }; } });
  assert.equal((await routes.approve("user", "task")).role, "DEVELOPER");
  await assert.rejects(routes.approve("user", "task"), /already has/);
});

test("ineligible or non-approved tasks are rejected", async () => {
  const routes = new ApprovalRoutes({
    async findTask() { return { taskId: "task", projectId: "project", groupId: "group", gitLabConnectionId: "connection", status: "AWAITING_APPROVAL" as const }; },
    async findDecision() { return null; },
    async createApproval() { throw new Error("unexpected"); },
  }, { async getApprovalRole() { return { role: "REPORTER" as const, eligible: false, checkedAt: new Date().toISOString() }; } });
  await assert.rejects(routes.approve("user", "task"), /cannot approve/);
});
