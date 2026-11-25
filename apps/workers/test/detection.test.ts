import assert from "node:assert/strict";
import test from "node:test";
import { consumeShard } from "../dist/sls-consumer/consume.js";
import { runSlsSource } from "../dist/sls-consumer/worker.js";

test("acknowledges a batch only after persistence and replays after failure", async () => {
  const calls: string[] = [];
  const batch = {
    nextCursor: "next",
    logGroupCount: 1,
    logs: [{ sourcePositionKey: "source:1", record: { __time__: 100, level: 50 } }],
  };
  const protocol = {
    pullLogs: async (_shard: number, cursor: string, count: number) => {
      assert.equal(cursor, "start");
      assert.equal(count, 1);
      calls.push("pull");
      return batch;
    },
    updateCheckpoint: async (_shard: number, cursor: string) => {
      assert.equal(cursor, "next");
      calls.push("checkpoint");
    },
  };
  await assert.rejects(consumeShard(protocol, 0, "start", async () => {
    calls.push("failed persistence");
    throw new Error("database unavailable");
  }), /database unavailable/);
  assert.deepEqual(calls, ["pull", "failed persistence"]);
  await consumeShard(protocol, 0, "start", async (logs) => {
    assert.deepEqual(logs, batch.logs);
    calls.push("committed");
  });
  assert.deepEqual(calls, ["pull", "failed persistence", "pull", "committed", "checkpoint"]);
});

test("normal logs are classified before advancing the SLS checkpoint", async () => {
  const calls: string[] = [];
  const result = await consumeShard({
    pullLogs: async () => ({
      nextCursor: "next", logGroupCount: 1,
      logs: [{ sourcePositionKey: "normal", record: { __time__: 100, level: 30, msg: "request completed" } }],
    }),
    updateCheckpoint: async () => { calls.push("checkpoint"); },
  }, 0, "start", async () => { calls.push("persist"); });
  assert.equal(result.cursor, "next");
  assert.deepEqual(calls, ["persist", "checkpoint"]);
});

test("source worker recovers a checkpoint, processes a batch, and reports health", async () => {
  const controller = new AbortController();
  const states: string[] = [];
  const calls: string[] = [];
  const source = {
    id: "source-1", revision: 1, enabledAt: new Date("2026-11-20T00:00:00Z"), projectId: "project-1",
    endpoint: "https://cn-shanghai.log.aliyuncs.com", project: "telemetry", logstore: "staging",
    accessKeyId: "id", accessKeySecret: "secret",
  };
  const store = {
    listEnabled: async () => [source],
    claim: async () => true,
    renew: async () => true,
    release: async () => { states.push("STOPPED"); },
    persist: async (_source: typeof source, logs: readonly unknown[]) => {
      assert.equal(logs.length, 1);
      calls.push("persist");
      controller.abort();
      return 1;
    },
    setState: async (_id: string, _group: string, _worker: string, status: string) => {
      states.push(status);
    },
  };
  const protocol = {
    ensureConsumerGroup: async () => { calls.push("group"); },
    heartbeat: async () => [0],
    getCheckpoints: async () => [{ shard: 0, checkpoint: "saved" }],
    getCursor: async (_shard: number, from: string) => {
      assert.equal(from, "end");
      return "end";
    },
    pullLogs: async (_shard: number, cursor: string, count: number) => {
      assert.equal(cursor, "saved");
      assert.equal(count, 1);
      calls.push("pull");
      return { nextCursor: "next", logGroupCount: 1, logs: [{ sourcePositionKey: "p", record: { __time__: 100, level: 50 } }] };
    },
    updateCheckpoint: async (_shard: number, cursor: string) => {
      assert.equal(cursor, "next");
      calls.push("checkpoint");
    },
  };
  await runSlsSource(source, store, "worker-1", controller.signal, () => protocol);
  assert.deepEqual(calls, ["group", "pull", "persist", "checkpoint"]);
  assert.deepEqual(states, ["STARTING", "RUNNING", "STOPPED"]);
});

