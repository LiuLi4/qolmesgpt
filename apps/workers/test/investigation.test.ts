import assert from "node:assert/strict";
import test from "node:test";
import { HttpHolmesClient, type InvestigationJob } from "../dist/investigation/client.js";
import { runInvestigationOnce } from "../dist/investigation/worker.js";

const job: InvestigationJob = {
  evidenceVersion: 1, relatedLogs: [], outboxId: "outbox-1", taskId: "task-1", projectId: "project-1", errorEventId: "event-1",
  errorEvidence: { level: 50, msg: "database timeout" }, projectPath: "group/project", workspacePath: "workspaces/project", attempts: 1,
};

test("Holmes client requests bounded structured investigation output", async () => {
  let request: RequestInit | undefined;
  const client = new HttpHolmesClient("https://holmes.example.test", "api-key", async (_input, init) => {
    request = init;
    return new Response(JSON.stringify({ analysis: JSON.stringify({ summary: "Pool exhausted", rootCause: "Connection pool timeout", codeContext: ["src/db.ts:42"], proposedFix: "Increase pool timeout", confidence: "medium" }) }), { status: 200 });
  });
  const result = await client.investigate(job);
  assert.equal(result.confidence, "medium");
  assert.equal((request?.headers as Record<string, string>)["x-api-key"], "api-key");
  assert.match(String(request?.body), /database timeout/);
  assert.match(String(request?.body), /response_format/);
});

test("investigation worker retries transient Holmes failures and finally marks failure", async () => {
  const events: string[] = [];
  let attempts = 0;
  const store = {
    claim: async () => attempts++ < 3 ? { ...job, attempts } : null,
    complete: async () => { events.push("complete"); },
    fail: async (_id: string, _owner: string, error: { code: string }, retryAt: Date | null) => { events.push(`fail:${error.code}:${retryAt ? "retry" : "final"}`); },
  };
  const client = { investigate: async () => { throw new Error("HOLMES_HTTP_503"); } };
  await runInvestigationOnce(store, client, "worker");
  await runInvestigationOnce(store, client, "worker");
  await runInvestigationOnce(store, client, "worker");
  assert.deepEqual(events, ["fail:HOLMES_HTTP_503:retry", "fail:HOLMES_HTTP_503:retry", "fail:HOLMES_HTTP_503:final"]);
});


test("worker completes the claimed evidence version and client refuses empty conclusions", async () => {
  const result = { summary: "s", rootCause: "r", codeContext: [], proposedFix: "p", confidence: "low" as const };
  let completedVersion = 0;
  await runInvestigationOnce({ claim: async () => ({ ...job, evidenceVersion: 7 }), complete: async (_id, _owner, _result, version) => { completedVersion = version; }, fail: async () => { assert.fail("unexpected failure"); } }, { investigate: async () => result }, "worker");
  assert.equal(completedVersion, 7);
  const client = new HttpHolmesClient("https://holmes.example.test", undefined, async (_url, init) => {
    assert.ok(init?.signal);
    const body = JSON.parse(String(init?.body));
    assert.ok(body.response_format.json_schema.schema.required.includes("affectedProjectIds"));
    return new Response(JSON.stringify({ analysis: JSON.stringify({ ...result, rootCause: "" }) }));
  });
  await assert.rejects(client.investigate(job), /HOLMES_INCOMPLETE_RESULT/);
});

test("paused investigations defer without calling the model or consuming a retry", async () => {
  let deferred = 0;
  const store = { claim: async () => job, isAutomationEnabled: async () => false,
    defer: async () => { deferred++; }, complete: async () => { assert.fail("paused result must not complete"); }, fail: async () => { assert.fail("pause must not become a failure"); } };
  await runInvestigationOnce(store, { investigate: async () => { assert.fail("paused job must not call the model"); } }, "worker");
  assert.equal(deferred, 1);
});

test("a pause after model execution discards the result and preserves the queued job", async () => {
  let enabled = true; let deferred = false;
  const store = { claim: async () => job, isAutomationEnabled: async () => enabled,
    defer: async () => { deferred = true; }, complete: async () => { assert.fail("paused result must not complete"); }, fail: async () => { assert.fail("pause must not become a failure"); } };
  await runInvestigationOnce(store, { investigate: async () => { enabled = false; return { summary: "s", rootCause: "r", codeContext: [], proposedFix: "p", confidence: "low" }; } }, "worker");
  assert.equal(deferred, true);
});

test("Holmes HTTP requests propagate an external cancellation signal", async () => {
  const controller = new AbortController();
  const client = new HttpHolmesClient("https://holmes.example.test", undefined, async (_url, init) => {
    controller.abort();
    assert.equal(init?.signal?.aborted, true);
    init?.signal?.throwIfAborted();
    throw new Error("unreachable");
  });
  await assert.rejects(client.investigate(job, controller.signal), { name: "AbortError" });
});

