import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { isolatedDatabase } from "./database-fixture.ts";
import { aggregationIdentity } from "../dist/detection/aggregation.js";
import { PrismaSlsDetectionStore } from "../dist/detection/prisma.js";
import { PrismaInvestigationStore } from "../dist/investigation/prisma.js";
import { prepareInvestigation } from "../dist/investigation/context.js";
import { AliyunSlsAdapter } from "../dist/integrations/sls/adapter.js";

test("fingerprints normalize volatile values but preserve exception, status and scope", () => {
  const a = aggregationIdentity({ content: JSON.stringify({ traceId: "abc", requestId: "one", service: "api", err: { type: "Timeout", message: "Order 123 failed" } }) });
  const b = aggregationIdentity({ traceId: "def", service: "api", err: { type: "Timeout", message: "Order 456 failed" } });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.correlationKey, "trace:abc");
  assert.notEqual(a.fingerprint, aggregationIdentity({ service: "other", msg: "Order 123 failed" }).fingerprint);
  assert.equal(aggregationIdentity({ traceId: "0000", requestId: "r", service: "s" }).correlationKey, "request:s:r");
});

test("request grouping, fingerprint windows, concurrency, approvals and investigation snapshot fencing", { skip: !process.env.DATABASE_URL }, async () => {
  const db = await isolatedDatabase(process.env.DATABASE_URL!);
  const p = db.prisma;
  try {
    const user = await p.user.create({ data: { authSubject: randomUUID() } });
    const connection = await p.gitLabConnection.create({ data: { userId: user.id, instanceUrl: "https://example.test", authType: "PAT", accessTokenCiphertext: "test", credentialKeyVersion: "v1" } });
    const group = await p.gitLabGroup.create({ data: { connectionId: connection.id, externalGroupId: "1", fullPath: "group" } });
    const workspace = await p.groupWorkspace.create({ data: { groupId: group.id, relativePath: "group", status: "READY" } });
    const data = { workspaceId: workspace.id, type: "ALIYUN_SLS" as const, status: "ENABLED" as const, configJson: {}, credentialsCiphertext: "test", credentialKeyVersion: "v1" };
    const s1 = await p.dataSourceConnection.create({ data });
    const s2 = await p.dataSourceConnection.create({ data });
    const store = new PrismaSlsDetectionStore(p, { getKey: () => Buffer.alloc(32) });
    const source = { id: s1.id, workspaceId: workspace.id, projectId: null };
    const time = 1794818108;
    const log = (pos: string, traceId: string, msg: string, offset = 0) => ({ sourcePositionKey: pos, record: { __time__: time + offset, level: 50, traceId, msg } });
    assert.equal(await store.persist(source, [log("a", "trace1", "database failed 123")]), 1);
    // Different message in same trace, across a different datasource, still one request.
    assert.equal(await store.persist({ ...source, id: s2.id }, [log("b", "trace1", "request completed", 1)]), 0);
    await Promise.all([store.persist(source, [log("c", "trace2", "database failed 456", 2)]), store.persist(source, [log("d", "trace2", "database failed 789", 3)])]);
    assert.equal(await store.persist(source, [log("d", "trace2", "database failed 789", 3)]), 0);
    let task = await p.investigationTask.findFirstOrThrow({ where: { mergedIntoTaskId: null } });
    assert.equal(await p.investigationTask.count(), 1);
    assert.equal(task.occurrenceCount, 4);
    assert.equal(task.requestCount, 2);
    assert.equal(task.evidenceVersion, 4);
    assert.equal(task.firstSeenAt.getTime(), time * 1000);
    assert.equal(task.lastSeenAt.getTime(), (time + 3) * 1000);
    // Out-of-order logs preserve min/max; a different fingerprint remains separate.
    await store.persist(source, [log("e", "trace1", "earlier causal exception", -10)]);
    assert.equal(await store.persist(source, [log("f", "trace3", "different failure 999", 901)]), 1);
    task = await p.investigationTask.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(task.firstSeenAt.getTime(), (time - 10) * 1000);
    assert.equal(task.lastSeenAt.getTime(), (time + 3) * 1000);
    const investigations = new PrismaInvestigationStore(p);
    const job = await investigations.claim("tester", new Date(Date.now() + 120_000));
    assert.ok(job);
    assert.equal(job.relatedLogs.length, 5);
    await store.persist(source, [log("g", "trace1", "late exception", 4)]);
    const result = { summary: "s", rootCause: "r", codeContext: [], proposedFix: "p", confidence: "low" as const, affectedProjectIds: [] };
    await investigations.complete(job.outboxId, "tester", result, job.evidenceVersion);
    assert.equal((await p.investigationTask.findUniqueOrThrow({ where: { id: task.id } })).status, "INVESTIGATION_PENDING");
    const retry = await investigations.claim("tester", new Date(Date.now() + 120_000));
    assert.ok(retry);
    await investigations.complete(retry.outboxId, "tester", result, retry.evidenceVersion);
    assert.equal((await p.investigationTask.findUniqueOrThrow({ where: { id: task.id } })).analyzedVersion, retry.evidenceVersion);
    await p.approval.create({ data: { taskId: task.id, approverUserId: user.id, groupRoleAtApproval: "DEVELOPER", decision: "APPROVED", roleCheckedAt: new Date() } });
    assert.equal(await store.persist(source, [log("h", "trace1", "late exception", 5)]), 1);
    assert.equal((await p.investigationTask.findUniqueOrThrow({ where: { id: task.id } })).status, "AWAITING_APPROVAL");
    await assert.rejects(investigations.retry(task.id), /cannot be retried/);
    const other = await p.investigationTask.findFirstOrThrow({ where: { id: { not: task.id }, status: "INVESTIGATION_PENDING" } });
    await p.investigationTask.update({ where: { id: other.id }, data: { status: "FAILED" } });
    await investigations.retry(other.id);
    assert.equal(await p.outboxMessage.count({ where: { aggregateId: other.id, eventType: "InvestigationRequested" } }), 1);
    for (let n = 0; n < 3; n++) {
      const event = await p.errorEvent.create({ data: { dataSourceConnectionId: s1.id, sourcePositionKey: `legacy-${n}`, sourceTimestamp: new Date((time + 10_000) * 1000), logEvidenceJson: { traceId: "legacy-trace", msg: `legacy ${n}` }, fingerprint: `old-${n}` } });
      const legacy = await p.investigationTask.create({ data: { errorEventId: event.id, workspaceId: workspace.id, firstSeenAt: event.sourceTimestamp, lastSeenAt: event.sourceTimestamp } });
      await p.errorEvent.update({ where: { id: event.id }, data: { taskId: legacy.id } });
      await p.outboxMessage.create({ data: { aggregateType: "InvestigationTask", aggregateId: legacy.id, eventType: "InvestigationRequested", payload: {} } });
    }
    assert.equal(await store.reconcilePending(), 2);
    assert.equal(await p.investigationTask.count({ where: { mergedIntoTaskId: { not: null } } }), 2);
    const legacy = await p.investigationTask.findFirstOrThrow({ where: { mergedIntoTaskId: null, events: { some: { traceId: "legacy-trace" } } } });
    assert.equal(legacy.occurrenceCount, 3);
    assert.equal(legacy.requestCount, 1);
  } finally { await db.close(); }
});


