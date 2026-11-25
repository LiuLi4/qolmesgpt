import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { page } from "../dist/ui.js";

// Run the served page script against a small DOM/HTTP fixture without adding a browser dependency.
async function openPage(workspaces, sources = [], tasks = []) {
  const intervals = [];
  const storage = new Map();
  let stateCalls = 0;
  const elements = new Map();
  let taskCards = [];
  let taskDetailCalls = 0;
  let focused;
  function element(id, dataset = {}) {
    let html = "";
    return { id, dataset, value: "", textContent: "", disabled: false, hidden: false, open: false, style: {}, listeners: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(event, callback) { (this.listeners[event] ??= []).push(callback); },
      dispatch(type, event = {}) { event.preventDefault ??= () => {}; for (const callback of this.listeners[type] ?? []) callback.call(this, event); this.parent?.dispatch(type, event); },
      click() { if (!this.disabled) this.dispatch("click"); },
      input(value) { this.value = value; this.dispatch("input"); },
      change(value) { this.value = value; this.dispatch("change"); },
      showModal() { this.open = true; },
      close() { this.open = false; this.dispatch("close"); },
      setAttribute(name, value) { this[name] = value; },
      focus() { focused = id; },
      get innerHTML() { return html; },
      set innerHTML(value) {
        html = value;
        if (["active-workspace", "sls-workspace-id", "gitlab-group"].includes(id)) this.value = /<option value="([^"]*)"/.exec(value)?.[1] ?? "";
        if (id === "task-list") taskCards = [...value.matchAll(/<article[^>]*data-task="([^"]+)"/g)].map(([, task]) => element(`card-${task}`, { task }));
      },
    };
  }
  for (const [, id] of page.matchAll(/id="([^"]+)"/g)) elements.set(id, element(id));
  elements.get("close-task-detail").parent = elements.get("task-detail");
  elements.get("retry-investigation").parent = elements.get("task-detail");
  elements.get("gitlab-auth-method") && (elements.get("gitlab-auth-method").value = "pat");
  const nav = ["overview", "projects", "sources", "tasks", "approvals"].map((view) => element(`nav-${view}`, { view }));
  const location = { hash: "#projects" };
  let pendingCreate;
  let pendingSls;
  const slsRequests = [];
  let createCalls = 0;
  let state = { projects: [], tasks, workspaces, sources };
  const document = {
    getElementById: (id) => elements.get(id),
    querySelectorAll(selector) {
      if (selector === ".nav button") return nav;
      if (selector === ".view") return nav.map((item) => elements.get(item.dataset.view)).filter(Boolean);
      if (selector === "#task-list [data-task]") return taskCards;
      if (selector === "[data-task]") return [...taskCards, ...(elements.get("task-detail").dataset.task ? [elements.get("task-detail")] : [])];
      return [];
    },
  };
  const response = (data) => ({ ok: true, json: async () => data });
  runInNewContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document, location, history: { replaceState: (_state, _title, hash) => { location.hash = hash; } },
    setTimeout() {}, setInterval(callback) { intervals.push(callback); },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    fetch: async (url, options) => {
      if (url.startsWith("/api/state")) { stateCalls++; return response(state); }
      if (url === "/api/gitlab/connections") return response({ connections: [{ id: "connection", status: "ACTIVE", instanceUrl: "http://git.example" }] });
      if (url.endsWith("/groups")) return response({ items: [{ id: "group", fullPath: "acme/platform", role: "MAINTAINER" }] });
      if (/^\/api\/workspaces\/[^/]+\/automation$/.test(url)) {
        const id = url.split("/")[3]; const enabled = JSON.parse(options.body).enabled;
        state = { ...state, workspaces: state.workspaces.map((workspace) => workspace.id === id ? { ...workspace, automationEnabled: enabled } : workspace) };
        return response({ automationEnabled: enabled, message: enabled ? "已开启" : "已暂停" });
      }
      if (url === "/api/workspaces") { createCalls++; return new Promise((resolve) => { pendingCreate = resolve; }); }
      if (url === "/api/sls/verify") { slsRequests.push(JSON.parse(options.body)); return new Promise((resolve) => { pendingSls = resolve; }); }
      if (url.startsWith("/api/tasks/")) {
        taskDetailCalls++;
        return response({ approvals: [], groupedLogs: [], ...state.tasks.find((task) => url === `/api/tasks/${task.id}`) });
      }
      throw new Error(`Unexpected fixture request: ${url}`);
    },
  });
  await setImmediate();
  return { elements, location, slsRequests, get stateCalls() { return stateCalls; },
    get taskCards() { return taskCards; }, get taskDetailCalls() { return taskDetailCalls; },
    update(next) { state = { ...state, ...next }; },
    async tick() { intervals.forEach((callback) => callback()); await setImmediate(); },
    get focused() { return focused; }, get createCalls() { return createCalls; },
    completeCreate(workspace, nextWorkspaces) { state = { ...state, workspaces: nextWorkspaces }; pendingCreate(response({ ok: true, workspace, message: "Workspace 已建立" })); },
    completeSls(result, sources = []) { state = { ...state, sources }; pendingSls(response({ connection: { id: sources[0]?.id ?? "source-1" }, ...result })); },
  };
}