test("investigation input preserves causal logs after repetitive completion records exceed the budget", async () => {
  let ask = "";
  const logs = Array.from({ length: 48 }, (_, i) => ({ eventId: `completion-${i}`, traceId: `trace-${i}`, timestamp: new Date(1795500000000 + i * 1000).toISOString(), log: { msg: "request completed", status: 502, method: "POST", padding: "x".repeat(2500) } }));
  for (let i = 0; i < 9; i++) {
    logs.push({ eventId: `upstream-${i}`, traceId: `trace-${i}`, timestamp: new Date(1795499999900 + i * 1000).toISOString(), log: { msg: "金融商响应异常 C0001", status: 503, method: "POST", padding: "" } });
    logs.push({ eventId: `handler-${i}`, traceId: `trace-${i}`, timestamp: new Date(1795499999950 + i * 1000).toISOString(), log: { msg: "finance user-auth 上游异常", status: 503, method: "POST", padding: "" } });
  }
  const client = new HttpHolmesClient("https://holmes.example.test", undefined, async (_url, init) => {
    ask = JSON.parse(String(init?.body)).ask;
    return new Response(JSON.stringify({ analysis: { summary: "s", rootCause: "r", proposedFix: "p", codeContext: [], confidence: "low", affectedProjectIds: [] } }));
  });
  const result = await client.investigate({ ...job, relatedLogs: logs });
  assert.match(ask, /金融商响应异常 C0001/);
  assert.match(ask, /finance user-auth 上游异常/);
  assert.match(JSON.stringify(result.evidence), /upstream-0/);
  assert.match(ask, /same symptom does not establish the same root cause/);
  assert.ok(result.evidence?.selection?.omittedLogs !== undefined);
  assert.ok(JSON.stringify(result.evidence?.relatedLogs).length <= 60_000);
  const payload = result.evidence?.relatedLogs as { timestamp: string; requestKey: string; log: { msg: string } }[];
  assert.equal(payload.filter((r) => r.log.msg.includes("上游异常")).length, 9);
  const firstRequest = payload.filter((r) => r.requestKey === "trace:trace-0");
  assert.deepEqual(firstRequest.map((r) => r.log.msg), ["金融商响应异常 C0001", "finance user-auth 上游异常", "request completed"]);
});


test("actual repository versions and incomplete evidence are server generated and survive model output", async () => {
  let ask = "";
  const versions = [{ projectId: "allowed", projectPath: "g/api", branch: "dev", commitSha: "a".repeat(40), readAt: new Date().toISOString(), status: "READ" as const }, { projectId: "failed", projectPath: "other/api", branch: "staging", commitSha: null, readAt: new Date().toISOString(), status: "FAILED" as const, errorCode: "REPOSITORY_READ_FAILED" }];
  const client = new HttpHolmesClient("https://holmes.example.test", undefined, async (_url, init) => {
    ask = JSON.parse(String(init?.body)).ask;
    return new Response(JSON.stringify({ analysis: { summary: "s", rootCause: "r", codeContext: [], proposedFix: "p", confidence: "low", affectedProjectIds: ["allowed", "failed", "invented"] } }));
  });
  const result = await client.investigate({ ...job, repositoryVersions: versions });
  assert.deepEqual(result.evidence?.repositoryVersions, versions);
  assert.equal(result.evidence?.codeEvidenceIncomplete, true);
  assert.match(result.evidence?.versionNotice ?? "", /当前按所选分支分析/);
  assert.match(ask, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.deepEqual(result.affectedProjectIds, ["allowed"]);
});

test("model-facing repository provenance is bounded while full versions remain in task evidence", async () => {
  let requestBytes = 0;
  const versions = Array.from({ length: 100_000 }, (_, index) => ({
    projectId: `project-${index}`, projectPath: `group/project-${index}`, branch: "dev", commitSha: null,
    readAt: new Date().toISOString(), status: "FAILED" as const, errorCode: "REPOSITORY_BUDGET_EXCEEDED",
  }));
  const client = new HttpHolmesClient("https://holmes.example.test", undefined, async (_url, init) => {
    requestBytes = Buffer.byteLength(String(init?.body));
    const ask = JSON.parse(String(init?.body)).ask as string;
    assert.match(ask, /omittedRepositoryVersions/);
    assert.match(ask, /100000/);
    return new Response(JSON.stringify({ analysis: { summary: "s", rootCause: "r", proposedFix: "p", codeContext: [], confidence: "low", affectedProjectIds: [] } }));
  });
  const result = await client.investigate({ ...job, repositoryVersions: versions });
  assert.equal(result.evidence?.repositoryVersions?.length, 100_000);
  assert.ok(requestBytes < 500_000, `model request unexpectedly large: ${requestBytes}`);
});


test("legacy project investigations preserve model attribution without fabricated version records", async () => {
  const client = new HttpHolmesClient("https://holmes.example.test", undefined, async () => new Response(JSON.stringify({ analysis: { summary: "s", rootCause: "r", proposedFix: "p", codeContext: ["handler.ts:1"], confidence: "low", affectedProjectIds: [job.projectId] } })));
  const result = await client.investigate(job);
  assert.deepEqual(result.affectedProjectIds, [job.projectId]);
  assert.equal(result.evidence?.repositoryVersions, undefined);
});
