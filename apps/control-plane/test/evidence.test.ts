import assert from "node:assert/strict";
import test from "node:test";
import { packInvestigationEvidence } from "../dist/investigation/evidence.js";

test("evidence packing preserves diagnostic types, stable IDs, chronology and explicit omissions", () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ eventId: `c${i}`, traceId: `r${i}`, timestamp: "2026-11-24T10:00:00Z", log: { msg: "request completed", status: 502, noise: "n".repeat(6000) } }));
  const causal = { eventId: "cause", traceId: "r0", timestamp: "2026-11-24T10:00:00Z", log: { content: JSON.stringify({ msg: "上游异常", errorCode: "C0001", time: 1795514399990 }) } };
  const values = [...rows, causal, causal];
  const packed = packInvestigationEvidence(values, 4000);
  assert.ok(JSON.stringify(packed.records).length <= 4000);
  assert.ok(packed.records.some((r) => r.evidenceId === "cause"));
  assert.equal(packed.coverage.duplicateLogs, 1);
  assert.ok(packed.coverage.omittedLogs > 0);
  assert.ok(packed.coverage.omittedTypes.some((t) => t.message === "request completed"));
  assert.equal(packed.records.filter((r) => r.evidenceId === "cause").length, 1);
  assert.match(JSON.stringify(packed.records), /C0001/);
  assert.deepEqual(packed, packInvestigationEvidence(values, 4000));
});
