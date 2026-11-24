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
