import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { AliyunSlsConsumerProtocol, type SlsConsumerConfig } from "../src/sls-consumer/protocol.ts";

const config: SlsConsumerConfig = {
  endpoint: "https://cn-shanghai.log.aliyuncs.com",
  project: "telemetry",
  logstore: "application",
  consumerGroup: "qolmesgpt-staging",
  consumerId: "worker-1",
  accessKeyId: "test-key-id",
  accessKeySecret: "test-key-secret",
};

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0x7f) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

function field(number: number, value: Buffer): Buffer {
  return Buffer.concat([encodeVarint((number << 3) | 2), encodeVarint(value.length), value]);
}

function logContent(key: string, value: string): Buffer {
  return Buffer.concat([field(1, Buffer.from(key)), field(2, Buffer.from(value))]);
}

function logRecord(time: number, fields: Record<string, string>): Buffer {
  const contents = Object.entries(fields).map(([key, value]) => field(2, logContent(key, value)));
  return Buffer.concat([encodeVarint(8), encodeVarint(time), ...contents]);
}

function logGroupListFixture(): Buffer {
  const log = logRecord(1794818108, { level: "50", msg: "database connection failed" });
  const group = field(1, log);
  return field(1, group);
}

function response(body: BodyInit | null = null, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers });
}

test("signs requests with SLS HMAC-SHA1 canonical headers and resource", async () => {
  let captured: Request | undefined;
  const protocol = new AliyunSlsConsumerProtocol(config, async (input, init) => {
    captured = new Request(input, init);
    return response("[]");
  });

  await protocol.listShards();

  assert.ok(captured);
  const date = captured.headers.get("date");
  const contentType = captured.headers.get("content-type") ?? "";
  const canonical = `GET\n\n${contentType}\n${date}\nx-log-apiversion:0.6.0\nx-log-signaturemethod:hmac-sha1\n/logstores/application/shards`;
  const signature = createHmac("sha1", config.accessKeySecret).update(canonical).digest("base64");
  assert.equal(captured.headers.get("authorization"), `LOG ${config.accessKeyId}:${signature}`);
  assert.equal(new URL(captured.url).hostname, "telemetry.cn-shanghai.log.aliyuncs.com");
});

test("ensures a group once, receives shard assignment, decodes logs and guards checkpoints", async () => {
  const calls: Array<{ path: string; body: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = await request.text();
    calls.push({ path: `${url.pathname}${url.search}`, body });

    if (url.pathname.endsWith("/consumergroups")) return response(JSON.stringify([{ consumerGroup: config.consumerGroup, timeout: 60, order: false }]));
    if (url.searchParams.get("type") === "heartbeat") return response("[3]");
    if (url.searchParams.get("type") === "log") {
      assert.equal(request.headers.get("accept-encoding"), "");
      return response(logGroupListFixture(), { "content-type": "application/x-protobuf", "x-log-cursor": "cursor-next", "x-log-count": "1" });
    }
    if (url.searchParams.get("type") === "checkpoint") return response("");
    return response("[]");
  };
  const protocol = new AliyunSlsConsumerProtocol(config, fetcher);

  await protocol.ensureConsumerGroup();
  assert.deepEqual(await protocol.heartbeat([1, 2]), [3]);
  const batch = await protocol.pullLogs(3, "cursor-start", 20);
  assert.equal(batch.nextCursor, "cursor-next");
  assert.equal(batch.logs.length, 1);
  assert.equal(batch.logs[0]?.record.level, "50");
  assert.equal(batch.logs[0]?.record.msg, "database connection failed");
  assert.equal(batch.logs[0]?.sourcePositionKey, "shard:3:cursor:cursor-start:ordinal:0");

  await protocol.updateCheckpoint(3, batch.nextCursor);
  assert.ok(calls.some((call) => call.path.includes("type=checkpoint") && call.body.includes('"checkpoint":"cursor-next"')));
  assert.ok(calls.some((call) => call.path.includes("type=heartbeat") && call.body === "[1,2]"));
  await assert.rejects(protocol.updateCheckpoint(1, "stale-cursor"), /does not own shard/);
});

test("creates a missing group and never force-updates a checkpoint", async () => {
  const calls: Array<{ method: string; path: string; body: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = await request.text();
    calls.push({ method: request.method, path: `${url.pathname}${url.search}`, body });
    if (request.method === "GET") return response(JSON.stringify({ consumerGroups: [] }));
    if (url.searchParams.get("type") === "heartbeat") return response("[0]");
    return response("");
  };
  const protocol = new AliyunSlsConsumerProtocol(config, fetcher);

  await protocol.ensureConsumerGroup();
  await protocol.heartbeat([]);
  await protocol.updateCheckpoint(0, "cursor-committed");

  const creation = calls.find((call) => call.method === "POST" && call.path.endsWith("/consumergroups"));
  assert.ok(creation);
  assert.deepEqual(JSON.parse(creation.body), { consumerGroup: config.consumerGroup, timeout: 60, order: false });
  const checkpoint = calls.find((call) => call.path.includes("type=checkpoint"));
  assert.ok(checkpoint);
  assert.equal(new URLSearchParams(checkpoint.path.split("?")[1]).get("forceSuccess"), "false");
});

test("failed heartbeat revokes ownership until a successful retry", async () => {
  let heartbeatCount = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).searchParams.get("type") === "heartbeat") {
      heartbeatCount++;
      if (heartbeatCount === 2) throw new Error("temporary network failure");
      return response("[0]");
    }
    return response("");
  };
  const protocol = new AliyunSlsConsumerProtocol(config, fetcher);

  assert.deepEqual(await protocol.heartbeat([]), [0]);
  await assert.rejects(protocol.heartbeat([0]), /temporary network failure/);
  await assert.rejects(protocol.updateCheckpoint(0, "cursor"), /does not own shard/);
  assert.deepEqual(await protocol.heartbeat([]), [0]);
  await protocol.updateCheckpoint(0, "cursor");
});
