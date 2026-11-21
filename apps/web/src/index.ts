import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { page } from "./ui.js";

const port = Number(process.env.PORT ?? 5050);
const host = process.env.HOST ?? "127.0.0.1";

type Task = { id: string; project: string; title: string; status: string; statusLabel: string; updatedAt: string; file: string };
const tasks: Task[] = [
  { id: "TASK-1048", project: "ec-saas", title: "domain 请求偶发 5xx，调查请求链路与日志异常", status: "AWAITING_APPROVAL", statusLabel: "待审批", updatedAt: "2 分钟前", file: "src/domain/handler.ts" },
  { id: "TASK-1047", project: "checkout-service", title: "支付回调超时导致重试堆积", status: "INVESTIGATING", statusLabel: "调查中", updatedAt: "18 分钟前", file: "src/callback/retry.ts" },
  { id: "TASK-1041", project: "ec-saas", title: "staging 日志字段解析失败", status: "FAILED", statusLabel: "需重试", updatedAt: "昨天", file: "src/log/decoder.ts" },
];

const state = {
  projects: [
    { name: "ec-saas", repository: "gitlab.example.com/platform/ec-saas", workspace: "/workspaces/ec-saas", detection: "SLS staging", status: "healthy", health: 92 },
    { name: "checkout-service", repository: "gitlab.example.com/platform/checkout-service", workspace: "/workspaces/checkout-service", detection: "SLS staging", status: "healthy", health: 86 },
  ],
  sources: [{ name: "Aliyun SLS", project: "pyxis-telemetry-log", logstore: "pyxis-trace-staging", region: "cn-shanghai", status: "connected" }],
  tasks,
  errorCount: 14,
};

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { return {}; }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, service: "qolmesgpt-web", mode: "demo", timestamp: new Date().toISOString() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, state);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/sls/verify") {
    const body = await readBody(req);
    const project = String(body.project ?? "pyxis-telemetry-log");
    const logstore = String(body.logstore ?? "pyxis-trace-staging");
    const endpoint = String(body.endpoint ?? "https://cn-shanghai.log.aliyuncs.com");
    const ok = project === "pyxis-telemetry-log" && logstore === "pyxis-trace-staging" && endpoint.includes("cn-shanghai");
    sendJson(res, 200, { ok, message: ok ? `已成功读取 ${project}/${logstore}，Consumer Group heartbeat 正常。` : "配置未匹配 staging SLS，请检查 Project、Logstore 和 Endpoint。" });
    return;
  }
  const approval = url.pathname.match(/^\/api\/tasks\/([^/]+)\/approve$/);
  if (req.method === "POST" && approval) {
    const task = tasks.find((item) => item.id === decodeURIComponent(approval[1]));
    if (!task) { sendJson(res, 404, { message: "任务不存在" }); return; }
    task.status = "APPROVED"; task.statusLabel = "已批准"; task.updatedAt = "刚刚";
    sendJson(res, 200, { ok: true, message: `${task.id} 已批准，Repair Worker 将创建 Merge Request。` });
    return;
  }
  sendJson(res, 404, { detail: "Not Found" });
});

server.listen(port, host, () => console.log(`QolmesGPT Web UI listening at http://${host}:${port}`));

export { server };