test("source worker checks its lease immediately before pulling logs", async () => {
  const controller = new AbortController();
  let renewals = 0;
  let pulls = 0;
  const source = {
    id: "source-paused", revision: 1, enabledAt: new Date(), projectId: "project-1",
    endpoint: "https://cn-shanghai.log.aliyuncs.com", project: "telemetry", logstore: "staging",
    accessKeyId: "id", accessKeySecret: "secret",
  };
  const store = {
    listEnabled: async () => [source], claim: async () => true,
    renew: async () => ++renewals === 1,
    release: async () => {}, persist: async () => { assert.fail("paused source must not persist"); },
    setState: async (_id: string, _group: string, _owner: string, status: string) => { if (status === "DEGRADED") controller.abort(); },
  };
  const protocol = {
    ensureConsumerGroup: async () => {}, heartbeat: async () => [0],
    getCheckpoints: async () => [{ shard: 0, checkpoint: "saved" }], getCursor: async () => "end",
    pullLogs: async () => { pulls++; return { nextCursor: "next", logGroupCount: 0, logs: [] }; },
    updateCheckpoint: async () => { assert.fail("paused source must not acknowledge"); },
  };
  await runSlsSource(source, store, "worker-paused", controller.signal, () => protocol);
  assert.equal(renewals, 2);
  assert.equal(pulls, 0);
});

test("source worker retries a failed pull without acknowledging the failed batch", async () => {
  const controller = new AbortController();
  const states: string[] = [];
  const cursors: string[] = [];
  let attempts = 0;
  const source = {
    id: "source-2", revision: 1, enabledAt: new Date("2026-11-20T00:00:00Z"), projectId: "project-2",
    endpoint: "https://cn-shanghai.log.aliyuncs.com", project: "telemetry", logstore: "staging",
    accessKeyId: "id", accessKeySecret: "secret",
  };
  const store = {
    listEnabled: async () => [source],
    claim: async () => true,
    renew: async () => true,
    release: async () => { states.push("STOPPED"); },
    persist: async () => { controller.abort(); return 1; },
    setState: async (_id: string, _group: string, _worker: string, status: string, _shards: readonly number[], summary: Record<string, unknown>) => {
      states.push(status);
      if (status === "DEGRADED") {
        assert.equal(summary.errorCode, "CONSUMER_OPERATION_FAILED");
        assert.equal(typeof summary.retryAt, "string");
      }
    },
  };
  const protocol = {
    ensureConsumerGroup: async () => {},
    heartbeat: async () => [0],
    getCheckpoints: async () => [{ shard: 0, checkpoint: "saved" }],
    getCursor: async () => "end",
    pullLogs: async (_shard: number, cursor: string) => {
      cursors.push(cursor);
      attempts++;
      if (attempts === 1) throw new Error("temporary SLS outage");
      return { nextCursor: "next", logGroupCount: 1, logs: [{ sourcePositionKey: "p", record: { __time__: 100, level: 50 } }] };
    },
    updateCheckpoint: async (_shard: number, cursor: string) => { assert.equal(cursor, "next"); },
  };
  await runSlsSource(source, store, "worker-2", controller.signal, () => protocol);
  assert.deepEqual(cursors, ["saved", "saved"]);
  assert.deepEqual(states, ["STARTING", "RUNNING", "DEGRADED", "STARTING", "RUNNING", "STOPPED"]);
});

test("an uncheckpointed shard retries from its fixed enablement time", async () => {
  const controller = new AbortController();
  const fromValues: number[] = [];
  const cursors: string[] = [];
  let attempts = 0;
  let restarts = 0;
  const source = {
    id: "source-3", revision: 1, enabledAt: new Date("2026-11-20T00:00:00Z"), projectId: "project-3",
    endpoint: "https://cn-shanghai.log.aliyuncs.com", project: "telemetry", logstore: "staging",
    accessKeyId: "id", accessKeySecret: "secret",
  };
  const store = {
    listEnabled: async () => [source],
    claim: async () => true,
    renew: async () => true,
    release: async () => {},
    persist: async () => {
      attempts++;
      if (attempts === 1) throw new Error("database unavailable");
      controller.abort();
      return 1;
    },
    setState: async () => {},
  };
  const protocol = {
    ensureConsumerGroup: async () => {},
    heartbeat: async () => [0],
    getCheckpoints: async () => [],
    getCursor: async (_shard: number, from: number) => {
      fromValues.push(from);
      return "initial";
    },
    pullLogs: async (_shard: number, cursor: string) => {
      cursors.push(cursor);
      return { nextCursor: "next", logGroupCount: 1, logs: [{ sourcePositionKey: "p", record: { __time__: 100, level: 50 } }] };
    },
    updateCheckpoint: async () => {},
  };
  await runSlsSource(source, store, "worker-3", controller.signal, () => {
    restarts++;
    if (restarts > 3) {
      controller.abort();
      throw new Error(`unexpected retry: attempts=${attempts}, cursors=${cursors.join(",")}, from=${fromValues.join(",")}`);
    }
    return protocol;
  });
  assert.equal(restarts, 2);
  assert.deepEqual(fromValues.filter((value) => typeof value === "number"), [1795132800, 1795132800]);
  assert.deepEqual(cursors, ["initial", "initial"]);
});