function workspace(id, status = "READY") { return { id, group: `acme/${id}`, relativePath: `groups/${id}`, status, repositories: [{ pathWithNamespace: `acme/${id}/api`, status }], errorMessage: status === "FAILED" ? "1 repository checkout requires attention" : null }; }

test("successful creation reports its result in the dialog and continues to the selected source workspace", async () => {
  const first = workspace("first");
  const second = workspace("second");
  const ui = await openPage([first], [{ workspaceId: first.id, project: "first-logs", logstore: "first-store", endpoint: "https://cn-shanghai.log.aliyuncs.com", status: "ENABLED" }]);
  const button = ui.elements.get("create-workspace");
  ui.elements.get("new-workspace").click();
  button.click();
  button.click();
  assert.equal(button.disabled, true);
  assert.equal(ui.createCalls, 1);
  // The creation response can precede synchronization; the refreshed state is authoritative.
  ui.completeCreate({ ...second, status: "INITIALIZING" }, [first, second]);
  await setImmediate();
  assert.equal(ui.elements.get("workspace-dialog").open, true);
  assert.match(ui.elements.get("gitlab-result").textContent, /已就绪/);
  ui.elements.get("continue-workspace").click();
  assert.equal(ui.elements.get("workspace-dialog").open, false);
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
  ui.elements.get("new-workspace").click();
  button.click();
  ui.completeCreate(failed, [failed]);
  await setImmediate();
  assert.equal(ui.location.hash, "#projects");
  assert.match(ui.elements.get("gitlab-result").textContent, /1 repository checkout requires attention/);
  assert.equal(ui.elements.get("workspace-dialog").open, true);
  assert.equal(button.disabled, false);
});

test("workspace creation is hidden until requested and authentication methods are mutually exclusive", async () => {
  const ui = await openPage([workspace("ready")]);
  const dialog = ui.elements.get("workspace-dialog");
  assert.equal(dialog.open, false);
  assert.match(ui.elements.get("active-workspace").innerHTML, /acme\/ready/);
  assert.equal(ui.elements.get("new-workspace").hidden, false);
  ui.elements.get("new-workspace").click();
  assert.equal(dialog.open, true);
  assert.equal(ui.elements.get("gitlab-pat-field").hidden, false);
  ui.elements.get("gitlab-auth-method").change("oauth");
  assert.equal(ui.elements.get("gitlab-pat-field").hidden, true);
  assert.equal(ui.elements.get("connect-gitlab").textContent, "使用 OAuth 连接");
  ui.elements.get("gitlab-auth-method").change("pat");
  assert.equal(ui.elements.get("gitlab-pat-field").hidden, false);
  assert.equal(ui.elements.get("connect-gitlab").textContent, "使用 PAT 连接");
  ui.elements.get("gitlab-pat").input("fixture-token");
  ui.elements.get("close-workspace-dialog").click();
  assert.equal(dialog.open, false);
  assert.equal(ui.elements.get("gitlab-pat").value, "");
  assert.equal(ui.focused, "new-workspace");
});

test("only ready workspaces are selectable and the selected workspace configures its own source", async () => {
  const ui = await openPage([workspace("ready"), workspace("failed", "FAILED")]);
  assert.match(ui.elements.get("active-workspace").innerHTML, /acme\/ready/);
  assert.doesNotMatch(ui.elements.get("active-workspace").innerHTML, /acme\/failed/);
  ui.elements.get("configure-current").click();
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
  assert.equal(ui.location.hash, "#projects");
});

test("running detection requires a recent heartbeat and reports checkpoint catch-up", async () => {
  const running = { ...source(), consumerStatus: "RUNNING", lastHeartbeatAt: new Date().toISOString(), lagging: false };
  const ui = await openPage([workspace("ready")], [running]);
  assert.match(ui.elements.get("detection-detail").textContent, /正在检测.*已追平/);
  const stale = await openPage([workspace("ready")], [{ ...running, lastHeartbeatAt: new Date(Date.now() - 120_000).toISOString() }]);
  assert.match(stale.elements.get("detection-detail").textContent, /心跳已过期/);
});

test("workspace switching scopes task cards, the open filter works, and polling discovers new tasks", async () => {
  const task = (id, workspaceId, status = "INVESTIGATION_PENDING") => ({ id, workspaceId, project: "acme/api", title: id, status, statusLabel: status, updatedAt: new Date().toISOString() });
  const ui = await openPage([workspace("first"), workspace("second")], [], [task("first-error", "first"), task("second-error", "second"), task("second-closed", "second", "CLOSED")]);
  assert.match(ui.elements.get("task-list").innerHTML, /first-error/);
  assert.doesNotMatch(ui.elements.get("task-list").innerHTML, /second-error/);
  ui.elements.get("active-workspace").change("second");
  await setImmediate();
  assert.match(ui.elements.get("task-list").innerHTML, /second-error/);
  assert.doesNotMatch(ui.elements.get("task-list").innerHTML, /first-error/);
  ui.elements.get("filter-open").click();
  assert.doesNotMatch(ui.elements.get("task-list").innerHTML, /second-closed/);
  ui.update({ tasks: [task("new-error", "second")] });
  await ui.tick();
  assert.match(ui.elements.get("task-list").innerHTML, /new-error/);
  assert.ok(ui.stateCalls >= 3);
  assert.doesNotMatch(page, /data-view="tasks"/);
  assert.doesNotMatch(page, /id="workspace-list"/);
});

