import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { page } from "./ui.js";
import { closeWebRuntime, getWebRuntime } from "./control-plane.js";

const port = Number(process.env.PORT ?? 5050);
const host = process.env.HOST ?? "127.0.0.1";
const execFileAsync = promisify(execFile);

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

function statusForError(error: unknown): number {
  const message = errorMessage(error);
  if (/required for the real control-plane|DATABASE_URL|credential key/i.test(message)) return 503;
  if (/not found|does not exist|unavailable/i.test(message)) return 404;
  if (/cannot|must|invalid|already|awaiting|verification|permission|approval|credentials/i.test(message)) return 400;
  return 500;
}

function safeDate(value: unknown, fallback: Date): Date {
  const date = new Date(String(value ?? fallback.toISOString()));
  return Number.isFinite(date.getTime()) ? date : fallback;
}

function statusLabel(status: string, approved: boolean): string {
  if (approved) return "已批准";
  const labels: Record<string, string> = {
    INVESTIGATION_PENDING: "待调查",
    INVESTIGATING: "调查中",
    AWAITING_APPROVAL: "待审批",
    REPAIRING: "修复中",
    VERIFIED: "已验证",
    FAILED: "失败",
    CLOSED: "已关闭",
  };
  return labels[status] ?? status;
}

async function statePayload() {
  const runtime = await getWebRuntime();
  const projects = await runtime.prisma.project.findMany({
    where: { createdByUserId: runtime.userId },
    orderBy: { updatedAt: "desc" },
    include: { workspace: true, dataSources: { include: { consumerState: true } } },
  });
  const tasks = await runtime.prisma.investigationTask.findMany({
    where: { project: { createdByUserId: runtime.userId } },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: { project: { select: { id: true, pathWithNamespace: true } }, errorEvent: { select: { logEvidenceJson: true } }, approvals: { select: { decision: true, approvedAt: true }, take: 1 } },
  });
  const sources = projects.flatMap((project) => project.dataSources.map((source) => {
    const config = source.configJson as Record<string, unknown>;
    return {
      id: source.id,
      projectId: project.id,
      name: "Aliyun SLS",
      project: String(config.project ?? ""),
      logstore: String(config.logstore ?? ""),
      endpoint: String(config.endpoint ?? ""),
      consumerGroup: source.consumerState?.consumerGroup ?? String(config.consumerGroup ?? ""),
      status: source.status,
      consumerStatus: source.consumerState?.status ?? "STOPPED",
    };
  }));
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const errorCount = await runtime.prisma.errorEvent.count({ where: { sourceTimestamp: { gte: cutoff }, dataSourceConnection: { project: { createdByUserId: runtime.userId } } } });
  return {
    projects: projects.map((project) => ({
      id: project.id,
      name: project.pathWithNamespace.split("/").at(-1) ?? project.pathWithNamespace,
      repository: project.pathWithNamespace,
      workspace: project.workspace?.relativePath ?? "未建立",
      detection: project.dataSources.length ? "SLS staging" : "未配置",
      status: project.workspace?.status === "FAILED" ? "attention" : "healthy",
      health: project.workspace?.status === "READY" ? 100 : project.workspace ? 60 : 25,
    })),
    sources,
    tasks: tasks.map((task) => {
      const approval = task.approvals[0];
      return {
        id: task.id,
        project: task.project.pathWithNamespace,
        title: `日志错误事件 ${task.errorEvent.logEvidenceJson && typeof task.errorEvent.logEvidenceJson === "object" ? String((task.errorEvent.logEvidenceJson as Record<string, unknown>).msg ?? "需要调查") : "需要调查"}`,
        status: task.status,
        statusLabel: statusLabel(task.status, approval?.decision === "APPROVED"),
        approved: approval?.decision === "APPROVED",
        updatedAt: task.updatedAt.toISOString(),
        file: "由 HolmesGPT 调查结果提供",
      };
    }),
    errorCount,
    real: true,
  };
}

