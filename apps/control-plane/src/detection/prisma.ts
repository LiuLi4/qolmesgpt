import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { decryptSecret, redact, type KeyProvider } from "@qolmesgpt/security";
import { parseEncryptedSecret } from "../integrations/gitlab/types.js";
import { classifySlsError } from "../integrations/sls/classifier.js";

export interface DetectionLog {
  readonly sourcePositionKey: string;
  readonly record: Readonly<Record<string, string | number>>;
}

export interface EnabledSlsSource {
  readonly id: string;
  readonly revision: number;
  readonly enabledAt: Date;
  readonly projectId: string | null;
  readonly workspaceId?: string | null;
  readonly endpoint: string;
  readonly project: string;
  readonly logstore: string;
  readonly consumerGroup: string;
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly securityToken?: string;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing SLS ${field}`);
  return value;
}

function redactText(value: string, secrets: readonly string[]): string {
  let safe = value;
  for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, "[REDACTED]");
  return safe
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]")
    .replace(/\b((?:accessKeySecret|access_key_secret|api[_-]?key|token|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/gi, "$1[REDACTED]");
}

function sanitize(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, secrets)]));
  return value;
}

function evidence(record: Readonly<Record<string, string | number>>, secrets: readonly string[]): Prisma.InputJsonValue {
  const bounded = Object.fromEntries(Object.entries(record).slice(0, 100).map(([key, value]) => {
    const text = typeof value === "string" ? value.slice(0, 4_096) : value;
    if (key !== "content" || typeof value !== "string") return [key, text];
    if (value.length > 4_096) return [key, "[TRUNCATED]"];
    try {
      return [key, JSON.parse(value) as unknown];
    } catch {
      return [key, text];
    }
  }));
  const safe = object(sanitize(redact(bounded), secrets));
  const limited: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(safe)) {
    const candidate = { ...limited, [key]: value };
    if (JSON.stringify(candidate).length <= 8_192) limited[key] = value;
  }
  return JSON.parse(JSON.stringify(limited)) as Prisma.InputJsonValue;
}

function sourceTimestamp(record: Readonly<Record<string, string | number>>): Date {
  const seconds = Number(record.__time__);
  const date = new Date(seconds * 1_000);
  if (!Number.isFinite(seconds) || Number.isNaN(date.valueOf())) throw new Error("SLS log has no valid source timestamp");
  return date;
}

export class PrismaSlsDetectionStore {
  constructor(private readonly prisma: PrismaClient, private readonly keys: KeyProvider) {}

  async claim(connectionId: string, consumerGroup: string, workerId: string): Promise<boolean> {
    await this.prisma.sLSConsumerState.createMany({ data: [{ connectionId, consumerGroup, status: "STOPPED" }], skipDuplicates: true });
    const now = new Date();
    const claimed = await this.prisma.sLSConsumerState.updateMany({
      where: {
        connectionId,
        connection: { status: "ENABLED" },
        OR: [{ workerId, leaseExpiresAt: { gt: now } }, { workerId: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: { consumerGroup, workerId, status: "STARTING", leaseExpiresAt: new Date(now.getTime() + 30_000) },
    });
    return claimed.count === 1;
  }

  async renew(connectionId: string, workerId: string): Promise<boolean> {
    const now = new Date();
    const renewed = await this.prisma.sLSConsumerState.updateMany({
      where: { connectionId, workerId, leaseExpiresAt: { gt: now }, connection: { status: "ENABLED" } },
      data: { leaseExpiresAt: new Date(now.getTime() + 30_000) },
    });
    return renewed.count === 1;
  }

  async listEnabled(connectionId?: string): Promise<EnabledSlsSource[]> {
    const connections = await this.prisma.dataSourceConnection.findMany({
      where: { status: "ENABLED", type: "ALIYUN_SLS", ...(connectionId ? { id: connectionId } : {}) },
      select: { id: true, projectId: true, workspaceId: true, configJson: true, credentialsCiphertext: true, updatedAt: true, enabledAt: true },
    });
    const enabled: EnabledSlsSource[] = [];
    for (const connection of connections) {
      try {
        const settings = object(connection.configJson);
        const secrets = object(JSON.parse(decryptSecret(parseEncryptedSecret(connection.credentialsCiphertext), this.keys)) as unknown);
        enabled.push({
          id: connection.id,
          revision: connection.updatedAt.getTime(),
          enabledAt: connection.enabledAt ?? connection.updatedAt,
          projectId: connection.projectId,
          workspaceId: connection.workspaceId,
          endpoint: requiredString(settings.endpoint, "endpoint"),
          project: requiredString(settings.project, "project"),
          logstore: requiredString(settings.logstore, "logstore"),
          consumerGroup: typeof settings.consumerGroup === "string" && settings.consumerGroup.trim() ? settings.consumerGroup.trim() : `qolmesgpt-${connection.id}`,
          accessKeyId: requiredString(secrets.accessKeyId, "access key ID"),
          accessKeySecret: requiredString(secrets.accessKeySecret, "access key secret"),
          ...(typeof secrets.securityToken === "string" && secrets.securityToken ? { securityToken: secrets.securityToken } : {}),
        });
      } catch {
        await this.prisma.sLSConsumerState.upsert({
          where: { connectionId: connection.id },
          create: { connectionId: connection.id, consumerGroup: `qolmesgpt-${connection.id}`, status: "FAILED", checkpointSummary: { lagging: true, errorCode: "INVALID_CREDENTIAL_CONFIG" } },
          update: { status: "FAILED", checkpointSummary: { lagging: true, errorCode: "INVALID_CREDENTIAL_CONFIG" }, shardAssignments: [] },
        });
      }
    }
    return enabled;
  }

  async persist(source: Pick<EnabledSlsSource, "id" | "projectId"> & Partial<Pick<EnabledSlsSource, "workspaceId" | "accessKeyId" | "accessKeySecret" | "securityToken">>, logs: readonly DetectionLog[], workerId?: string): Promise<number> {
    if (workerId && !(await this.renew(source.id, workerId))) throw new Error("SLS worker lost its connection lease");
    const matches = [...new Map(logs
      .filter(({ record }) => classifySlsError(record).isError)
      .map((log) => [requiredString(log.sourcePositionKey, "source position"), log])).values()];
    if (!matches.length) return 0;
    let created = 0;
    for (let offset = 0; offset < matches.length; offset += 100) {
      const chunk = matches.slice(offset, offset + 100);
      created += await this.prisma.$transaction(async (tx) => {
        const events = await tx.errorEvent.createManyAndReturn({
          data: chunk.map((log) => ({
            dataSourceConnectionId: source.id,
            sourcePositionKey: log.sourcePositionKey,
            sourceTimestamp: sourceTimestamp(log.record),
            logEvidenceJson: evidence(log.record, [source.accessKeyId ?? "", source.accessKeySecret ?? "", source.securityToken ?? ""]),
            fingerprint: createHash("sha256").update([
              log.record.service ?? "",
              log.record.component ?? "",
              log.record.msg ?? log.record.message ?? log.record.content ?? "",
            ].join("\n")).digest("hex"),
          })),
          skipDuplicates: true,
          select: { id: true },
        });
        if (!events.length) return 0;
        const tasks = await tx.investigationTask.createManyAndReturn({
          data: events.map((event) => ({
            projectId: source.projectId,
            workspaceId: source.workspaceId ?? null,
            errorEventId: event.id,
            status: "INVESTIGATION_PENDING",
            priority: "HIGH",
          })),
          select: { id: true },
        });
        await tx.outboxMessage.createMany({
          data: tasks.map((task) => ({
            aggregateType: "InvestigationTask",
            aggregateId: task.id,
            eventType: "InvestigationRequested",
            payload: { taskId: task.id, projectId: source.projectId, workspaceId: source.workspaceId ?? null, connectionId: source.id },
          })),
        });
        return tasks.length;
      }, { timeout: 30_000 });
    }
    return created;
  }

  async recordBatch(source: EnabledSlsSource, logs: readonly DetectionLog[], created: number, workerId: string): Promise<void> {
    if (!logs.length) return;
    const current = await this.prisma.sLSConsumerState.findUnique({ where: { connectionId: source.id } });
    const summary = object(current?.checkpointSummary);
    const recentLogs = logs.slice(-5).map(({ record }) => evidence(record, [source.accessKeyId, source.accessKeySecret, source.securityToken ?? ""]));
    const result = await this.prisma.sLSConsumerState.updateMany({
      where: { connectionId: source.id, workerId, leaseExpiresAt: { gt: new Date() }, connection: { status: "ENABLED" } },
      data: { checkpointSummary: {
        ...summary as Prisma.InputJsonObject,
        logsConsumed: Number(summary.logsConsumed ?? 0) + logs.length,
        tasksCreated: Number(summary.tasksCreated ?? 0) + created,
        lastLogAt: new Date(Math.max(...logs.map((log) => sourceTimestamp(log.record).getTime()))).toISOString(),
        recentLogs,
      } },
    });
    if (result.count !== 1) throw new Error("SLS worker lost its connection lease");
  }

  async setState(connectionId: string, consumerGroup: string, workerId: string, status: "STARTING" | "RUNNING" | "DEGRADED" | "STOPPED" | "FAILED", assignments: readonly number[], summary: Record<string, string | number | boolean | null>): Promise<void> {
    const previous = object((await this.prisma.sLSConsumerState.findUnique({ where: { connectionId } }))?.checkpointSummary);
    const metrics = Object.fromEntries(["logsConsumed", "tasksCreated", "lastLogAt", "recentLogs"].filter((key) => key in previous).map((key) => [key, previous[key]])) as Prisma.InputJsonObject;
    const result = await this.prisma.sLSConsumerState.updateMany({
      where: { connectionId, workerId, leaseExpiresAt: { gt: new Date() }, connection: { status: "ENABLED" } },
      data: { consumerGroup, status, shardAssignments: [...assignments], checkpointSummary: { ...metrics, ...summary }, ...(status === "RUNNING" ? { lastHeartbeatAt: new Date() } : {}) },
    });
    if (result.count !== 1) throw new Error("SLS worker lost its connection lease");
  }

  async release(connectionId: string, workerId: string): Promise<void> {
    await this.prisma.sLSConsumerState.updateMany({
      where: { connectionId, workerId, status: { not: "FAILED" } },
      data: { workerId: null, leaseExpiresAt: null, status: "STOPPED", shardAssignments: [] },
    });
  }
}
