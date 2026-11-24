import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { isolatedDatabase } from "./database-fixture.ts";
import { PrismaApprovalStore } from "../dist/approvals/prisma.js";
import { PrismaWorkspaceLeaseManager } from "../dist/approvals/workspace-lease.js";

test("approval and repair outbox are atomic, single-decision, and workspace locks are fenced", { skip: !process.env.DATABASE_URL }, async () => {
  const database = await isolatedDatabase(process.env.DATABASE_URL!);
  const { prisma } = database;
  const user = await prisma.user.create({ data: { authSubject: `approval-test-${randomUUID()}` } });
  try {
    const connection = await prisma.gitLabConnection.create({ data: { userId: user.id, instanceUrl: "https://gitlab.example.test", authType: "PAT", accessTokenCiphertext: "fixture", credentialKeyVersion: "v1" } });
    const group = await prisma.gitLabGroup.create({ data: { connectionId: connection.id, externalGroupId: randomUUID(), fullPath: "test/approvals" } });
    const project = await prisma.project.create({ data: { connectionId: connection.id, groupId: group.id, externalProjectId: randomUUID(), pathWithNamespace: "test/approvals/project", defaultBranch: "main", createdByUserId: user.id } });
    const source = await prisma.dataSourceConnection.create({ data: { projectId: project.id, type: "ALIYUN_SLS", configJson: {}, credentialsCiphertext: "fixture", credentialKeyVersion: "v1" } });
    const event = await prisma.errorEvent.create({ data: { dataSourceConnectionId: source.id, sourcePositionKey: randomUUID(), sourceTimestamp: new Date(), logEvidenceJson: { msg: "test error" }, fingerprint: randomUUID() } });
    const task = await prisma.investigationTask.create({ data: { projectId: project.id, errorEventId: event.id, status: "AWAITING_APPROVAL" } });
    await prisma.projectWorkspace.create({ data: { projectId: project.id, relativePath: `workspaces/${project.id}`, branch: "main", status: "READY" } });

    const approvals = new PrismaApprovalStore(prisma);
    const approved = await approvals.createApproval({ taskId: task.id, approverUserId: user.id, role: "DEVELOPER", decision: "APPROVED", roleCheckedAt: new Date().toISOString() });
    assert.equal(approved.decision, "APPROVED");
    assert.equal(await prisma.outboxMessage.count({ where: { aggregateId: task.id, eventType: "RepairRequested" } }), 1);
    await assert.rejects(approvals.createApproval({ taskId: task.id, approverUserId: user.id, role: "OWNER", decision: "APPROVED", roleCheckedAt: new Date().toISOString() }), /already has a decision/);
    assert.equal(await prisma.outboxMessage.count({ where: { aggregateId: task.id, eventType: "RepairRequested" } }), 1);

    const locks = new PrismaWorkspaceLeaseManager(prisma);
    const lease = await locks.acquireLock(project.id, "repair-a");
    await assert.rejects(locks.acquireLock(project.id, "repair-b"), /occupied/);
    await locks.assertLease(lease);
    await locks.releaseLock(lease);
    const next = await locks.acquireLock(project.id, "repair-b");
    assert.ok(next.fencingToken > lease.fencingToken);
    await assert.rejects(locks.assertLease(lease), /fencing lease/);
    await locks.releaseLock(next);
  } finally {
    await prisma.project.deleteMany({ where: { createdByUserId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await database.close();
  }
});
