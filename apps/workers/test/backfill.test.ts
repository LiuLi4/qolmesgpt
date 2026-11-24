import assert from "node:assert/strict";
import test from "node:test";
import { backfillSls } from "../dist/sls-consumer/backfill.js";

test("historical replay uses stable single-group positions, bounds the interval, and never changes live checkpoints", async () => {
  const persisted: string[] = [];
  let pulls = 0;
  const result = await backfillSls({
    listShards: async () => [0],
    getCursor: async (_shard: number, time: number) => time === 100 ? "start" : "end",
    readLogs: async (_shard: number, cursor: string, count: number) => {
      assert.equal(count, 1); pulls++;
      return { nextCursor: "end", logGroupCount: 1, logs: [
        { sourcePositionKey: `${cursor}:0`, record: { __time__: 100, level: 50 } },
        { sourcePositionKey: `${cursor}:1`, record: { __time__: 200, level: 50 } },
      ] };
    },
  }, new Date(100000), new Date(200000), async (logs) => {
    persisted.push(...logs.map((log) => log.sourcePositionKey)); return logs.length;
  });
  assert.deepEqual(persisted, ["start:0"]);
  assert.equal(result.created, 1);
  assert.equal(result.scanned, 1);
  assert.equal(pulls, 1);
});

test("historical replay reports stalled cursors and rejects unbounded ranges", async () => {
  const protocol = { listShards: async () => [0], getCursor: async (_shard: number, time: number) => String(time), readLogs: async () => ({ nextCursor: "100", logGroupCount: 0, logs: [] }) };
  await assert.rejects(backfillSls(protocol, new Date(100000), new Date(200000), async () => 0), /stalled/);
  await assert.rejects(backfillSls(protocol, new Date(0), new Date(90000000), async () => 0), /24 hours/);
});


test("historical replay continues beyond the page budget without skipping another shard", async () => {
  const persisted = new Set<string>();
  const protocol = {
    listShards: async () => [0, 1],
    getCursor: async (_shard: number, time: number) => time === 100 ? "0" : "101",
    readLogs: async (shard: number, cursor: string) => ({ nextCursor: String(Number(cursor) + 1), logGroupCount: 1, logs: [{ sourcePositionKey: `${shard}:${cursor}`, record: { __time__: 150 } }] }),
  };
  const persist = async (logs: readonly { sourcePositionKey: string }[]) => {
    let created = 0; for (const log of logs) if (!persisted.has(log.sourcePositionKey)) { persisted.add(log.sourcePositionKey); created++; } return created;
  };
  let page = await backfillSls(protocol, new Date(100000), new Date(200000), persist);
  assert.equal(page.complete, false);
  assert.deepEqual(page.cursors, { 0: "100", 1: "0" });
  while (!page.complete) page = await backfillSls(protocol, new Date(100000), new Date(200000), persist, page.cursors);
  assert.equal(persisted.size, 202);
  const replay = await backfillSls(protocol, new Date(100000), new Date(200000), persist);
  assert.equal(replay.created, 0);
});
