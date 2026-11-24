import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { page } from "../dist/ui.js";

// Run the served page script against a small DOM/HTTP fixture without adding a browser dependency.
async function openPage(workspaces, sources = []) {
  const elements = new Map();
  let focused;
  function element(id, dataset = {}) {
    let html = "";
    return { id, dataset, value: "", textContent: "", disabled: false, style: {}, listeners: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(event, callback) { this.listeners[event] = callback; },
      click() { if (!this.disabled) this.listeners.click?.call(this); },
      input(value) { this.value = value; this.listeners.input?.call(this); },
      focus() { focused = id; },
      get innerHTML() { return html; },
      set innerHTML(value) { html = value; if (["sls-workspace-id", "gitlab-group"].includes(id)) this.value = /<option value="([^"]*)"/.exec(value)?.[1] ?? ""; },
    };
  }
  for (const [, id] of page.matchAll(/id="([^"]+)"/g)) elements.set(id, element(id));
  const nav = ["overview", "projects", "sources", "tasks", "approvals"].map((view) => element(`nav-${view}`, { view }));
  const location = { hash: "#projects" };
  let pendingCreate;
  let pendingSls;
  const slsRequests = [];
  let createCalls = 0;
  let state = { projects: [], tasks: [], workspaces, sources };
  const document = {
    getElementById: (id) => elements.get(id),
    querySelectorAll(selector) {
      if (selector === ".nav button") return nav;
      if (selector === ".view") return nav.map((item) => elements.get(item.dataset.view));
      if (selector === "[data-configure-workspace]") {
        return [...elements.get("workspace-list").innerHTML.matchAll(/data-configure-workspace="([^"]+)"/g)].map(([, id]) => {
          const button = element(`configure-${id}`, { configureWorkspace: id });
          elements.set(button.id, button);
          return button;
        });
      }
      return [];
    },
  };
  const response = (data) => ({ ok: true, json: async () => data });
  runInNewContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document, location, history: { replaceState: (_state, _title, hash) => { location.hash = hash; } },
    setTimeout() {},
    fetch: async (url, options) => {
      if (url === "/api/state") return response(state);
      if (url === "/api/gitlab/connections") return response({ connections: [{ id: "connection", status: "ACTIVE", instanceUrl: "http://git.example" }] });
      if (url.endsWith("/groups")) return response({ items: [{ id: "group", fullPath: "acme/platform", role: "MAINTAINER" }] });
      if (url === "/api/workspaces") { createCalls++; return new Promise((resolve) => { pendingCreate = resolve; }); }
      if (url === "/api/sls/verify") { slsRequests.push(JSON.parse(options.body)); return new Promise((resolve) => { pendingSls = resolve; }); }
      throw new Error(`Unexpected fixture request: ${url}`);
    },
  });
  await setImmediate();
  return { elements, location, slsRequests, get focused() { return focused; }, get createCalls() { return createCalls; },
    completeCreate(workspace, nextWorkspaces) { state = { ...state, workspaces: nextWorkspaces }; pendingCreate(response({ ok: true, workspace, message: "Workspace 已建立" })); },
    completeSls(result, sources = []) { state = { ...state, sources }; pendingSls(response(result)); },
  };
}

function workspace(id, status = "READY") { return { id, group: `acme/${id}`, relativePath: `groups/${id}`, status, repositories: [{ pathWithNamespace: `acme/${id}/api`, status }], errorMessage: status === "FAILED" ? "1 repository checkout requires attention" : null }; }

test("successful creation advances to sources with the created workspace selected, including multiple workspaces", async () => {
  const first = workspace("first");
  const second = workspace("second");
  const ui = await openPage([first], [{ workspaceId: first.id, project: "first-logs", logstore: "first-store", endpoint: "https://cn-shanghai.log.aliyuncs.com", status: "ENABLED" }]);
  const button = ui.elements.get("create-workspace");
  button.click();
  button.click();
  assert.equal(button.disabled, true);
  assert.equal(ui.createCalls, 1);
  // The creation response can precede synchronization; the refreshed state is authoritative.
  ui.completeCreate({ ...second, status: "INITIALIZING" }, [first, second]);
  await setImmediate();
  assert.equal(ui.location.hash, "#sources");
  assert.equal(ui.elements.get("sls-workspace-id").value, second.id);
  assert.equal(ui.elements.get("sls-project").value, "pyxis-telemetry-log");
  assert.match(ui.elements.get("source-result").textContent, /acme\/second/);
  assert.equal(button.disabled, false);
});