async function cloneSelectedProject(runtime: Awaited<ReturnType<typeof getWebRuntime>>, input: { connectionId: string; groupId: string; externalProjectId: string }) {
  const projects = await runtime.gitlab.listProjects(runtime.userId, input.connectionId, input.groupId);
  const selected = projects.items.find((project) => project.id === input.externalProjectId);
  if (!selected) throw new Error("GitLab project is not available in the selected Group");
  const group = await runtime.prisma.gitLabGroup.upsert({
    where: { connectionId_externalGroupId: { connectionId: input.connectionId, externalGroupId: input.groupId } },
    create: { connectionId: input.connectionId, externalGroupId: input.groupId, fullPath: selected.pathWithNamespace.split("/").slice(0, -1).join("/") },
    update: {},
  });
  const project = await runtime.prisma.project.upsert({
    where: { connectionId_externalProjectId: { connectionId: input.connectionId, externalProjectId: selected.id } },
    create: { connectionId: input.connectionId, groupId: group.id, externalProjectId: selected.id, pathWithNamespace: selected.pathWithNamespace, defaultBranch: selected.defaultBranch, createdByUserId: runtime.userId },
    update: { groupId: group.id, pathWithNamespace: selected.pathWithNamespace, defaultBranch: selected.defaultBranch },
  });
  const root = resolve(process.env.QOLMESGPT_WORKSPACE_ROOT ?? resolve(process.cwd(), ".qolmesgpt-workspaces"));
  const relativePath = `projects/${project.id}`;
  const absolutePath = resolve(root, relativePath);
  const contained = relative(root, absolutePath);
  if (isAbsolute(contained) || contained.startsWith("..")) throw new Error("Workspace path escapes the workspace root");
  const existing = await runtime.prisma.projectWorkspace.findUnique({ where: { projectId: project.id } });
  if (existing?.status === "READY") return { project, workspace: existing };
  await mkdir(dirname(absolutePath), { recursive: true });
  const rootStat = await lstat(root).catch(() => null);
  if (rootStat?.isSymbolicLink()) throw new Error("Workspace root cannot be a symlink");
  const token = await runtime.gitlab.getAccessToken(runtime.userId, input.connectionId);
  const remoteUrl = `${selected.webUrl.replace(/\/$/, "")}.git`;
  try {
    await runtime.prisma.projectWorkspace.upsert({
      where: { projectId: project.id },
      create: { projectId: project.id, relativePath, branch: selected.defaultBranch, status: "INITIALIZING" },
      update: { relativePath, branch: selected.defaultBranch, status: "INITIALIZING" },
    });
    await execFileAsync("git", ["clone", "--branch", selected.defaultBranch, "--single-branch", remoteUrl, absolutePath], {
      cwd: dirname(absolutePath),
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `PRIVATE-TOKEN: ${token}` },
    });
    const head = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: absolutePath, maxBuffer: 1024 * 1024 });
    const workspace = await runtime.prisma.projectWorkspace.update({ where: { projectId: project.id }, data: { status: "READY", headSha: head.stdout.trim() } });
    return { project, workspace };
  } catch (error) {
    await runtime.prisma.projectWorkspace.update({ where: { projectId: project.id }, data: { status: "FAILED" } }).catch(() => undefined);
    throw new Error(`Workspace initialization failed: ${errorMessage(error)}`);
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    try {
      const runtime = await getWebRuntime();
      await runtime.prisma.$queryRaw`SELECT 1`;
      sendJson(res, 200, { ok: true, service: "qolmesgpt-web", mode: "connected", database: "connected", userId: runtime.userId, timestamp: new Date().toISOString() });
    } catch (error) {
      sendJson(res, statusForError(error), { ok: false, service: "qolmesgpt-web", mode: "connected", message: errorMessage(error) });
    }
    return;
  }
  try {
    if (req.method === "GET" && url.pathname === "/api/state") {
      sendJson(res, 200, await statePayload());
      return;
    }
    const slsVerify = req.method === "POST" && url.pathname === "/api/sls/verify";
    if (slsVerify) {
      const runtime = await getWebRuntime();
      const body = await readBody(req);
      const projectId = String(body.projectId ?? "");
      if (!projectId) throw new Error("请先选择 GitLab 项目");
      const endpoint = String(body.endpoint ?? "");
      const project = String(body.project ?? "");
      const logstore = String(body.logstore ?? "");
      const consumerGroup = String(body.consumerGroup ?? "");
      const accessKeyId = String(body.accessKeyId ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_ID ?? process.env.SLS_ACCESS_KEY_ID ?? "");
      const accessKeySecret = String(body.accessKeySecret ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET ?? process.env.SLS_ACCESS_KEY_SECRET ?? "");
      const securityToken = String(body.securityToken ?? process.env.ALIBABA_CLOUD_SECURITY_TOKEN ?? process.env.SLS_SECURITY_TOKEN ?? "");
      const config = { endpoint, project, logstore, consumerGroup, accessKeyId, accessKeySecret, ...(securityToken ? { securityToken } : {}) };
      const connection = await runtime.sls.createSls({ userId: runtime.userId, projectId }, config);
      const connectionTest = await runtime.sls.verifyConnection(connection.id, config);
      const now = new Date();
      const readTest = await runtime.sls.verifyRead(connection.id, config, { from: safeDate(body.from, new Date(now.getTime() - 5 * 60_000)), to: safeDate(body.to, now) }, Math.min(100, Math.max(1, Number(body.limit ?? 20))));
      const enabled = connectionTest.status === "passed" && (readTest.status === "passed" || readTest.status === "no_data") ? await runtime.sls.enable(connection.id) : null;
      sendJson(res, 200, { ok: Boolean(enabled), connection, connectionTest, readTest, enabled, message: enabled ? "SLS 连接、读取测试通过，数据源已启用。" : "SLS 配置已保存，但连接或读取测试未通过。" });
      return;
    }
    const approval = url.pathname.match(/^\/api\/tasks\/([^/]+)\/approve$/);
    const taskDetail = req.method === "GET" && url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskDetail) {
      const runtime = await getWebRuntime();
      const task = await runtime.prisma.investigationTask.findFirst({
        where: { id: decodeURIComponent(taskDetail[1]!), project: { createdByUserId: runtime.userId } },
        include: { project: { select: { pathWithNamespace: true } }, errorEvent: { select: { sourceTimestamp: true, logEvidenceJson: true } }, approvals: { select: { decision: true, groupRoleAtApproval: true, approvedAt: true } }, repairRuns: { include: { mergeRequest: true } } },
      });
      if (!task) { sendJson(res, 404, { message: "任务不存在" }); return; }
      sendJson(res, 200, {
        id: task.id,
        project: task.project.pathWithNamespace,
        status: task.status,
        priority: task.priority,
        detectedAt: task.errorEvent.sourceTimestamp.toISOString(),
        logEvidence: task.errorEvent.logEvidenceJson,
        investigation: task.investigationResultJson,
        approvals: task.approvals,
        repairs: task.repairRuns.map((run) => ({ status: run.status, tests: run.testResult, slsRecheck: run.slsRecheckResult, mergeRequest: run.mergeRequest ? { url: run.mergeRequest.url, status: run.mergeRequest.status } : null })),
      });
      return;
    }
    if (req.method === "POST" && approval) {
      const runtime = await getWebRuntime();
      const record = await runtime.approvals.approve(runtime.userId, decodeURIComponent(approval[1]));
      sendJson(res, 200, { ok: true, record, message: "审批已写入数据库，RepairRequested 已加入 outbox。" });
      return;
    }
    const reject = url.pathname.match(/^\/api\/tasks\/([^/]+)\/reject$/);
    if (req.method === "POST" && reject) {
      const runtime = await getWebRuntime();
      const record = await runtime.approvals.reject(runtime.userId, decodeURIComponent(reject[1]));
      sendJson(res, 200, { ok: true, record, message: "任务已拒绝并关闭。" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/gitlab/connections") {
      const runtime = await getWebRuntime();
      const connections = await runtime.prisma.gitLabConnection.findMany({ where: { userId: runtime.userId }, select: { id: true, instanceUrl: true, authType: true, status: true, expiresAt: true } });
      sendJson(res, 200, { connections: connections.map((item) => ({ ...item, expiresAt: item.expiresAt?.toISOString() ?? null })) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/gitlab/pat") {
      const runtime = await getWebRuntime();
      const body = await readBody(req);
      const connection = await runtime.gitlab.connectPAT(runtime.userId, { instanceUrl: String(body.instanceUrl ?? ""), personalAccessToken: String(body.personalAccessToken ?? "") });
      sendJson(res, 200, { ok: true, connection });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/gitlab/oauth/start") {
      const runtime = await getWebRuntime();
      const instanceUrl = url.searchParams.get("instanceUrl") ?? "https://gitlab.com";
      sendJson(res, 200, await runtime.gitlab.startOAuth(runtime.userId, { instanceUrl }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/gitlab/oauth/callback") {
      const runtime = await getWebRuntime();
      const connection = await runtime.gitlab.completeOAuth(runtime.userId, {
        state: url.searchParams.get("state") ?? undefined,
        code: url.searchParams.get("code") ?? undefined,
        error: url.searchParams.get("error") ?? undefined,
        errorDescription: url.searchParams.get("error_description") ?? undefined,
      });
      res.writeHead(302, { location: "/#projects" });
      res.end(`GitLab OAuth connected: ${connection.id}`);
      return;
    }
    const groupsPath = url.pathname.match(/^\/api\/gitlab\/connections\/([^/]+)\/groups$/);
    if (req.method === "GET" && groupsPath) {
      const runtime = await getWebRuntime();
      sendJson(res, 200, await runtime.gitlab.listGroups(runtime.userId, decodeURIComponent(groupsPath[1])));
      return;
    }
    const projectsPath = url.pathname.match(/^\/api\/gitlab\/connections\/([^/]+)\/groups\/([^/]+)\/projects$/);
    if (req.method === "GET" && projectsPath) {
      const runtime = await getWebRuntime();
      sendJson(res, 200, await runtime.gitlab.listProjects(runtime.userId, decodeURIComponent(projectsPath[1]), decodeURIComponent(projectsPath[2])));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/projects") {
      const runtime = await getWebRuntime();
      const body = await readBody(req);
      const result = await cloneSelectedProject(runtime, { connectionId: String(body.connectionId ?? ""), groupId: String(body.groupId ?? ""), externalProjectId: String(body.externalProjectId ?? "") });
      sendJson(res, 201, { ok: true, ...result, message: "GitLab 项目已关联并建立独立 workspace。" });
      return;
    }
    sendJson(res, 404, { detail: "Not Found" });
  } catch (error) {
    sendJson(res, statusForError(error), { ok: false, message: errorMessage(error) });
  }
}

const server = createServer((req, res) => { void handleRequest(req, res); });
server.listen(port, host, () => console.log(`QolmesGPT Web UI listening at http://${host}:${port}`));
const shutdown = () => { void closeWebRuntime().finally(() => server.close()); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

export { server };