test("unresolved fingerprints persist across time gaps and historical unapproved duplicates merge without losing evidence", { skip: !process.env.DATABASE_URL }, async () => {
  const db = await isolatedDatabase(process.env.DATABASE_URL!);
  const p = db.prisma;
  try {
    const user = await p.user.create({ data: { authSubject: randomUUID() } });
    const connection = await p.gitLabConnection.create({ data: { userId: user.id, instanceUrl: "https://example.test", authType: "PAT", accessTokenCiphertext: "test", credentialKeyVersion: "v1" } });
    const group = await p.gitLabGroup.create({ data: { connectionId: connection.id, externalGroupId: "1", fullPath: "group" } });
    const workspace = await p.groupWorkspace.create({ data: { groupId: group.id, relativePath: "group", status: "READY" } });
    const source = await p.dataSourceConnection.create({ data: { workspaceId: workspace.id, type: "ALIYUN_SLS", status: "ENABLED", configJson: {}, credentialsCiphertext: "test", credentialKeyVersion: "v1" } });
    const store = new PrismaSlsDetectionStore(p, { getKey: () => Buffer.alloc(32) });
    const scope = { id: source.id, workspaceId: workspace.id, projectId: null };
    const time = 1795508547;
    const log = (position: string, offset: number, status = "502") => ({ sourcePositionKey: position, record: { __time__: time + offset, service: "ec-saas", component: "domain", level: 50, method: "POST", status, msg: "request completed", traceId: position } });
    await store.persist(scope, [log("first-request", 0)]);
    const original = await p.investigationTask.findFirstOrThrow();
    await p.investigationTask.update({ where: { id: original.id }, data: { status: "AWAITING_APPROVAL", analyzedVersion: 1, investigationResultJson: { summary: "previous evidence" } } });
    assert.equal(await store.persist(scope, [log("new-request", 91 * 60)]), 0, "an unresolved identical fingerprint must reuse the task after 91 minutes");
    let main = await p.investigationTask.findUniqueOrThrow({ where: { id: original.id } });
    assert.equal(main.status, "INVESTIGATION_PENDING");
    assert.equal(main.occurrenceCount, 2);
    assert.equal(main.requestCount, 2);
    assert.equal(main.investigationResultJson, null);
    assert.equal(main.analyzedVersion, 0);
    assert.equal(await store.persist(scope, [log("different-status", 92 * 60, "503")]), 1);
    const historical = log("historical-duplicate", 93 * 60);
    const event = await p.errorEvent.create({ data: { dataSourceConnectionId: source.id, sourcePositionKey: historical.sourcePositionKey, sourceTimestamp: new Date(historical.record.__time__ * 1000), logEvidenceJson: historical.record, ...aggregationIdentity(historical.record) } });
    const duplicate = await p.investigationTask.create({ data: { workspaceId: workspace.id, errorEventId: event.id, status: "AWAITING_APPROVAL", firstSeenAt: event.sourceTimestamp, lastSeenAt: event.sourceTimestamp, investigationResultJson: { summary: "historical result" } } });
    await p.errorEvent.update({ where: { id: event.id }, data: { taskId: duplicate.id } });
    assert.equal(await store.reconcilePending(true), 1);
    assert.equal((await p.investigationTask.findUniqueOrThrow({ where: { id: duplicate.id } })).mergedIntoTaskId, original.id);
    assert.equal(await p.errorEvent.count({ where: { taskId: original.id } }), 3);
    main = await p.investigationTask.findUniqueOrThrow({ where: { id: original.id } });
    assert.equal(main.occurrenceCount, 3);
    assert.equal(main.lastSeenAt.getTime(), (time + 93 * 60) * 1000);
    assert.equal(await store.reconcilePending(true), 0);
    await p.approval.create({ data: { taskId: original.id, approverUserId: user.id, groupRoleAtApproval: "DEVELOPER", decision: "APPROVED", roleCheckedAt: new Date() } });
    assert.equal(await store.persist(scope, [log("after-approval", 94 * 60)]), 1);
    assert.equal((await p.investigationTask.findUniqueOrThrow({ where: { id: original.id } })).occurrenceCount, 3);
  } finally { await db.close(); }
});

