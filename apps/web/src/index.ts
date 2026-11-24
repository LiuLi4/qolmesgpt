import { backfillSls, AliyunSlsConsumerProtocol } from "@qolmesgpt/workers";
import { GitRepositoryCheckout } from "@qolmesgpt/control-plane";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { page } from "./ui.js";
import { closeWebRuntime, getWebRuntime } from "./control-plane.js";

const port = Number(process.env.PORT ?? 5050);
const host = process.env.HOST ?? "127.0.0.1";

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

function telemetry(source: { enabledAt: Date | null; consumerState: { checkpointSummary: unknown } | null }) {
  const summary = (source.consumerState?.checkpointSummary ?? {}) as Record<string, unknown>;
  return { enabledAt: source.enabledAt?.toISOString() ?? null, logsConsumed: Number(summary.logsConsumed ?? 0), tasksCreated: Number(summary.tasksCreated ?? 0), lastLogAt: summary.lastLogAt ?? null, recentLogs: Array.isArray(summary.recentLogs) ? summary.recentLogs : [] };
}

async function statePayload(workspaceId?: string) {
  const runtime = await getWebRuntime();
  const projects = await runtime.prisma.project.findMany({
    where: { createdByUserId: runtime.userId },
    orderBy: { updatedAt: "desc" },
    include: { workspace: true, dataSources: { include: { consumerState: true } } },
  });
  const groupWorkspaces = await runtime.prisma.groupWorkspace.findMany({
    where: { group: { connection: { userId: runtime.userId } } },
    include: { group: true, repositories: { where: { active: true }, include: { project: { include: { workspace: true } } } }, dataSources: { include: { consumerState: true } } },
    orderBy: { updatedAt: "desc" },
  });
  const tasks = await runtime.prisma.investigationTask.findMany({
    where: { ...(workspaceId ? { workspaceId } : {}), OR: [{ project: { createdByUserId: runtime.userId } }, { workspace: { group: { connection: { userId: runtime.userId } } } }] },
    orderBy: { errorEvent: { sourceTimestamp: "desc" } },
    take: 100,
    include: { project: { select: { id: true, pathWithNamespace: true } }, workspace: { select: { group: { select: { fullPath: true } } } }, repositories: { select: { project: { select: { id: true, pathWithNamespace: true } } } }, errorEvent: { select: { logEvidenceJson: true, sourceTimestamp: true } }, approvals: { select: { decision: true, approvedAt: true }, take: 1 } },
  });
  const sources = [...projects.flatMap((project) => project.dataSources.map((source) => {
    const config = source.configJson as Record<string, unknown>;
    return {
      ...telemetry(source),
      id: source.id,
      projectId: project.id,
      name: "Aliyun SLS",
      project: String(config.project ?? ""),
      logstore: String(config.logstore ?? ""),
      endpoint: String(config.endpoint ?? ""),
      consumerGroup: source.consumerState?.consumerGroup ?? String(config.consumerGroup ?? ""),
      status: source.status,
      consumerStatus: source.consumerState?.status ?? "STOPPED",
      lastHeartbeatAt: source.consumerState?.lastHeartbeatAt?.toISOString() ?? null,
      consumerErrorCode: (source.consumerState?.checkpointSummary as Record<string, unknown> | null)?.errorCode ?? null,
      lagging: (source.consumerState?.checkpointSummary as Record<string, unknown> | null)?.lagging ?? null,
    };
  })), ...groupWorkspaces.flatMap((workspace) => workspace.dataSources.map((source) => ({
    ...telemetry(source),
    id: source.id,
    workspaceId: workspace.id,
    projectId: null,
    name: "Aliyun SLS",
    project: String((source.configJson as Record<string, unknown>).project ?? ""),
    logstore: String((source.configJson as Record<string, unknown>).logstore ?? ""),
    endpoint: String((source.configJson as Record<string, unknown>).endpoint ?? ""),
    consumerGroup: source.consumerState?.consumerGroup ?? String((source.configJson as Record<string, unknown>).consumerGroup ?? ""),
    status: source.status,
    consumerStatus: source.consumerState?.status ?? "STOPPED",
    lastHeartbeatAt: source.consumerState?.lastHeartbeatAt?.toISOString() ?? null,
    consumerErrorCode: (source.consumerState?.checkpointSummary as Record<string, unknown> | null)?.errorCode ?? null,
    lagging: (source.consumerState?.checkpointSummary as Record<string, unknown> | null)?.lagging ?? null,
  })))];
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const errorCount = await runtime.prisma.errorEvent.count({ where: { sourceTimestamp: { gte: cutoff }, dataSourceConnection: { ...(workspaceId ? { workspaceId } : {}), OR: [{ project: { createdByUserId: runtime.userId } }, { workspace: { group: { connection: { userId: runtime.userId } } } }] } } });
  return {
    projects: projects.map((project) => ({
      id: project.id,
      name: project.pathWithNamespace.split("/").at(-1) ?? project.pathWithNamespace,
      repository: project.pathWithNamespace,
      workspace: project.workspace?.relativePath ?? "未建立",
      detection: project.dataSources.length || groupWorkspaces.some((workspace) => workspace.repositories.some((entry) => entry.project.id === project.id) && workspace.dataSources.length) ? "SLS 已接入" : "未配置",
      status: project.workspace?.status === "FAILED" ? "attention" : "healthy",
      health: project.workspace?.status === "READY" ? 100 : project.workspace ? 60 : 25,
    })),
    workspaces: groupWorkspaces.map((workspace) => ({
      id: workspace.id,
      group: workspace.group.fullPath,
      status: workspace.status,
      relativePath: workspace.relativePath,
      errorMessage: workspace.errorMessage,
      repositories: workspace.repositories.map(({ project }) => ({ id: project.id, pathWithNamespace: project.pathWithNamespace, status: project.workspace?.status ?? "INITIALIZING", errorMessage: project.workspace?.errorMessage ?? null })),
      dataSources: workspace.dataSources.map((source) => ({ id: source.id, type: source.type, status: source.status, consumerStatus: source.consumerState?.status ?? "STOPPED" })),
    })),
    sources,
    tasks: tasks.map((task) => {
      const approval = task.approvals[0];
      return {
        id: task.id,
        workspaceId: task.workspaceId,
        detectedAt: task.errorEvent.sourceTimestamp.toISOString(),
        logEvidence: task.errorEvent.logEvidenceJson,
        projectId: task.projectId,
        project: task.project?.pathWithNamespace ?? task.workspace?.group.fullPath ?? "Group Workspace",
        repositories: task.repositories.map(({ project }) => project.pathWithNamespace),
        title: (() => {
          const log = (task.errorEvent.logEvidenceJson ?? {}) as Record<string, unknown>;
          const content = typeof log.content === "object" && log.content ? log.content as Record<string, unknown> : {};
          return String(log.msg ?? log.message ?? content.msg ?? content.message ?? "日志错误，需要调查").slice(0, 300);
        })(),
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
  const token = await runtime.gitlab.getAccessToken(runtime.userId, input.connectionId);
  const remoteUrl = `${selected.webUrl.replace(/\/$/, "")}.git`;
  try {
    await runtime.prisma.projectWorkspace.upsert({
      where: { projectId: project.id },
      create: { projectId: project.id, relativePath, branch: selected.defaultBranch, status: "INITIALIZING" },
      update: { relativePath, branch: selected.defaultBranch, status: "INITIALIZING" },
    });
    const checkout = await new GitRepositoryCheckout(root).prepare({ relativePath, remoteUrl, branch: selected.defaultBranch, token });
    const workspace = await runtime.prisma.projectWorkspace.update({ where: { projectId: project.id }, data: { ...checkout, errorMessage: checkout.status === "DIRTY" ? "Repository contains uncommitted changes" : null } });
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
      sendJson(res, 200, await statePayload(url.searchParams.get("workspaceId") || undefined));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/sls/backfill") {
      const runtime = await getWebRuntime();
      const body = await readBody(req);
      const sourceId = String(body.sourceId ?? "");
      const allowed = await runtime.prisma.dataSourceConnection.findFirst({ where: { id: sourceId, status: "ENABLED", OR: [{ project: { createdByUserId: runtime.userId } }, { workspace: { group: { connection: { userId: runtime.userId } } } }] }, select: { id: true } });
      if (!allowed) throw new Error("Enabled data source not found");
      const [source] = await runtime.detection.listEnabled(sourceId);
      if (!source) throw new Error("Data source credentials unavailable");
      let cursors: Record<string, string> | undefined;
      if (body.cursors !== undefined) {
        if (!body.cursors || typeof body.cursors !== "object" || Array.isArray(body.cursors) || Object.keys(body.cursors).length > 1024 || Object.entries(body.cursors).some(([key, value]) => !/^\d+$/.test(key) || typeof value !== "string" || value.length > 512)) throw new Error("Invalid historical cursors");
        cursors = body.cursors as Record<string, string>;
      }
      try {
        const protocol = new AliyunSlsConsumerProtocol({ ...source, consumerId: "historical-read-only" });
        const result = await backfillSls(protocol, new Date(String(body.from)), new Date(String(body.to)), (logs) => runtime.detection.persist(source, logs), cursors);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        const message = errorMessage(error);
        throw new Error(message.startsWith("Historical") || message.startsWith("Invalid historical") ? message : "历史日志补查失败，请检查 SLS 权限和时间范围；已生成任务会保留，重试会去重。");
      }
      return;
    }
    const slsVerify = req.method === "POST" && url.pathname === "/api/sls/verify";
    if (slsVerify) {
      const runtime = await getWebRuntime();
      const body = await readBody(req);
      const projectId = String(body.projectId ?? "");
      const workspaceId = String(body.workspaceId ?? "");
      if (Boolean(projectId) === Boolean(workspaceId)) throw new Error("请先选择 Group Workspace");
      const endpoint = String(body.endpoint ?? "");
      const project = String(body.project ?? "");
      const logstore = String(body.logstore ?? "");
      const consumerGroup = String(body.consumerGroup ?? "");
      const accessKeyId = String(body.accessKeyId ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_ID ?? process.env.SLS_ACCESS_KEY_ID ?? "");
      const accessKeySecret = String(body.accessKeySecret ?? process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET ?? process.env.SLS_ACCESS_KEY_SECRET ?? "");
      const securityToken = String(body.securityToken ?? process.env.ALIBABA_CLOUD_SECURITY_TOKEN ?? process.env.SLS_SECURITY_TOKEN ?? "");
      const config = { endpoint, project, logstore, consumerGroup, accessKeyId, accessKeySecret, ...(securityToken ? { securityToken } : {}) };
      const connection = await runtime.sls.createSls({ userId: runtime.userId, projectId: projectId || undefined, workspaceId: workspaceId || undefined }, config);
      const connectionTest = await runtime.sls.verifyConnection(connection.id, config);
      const now = new Date();
      const readTest = await runtime.sls.verifyRead(connection.id, config, { from: safeDate(body.from, new Date(now.getTime() - 5 * 60_000)), to: safeDate(body.to, now) }, Math.min(100, Math.max(1, Number(body.limit ?? 20))));
      const enabled = connectionTest.status === "passed" && (readTest.status === "passed" || readTest.status === "no_data") ? await runtime.sls.enable(connection.id) : null;
      sendJson(res, 200, { ok: Boolean(enabled), connection, connectionTest, readTest, enabled, message: enabled ? "SLS 连接、读取测试通过，配置已加密保存并启用。" : "SLS 配置已保存，但连接或读取测试未通过。" });
      return;
    }
    const approval = url.pathname.match(/^\/api\/tasks\/([^/]+)\/approve$/);
    const taskDetail = req.method === "GET" && url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskDetail) {
      const runtime = await getWebRuntime();
      const task = await runtime.prisma.investigationTask.findFirst({
        where: { id: decodeURIComponent(taskDetail[1]!), OR: [{ project: { createdByUserId: runtime.userId } }, { workspace: { group: { connection: { userId: runtime.userId } } } }] },
        include: { project: { select: { pathWithNamespace: true } }, workspace: { select: { group: { select: { fullPath: true } } } }, repositories: { select: { project: { select: { pathWithNamespace: true } } } }, errorEvent: { select: { sourceTimestamp: true, logEvidenceJson: true } }, approvals: { select: { decision: true, groupRoleAtApproval: true, approvedAt: true } }, repairRuns: { include: { mergeRequest: true } } },
      });
      if (!task) { sendJson(res, 404, { message: "任务不存在" }); return; }
      sendJson(res, 200, {
        id: task.id,
        project: task.project?.pathWithNamespace ?? task.workspace?.group.fullPath ?? "Group Workspace",
        repositories: task.repositories.map(({ project }) => project.pathWithNamespace),
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
      if (!process.env.GITLAB_OAUTH_CLIENT_ID?.trim()) {
        const redirectUri = process.env.GITLAB_OAUTH_REDIRECT_URI ?? "http://127.0.0.1:5050/api/gitlab/oauth/callback";
        sendJson(res, 503, {
          ok: false,
          code: "GITLAB_OAUTH_NOT_CONFIGURED",
          message: `尚未配置 GitLab OAuth 应用。请在 GitLab 用户设置 → 应用（Applications）注册应用，将 Application ID 配置为服务端 GITLAB_OAUTH_CLIENT_ID，回调地址填写 ${redirectUri}。也可先使用 PAT 连接。`,
          redirectUri,
        });
        return;
      }
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
    if (req.method === "POST" && url.pathname === "/api/workspaces") {
      const runtime = await getWebRuntime();
      const body = await readBody(req);
      const workspace = await runtime.workspaces.create(runtime.userId, String(body.connectionId ?? ""), String(body.groupId ?? ""));
      await runtime.workspaces.synchronize(runtime.userId, workspace.id);
      sendJson(res, 201, { ok: true, workspace, message: "GitLab Group Workspace 已建立，并已同步 Group 与子 Group 的仓库。" });
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
    sendJson(res, statusForError(error), { ok: false, message: url.pathname === "/api/sls/backfill" && !/^(Historical|Invalid historical)/.test(errorMessage(error)) ? "历史补查失败，请检查数据库与 SLS 服务。已生成的任务会保留，重试会按日志位置去重。" : errorMessage(error) });
  }
}

const server = createServer((req, res) => { void handleRequest(req, res); });
server.listen(port, host, () => console.log(`QolmesGPT Web UI listening at http://${host}:${port}`));
const shutdown = () => { void closeWebRuntime().finally(() => server.close()); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

export { server };