test("automatic refresh preserves unsaved SLS fields and credentials", async () => {
  const ui = await openPage([workspace("ready")], [source()]);
  ui.elements.get("sls-logstore").input("unsaved-logstore");
  ui.elements.get("sls-access-key-secret").input("fixture-secret");
  await ui.tick();
  assert.equal(ui.elements.get("sls-logstore").value, "unsaved-logstore");
  assert.equal(ui.elements.get("sls-access-key-secret").value, "fixture-secret");
  assert.equal(ui.elements.get("save-sls").disabled, false);
});

test("task detail stays closed after polling and can be reopened without dialog click or keyboard handlers", async () => {
  const task = { id: "task-1", workspaceId: "ready", title: "Request error", status: "AWAITING_APPROVAL", occurrenceCount: 4, requestCount: 2 };
  const ui = await openPage([workspace("ready")], [], [task]);
  const dialog = ui.elements.get("task-detail");
  const close = ui.elements.get("close-task-detail");
  for (let cycle = 0; cycle < 2; cycle++) {
    ui.taskCards[0].click();
    await setImmediate();
    assert.equal(dialog.open, true);
    assert.match(ui.elements.get("task-detail-meta").textContent, /错误日志 4 条 · 请求 2 次/);
    await ui.tick();
    await ui.tick();
    const reads = ui.taskDetailCalls;
    close.click();
    await setImmediate();
    assert.equal(dialog.open, false, "closing must not bubble into an open-task handler on the dialog");
    assert.equal(ui.taskDetailCalls, reads, "closing must not fetch and reopen the same task");
    close.dispatch("keydown", { key: "Enter" });
    assert.equal(dialog.open, false, "keyboard events inside a closed dialog must not reopen it");
    await ui.tick();
    assert.equal(dialog.open, false);
    assert.equal(ui.taskDetailCalls, reads);
  }
});

test("workspace and log source selectors share the top context and show live log details", () => {
  assert.match(page, /class="workspace-context"/);
  assert.match(page, /id="active-workspace" aria-label="切换 Workspace"/);
  assert.match(page, /id="source-switcher"/);
  assert.match(page, /id="monitor-source" aria-label="切换日志数据源"/);
  assert.match(page, /当前日志实时详情/);
  assert.match(page, /原始日志保留在阿里云 SLS；错误日志与调查结果保存到系统数据库/);
});


test("task detail displays the full task ID and separates error evidence from investigation conclusions", async () => {
  const task = { id: "351c324a-4034-4384-9ee9-a311b2a1c666", workspaceId: "ready", title: "Request error", status: "AWAITING_APPROVAL", occurrenceCount: 5, requestCount: 5,
    groupedLogs: [{ logEvidenceJson: { msg: "raw-error-evidence", status: "502" } }],
    investigation: { summary: "investigation-summary", rootCause: "root-cause", proposedFix: "fix-proposal", confidence: "low", codeContext: ["handler.ts:12"], evidence: { relatedLogs: [{ msg: "request-context" }] } } };
  const ui = await openPage([workspace("ready")], [], [task]);
  ui.taskCards[0].click();
  await setImmediate();
  assert.equal(ui.elements.get("task-detail-id").textContent, `任务 ID：${task.id}`);
  assert.match(ui.elements.get("task-detail-logs").textContent, /raw-error-evidence/);
  assert.match(ui.elements.get("task-context-logs").textContent, /request-context/);
  assert.match(ui.elements.get("task-detail-content").textContent, /investigation-summary[\s\S]*root-cause[\s\S]*fix-proposal/);
  assert.doesNotMatch(ui.elements.get("task-detail-content").textContent, /raw-error-evidence|request-context/);
  assert.match(ui.elements.get("task-detail-meta").textContent, /待审批 · 错误日志 5 条 · 请求 5 次/);
});


test("automation switch reflects persisted pause, controls its workspace and refreshes without resuming", async () => {
  const paused = { ...workspace("paused"), automationEnabled: false };
  const ui = await openPage([paused]);
  assert.equal(ui.elements.get("automation-toggle")["aria-checked"], "false");
  assert.match(ui.elements.get("automation-label").textContent, /已暂停/);
  await ui.tick();
  assert.equal(ui.elements.get("automation-toggle")["aria-checked"], "false");
  ui.elements.get("automation-toggle").click();
  await setImmediate();
  assert.equal(ui.elements.get("automation-toggle")["aria-checked"], "true");
  ui.elements.get("automation-toggle").click();
  await setImmediate();
  assert.equal(ui.elements.get("automation-toggle")["aria-checked"], "false");
  assert.match(ui.elements.get("automation-label").textContent, /已暂停/);
});