test("context collection filters exact request IDs, redacts secrets and reads only bounded checkout code", async () => {
  const root = await mkdtemp(join(tmpdir(), "qolmes-context-"));
  try {
    const repo = join(root, "repo"); await mkdir(repo);
    execFileSync("git", ["init", "-q", repo]);
    await writeFile(join(repo, "handler.ts"), 'export const domain = "connection timeout";\n');
    await writeFile(join(repo, "secret.ts"), 'const domain = "private token";\n');
    execFileSync("git", ["add", "."], { cwd: repo });
    const source = { id: "s", workspaceId: "w", endpoint: "https://cn-shanghai.log.aliyuncs.com", project: "p", logstore: "l", accessKeyId: "credential-id", accessKeySecret: "credential-secret" };
    const adapter = new AliyunSlsAdapter({ create: () => ({ getProject: async () => ({}), getLogStore: async () => ({}), getLogs: async () => [
      { __time__: 1794818108, content: '{"traceId":"abc","msg":"causal exception password=customer-secret credential-secret"}' },
      { __time__: 1794818108, traceId: "unrelated", msg: "unrelated" },
    ] }) });
    const job = { outboxId: "o", taskId: "t", projectId: null, workspaceId: "w", errorEventId: "e", errorEvidence: { component: "domain" }, relatedLogs: [{ timestamp: "2026-11-16T08:35:08Z", correlationKey: "trace:abc", traceId: "abc" }], evidenceVersion: 1, projectPath: "group", workspacePath: "repo", attempts: 1, repositories: [{ id: "r", projectPath: "group/repo", workspacePath: "repo" }] };
    const prepared = await prepareInvestigation(job, { listEnabled: async () => [source] } as unknown as PrismaSlsDetectionStore, root, adapter);
    const output = JSON.stringify(prepared);
    assert.match(output, /causal exception/);
    assert.match(output, /handler.ts/);
    assert.doesNotMatch(output, /customer-secret|credential-secret|private token|unrelated|export const domain/);
    assert.match(output, /contextDiagnostics/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
