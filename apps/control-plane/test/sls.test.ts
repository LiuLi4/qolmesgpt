import assert from "node:assert/strict";
import test from "node:test";
import { AliyunSlsAdapter } from "../dist/integrations/sls/adapter.js";
import { classifySlsError } from "../dist/integrations/sls/classifier.js";
import { DataSourceRoutes } from "../dist/routes/data-sources.js";
import type { SlsClient, SlsClientFactory, SlsConfig } from "../dist/integrations/sls/types.js";

const config: SlsConfig = {
  endpoint: "https://cn-shanghai.log.aliyuncs.com",
  project: "pyxis-telemetry-log",
  logstore: "pyxis-trace-staging",
  accessKeyId: "access-key",
  accessKeySecret: "secret",
};

class FakeSlsClient implements SlsClient {
  mode: "ok" | "empty" | "fail" = "ok";
  readonly calls: Array<{ project: string; logstore: string; query: Record<string, string | number | boolean> }> = [];

  async getProject() {
    if (this.mode === "fail") throw Object.assign(new Error("project not found"), { code: "ProjectNotFound" });
    return { name: "pyxis-telemetry-log" };
  }

  async getLogStore() {
    if (this.mode === "fail") throw Object.assign(new Error("logstore not found"), { code: "LogStoreNotFound" });
    return { name: "pyxis-trace-staging" };
  }

  async getLogs(project: string, logstore: string, _from: Date, _to: Date, query: Record<string, string | number | boolean>) {
    this.calls.push({ project, logstore, query });
    if (this.mode === "fail") throw Object.assign(new Error("unauthorized"), { code: "Unauthorized" });
    return this.mode === "empty" ? { logs: [] } : { logs: [{ level: 50, msg: "database error" }] };
  }
}

function factory(client: FakeSlsClient): SlsClientFactory {
  return { create: () => client };
}

test("default SLS classifier handles structured error signals", () => {
  assert.deepEqual(classifySlsError({ level: 50 }), { isError: true, reason: "level" });
  assert.deepEqual(classifySlsError({ status: 503 }), { isError: true, reason: "status" });
  assert.deepEqual(classifySlsError({ msg: "request failed" }), { isError: true, reason: "keyword" });
  assert.deepEqual(classifySlsError({ msg: "request timeout" }), { isError: true, reason: "keyword" });
  assert.deepEqual(classifySlsError({ content: '{"level":50,"msg":"bad request"}' }), { isError: true, reason: "level" });
  assert.deepEqual(classifySlsError({ content: '{"status":503,"msg":"request completed"}' }), { isError: true, reason: "status" });
  assert.deepEqual(classifySlsError({ content: '{"level":30,"status":200,"msg":"request completed","error":false}' }), { isError: false, reason: "none" });
  assert.deepEqual(classifySlsError({ content: '{"level":30,"detail":{"message":"database timeout"}}' }), { isError: true, reason: "keyword" });
  assert.deepEqual(classifySlsError({ level: 30, status: 200, msg: "request completed", content: "ok" }), { isError: false, reason: "none" });
});

test("SLS adapter validates staging config and distinguishes data from no-data and failures", async () => {
  const client = new FakeSlsClient();
  const adapter = new AliyunSlsAdapter(factory(client));
  const range = { from: new Date("2026-11-16T08:30:00Z"), to: new Date("2026-11-16T08:35:00Z") };
  const connection = await adapter.validate(config);
  assert.equal(connection.status, "passed");
  const read = await adapter.readSample(config, range, 20);
  assert.equal(read.status, "passed");
  assert.equal(read.records.length, 1);
  assert.deepEqual(client.calls[0]!.query, { query: "*", line: 20, offset: 0, reverse: true });

  client.mode = "empty";
  assert.equal((await adapter.readSample(config, range, 20)).status, "no_data");
  client.mode = "fail";
  const failed = await adapter.readSample(config, range, 20);
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "Unauthorized");
  assert.doesNotMatch(JSON.stringify(failed), /access-key|secret/);
});

test("SLS verification failures never expose credentials echoed by the provider", async () => {
  const adapter = new AliyunSlsAdapter({
    create: () => ({
      getProject: async () => { throw Object.assign(new Error(`request rejected: ${config.accessKeySecret}`), { code: "Unauthorized" }); },
      getLogStore: async () => ({}),
      getLogs: async () => { throw Object.assign(new Error(`request rejected: ${config.accessKeySecret}`), { code: "Unauthorized" }); },
    }),
  });
  const connection = await adapter.validate(config);
  const read = await adapter.readSample(config, { from: new Date("2026-11-16T08:30:00Z"), to: new Date("2026-11-16T08:35:00Z") }, 10);
  assert.equal(connection.errorCode, "Unauthorized");
  assert.doesNotMatch(JSON.stringify([connection, read]), /secret/);
});

test("SLS adapter rejects unbounded reads and invalid endpoints", async () => {
  const client = new FakeSlsClient();
  const adapter = new AliyunSlsAdapter(factory(client));
  const invalid = await adapter.validate({ ...config, endpoint: "http://sls.example" });
  assert.equal(invalid.status, "failed");
  assert.equal(invalid.errorCode, "SLS_REQUEST_FAILED");
  const result = await adapter.readSample(config, { from: new Date(0), to: new Date(20 * 60_000) }, 101);
  assert.equal(result.status, "failed");
});

test("data source route persists normalized config but returns only a safe summary", async () => {
  let saved: Record<string, unknown> | undefined;
  const routes = new DataSourceRoutes({
    create: async (projectId, config) => {
      saved = { projectId, config };
      return { id: "source-1", status: "CONFIGURED" as const };
    },
  });
  const result = await routes.createSls({ userId: "user-1", projectId: "project-1" }, config);
  assert.deepEqual(result.config, { endpoint: config.endpoint, project: config.project, logstore: config.logstore, credentialsConfigured: true });
  assert.equal(JSON.stringify(result).includes("accessKey"), false);
  assert.equal((saved?.config as SlsConfig).project, config.project);
});

test("enablement requires both successful verification records", async () => {
  let connectionPassed = false;
  let readPassed = false;
  const routes = new DataSourceRoutes(
    { create: async () => ({ id: "source-1", status: "CONFIGURED" as const }) },
    new AliyunSlsAdapter(factory(new FakeSlsClient())),
    {
      async matchesConfig(_id, input) { return input.project === config.project; },
      async recordConnection(_id, result) { connectionPassed = result.status === "passed"; },
      async recordRead(_id, result) { readPassed = result.status !== "failed"; },
      async canEnable() { return connectionPassed && readPassed; },
      async enable() { return { status: "ENABLED" as const }; },
    },
  );
  await assert.rejects(routes.enable("source-1"), /both pass/);
  await routes.verifyConnection("source-1", config);
  await routes.verifyRead("source-1", config, { from: new Date("2026-11-16T08:30:00Z"), to: new Date("2026-11-16T08:35:00Z") }, 10);
  await assert.rejects(routes.verifyConnection("source-1", { ...config, project: "another-project" }), /does not match/);
  assert.deepEqual(await routes.enable("source-1"), { status: "ENABLED" });
});