test("failed synchronization stays on projects, reports the failure and restores the create button", async () => {
  const failed = workspace("failed", "FAILED");
  const ui = await openPage([]);
  const button = ui.elements.get("create-workspace");
  button.click();
  ui.completeCreate(failed, [failed]);
  await setImmediate();
  assert.equal(ui.location.hash, "#projects");
  assert.match(ui.elements.get("gitlab-result").textContent, /1 repository checkout requires attention/);
  assert.equal(button.disabled, false);
});

test("an existing ready workspace offers a direct next step while a failed workspace does not", async () => {
  const ui = await openPage([workspace("ready"), workspace("failed", "FAILED")]);
  const button = ui.elements.get("configure-ready");
  assert.ok(button);
  assert.equal(ui.elements.has("configure-failed"), false);
  button.click();
  assert.equal(ui.location.hash, "#sources");
  assert.equal(ui.elements.get("sls-workspace-id").value, "ready");
});

test("save invokes the real verification and persistence endpoint, reports saved state and clears credentials", async () => {
  const ui = await openPage([workspace("ready")]);
  ui.elements.get("sls-access-key-id").input("fixture-key");
  ui.elements.get("sls-access-key-secret").input("fixture-secret");
  const save = ui.elements.get("save-sls");
  save.click();
  save.click();
  assert.equal(ui.slsRequests.length, 1);
  assert.equal(ui.slsRequests[0].workspaceId, "ready");
  assert.equal(ui.slsRequests[0].accessKeySecret, "fixture-secret");
  assert.equal(save.disabled, true);
  assert.equal(ui.elements.get("verify-sls").disabled, true);
  ui.completeSls({ ok: true, message: "配置已加密保存并启用" }, [source()]);
  await setImmediate();
  assert.equal(save.textContent, "已保存");
  assert.equal(save.disabled, true);
  assert.match(ui.elements.get("source-result").textContent, /已加密保存/);
  assert.equal(ui.elements.get("sls-access-key-id").value, "");
  assert.equal(ui.elements.get("sls-access-key-secret").value, "");
});

function source() { return { id: "source-1", workspaceId: "ready", project: "custom-project", logstore: "custom-logstore", endpoint: "https://cn-shanghai.log.aliyuncs.com", consumerGroup: "custom-consumer", status: "ENABLED" }; }

test("persisted configuration reloads as saved, and edits require another successful test before being marked saved", async () => {
  const ui = await openPage([workspace("ready")], [source()]);
  const save = ui.elements.get("save-sls");
  assert.equal(save.textContent, "已保存");
  assert.equal(save.disabled, true);
  assert.match(ui.elements.get("sls-source-summary").textContent, /custom-project \/ custom-logstore/);
  ui.elements.get("sls-logstore").input("another-logstore");
  assert.equal(save.disabled, false);
  assert.equal(save.textContent, "保存配置");
  ui.elements.get("verify-sls").click();
  ui.completeSls({ ok: false, message: "读取测试未通过" });
  await setImmediate();
  assert.equal(save.disabled, false);
  assert.match(ui.elements.get("source-result").textContent, /读取测试未通过/);
  assert.equal(ui.elements.get("source-status").textContent, "测试失败");
});

test("saved configuration reports consumer failure separately and offers investigation tasks", async () => {
  const ui = await openPage([workspace("ready")], [{ ...source(), consumerStatus: "FAILED", consumerErrorCode: "INVALID_CREDENTIAL_CONFIG" }]);
  assert.match(ui.elements.get("detection-detail").textContent, /检测失败.*INVALID_CREDENTIAL_CONFIG/);
  assert.equal(ui.elements.get("save-sls").textContent, "已保存");
  ui.elements.get("view-sls-tasks").click();
  assert.equal(ui.location.hash, "#tasks");
});

test("running detection requires a recent heartbeat and reports checkpoint catch-up", async () => {
  const running = { ...source(), consumerStatus: "RUNNING", lastHeartbeatAt: new Date().toISOString(), lagging: false };
  const ui = await openPage([workspace("ready")], [running]);
  assert.match(ui.elements.get("detection-detail").textContent, /正在检测.*已追平/);
  const stale = await openPage([workspace("ready")], [{ ...running, lastHeartbeatAt: new Date(Date.now() - 120_000).toISOString() }]);
  assert.match(stale.elements.get("detection-detail").textContent, /心跳已过期/);
});
