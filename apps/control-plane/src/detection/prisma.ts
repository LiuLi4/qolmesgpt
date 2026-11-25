import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { decryptSecret, redact, type KeyProvider } from "@qolmesgpt/security";
import { parseEncryptedSecret } from "../integrations/gitlab/types.js";
import { classifySlsError } from "../integrations/sls/classifier.js";
import { aggregationIdentity, REQUEST_WINDOW_MS, AGGREGATION_DELAY_MS } from "./aggregation.js";

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

export function evidence(record: Readonly<Record<string, unknown>>, secrets: readonly string[]): Prisma.InputJsonValue {
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

type Scope = { projectId: string | null; workspaceId?: string | null };
type Group = { id: string; status: string; createdAt: Date };
async function lockScope(tx: Prisma.TransactionClient, scope: Scope): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`investigation:${scope.workspaceId ?? scope.projectId}`}, 0))`;
}
async function findGroup(tx: Prisma.TransactionClient, scope: Scope, identity: { fingerprint: string; correlationKey: string | null }, timestamp: Date, exclude?: string): Promise<Group | null> {
  const base = {
    ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : { projectId: scope.projectId, workspaceId: null }),
    ...(exclude ? { id: { not: exclude } } : {}), mergedIntoTaskId: null,
    status: { in: ["INVESTIGATION_PENDING", "INVESTIGATING", "AWAITING_APPROVAL"] as ("INVESTIGATION_PENDING" | "INVESTIGATING" | "AWAITING_APPROVAL")[] },
    approvals: { none: {} }, repairRuns: { none: {} },
  };
  for (const mode of ["request", "fingerprint"] as const) {
    if (mode === "request" && !identity.correlationKey) continue;
    const group = await tx.investigationTask.findFirst({ where: {
      ...base,
      ...(mode === "request" ? {
        firstSeenAt: { gte: new Date(timestamp.getTime() - REQUEST_WINDOW_MS) },
        lastSeenAt: { lte: new Date(timestamp.getTime() + REQUEST_WINDOW_MS) },
      } : {}),
      events: { some: mode === "request" ? { correlationKey: identity.correlationKey } : { fingerprint: identity.fingerprint } },
    }, orderBy: { createdAt: "asc" }, select: { id: true, status: true, createdAt: true } });
    if (group) {
      await tx.$queryRaw`SELECT id FROM "InvestigationTask" WHERE id = ${group.id}::uuid FOR UPDATE`;
      const eligible = await tx.investigationTask.findFirst({ where: { ...base, id: group.id }, select: { id: true, status: true, createdAt: true } });
      if (eligible) return eligible;
    }
  }
  return null;
}
async function enqueue(tx: Prisma.TransactionClient, taskId: string, availableAt: Date) {
  await tx.outboxMessage.create({ data: { aggregateType: "InvestigationTask", aggregateId: taskId, eventType: "InvestigationRequested", payload: { taskId }, availableAt } });
}
async function refreshGroup(tx: Prisma.TransactionClient, group: Group): Promise<void> {
  const rows = await tx.$queryRaw<{ count: number; requests: number; first: Date; last: Date }[]>`
    SELECT count(*)::int AS count, count(DISTINCT COALESCE("correlationKey", id::text))::int AS requests,
    min("sourceTimestamp") AS first, max("sourceTimestamp") AS last FROM "ErrorEvent" WHERE "taskId" = ${group.id}::uuid`;
  const stats = rows[0]!;
  const reopen = group.status === "AWAITING_APPROVAL";
  await tx.investigationTask.update({ where: { id: group.id }, data: {
    firstSeenAt: stats.first, lastSeenAt: stats.last, occurrenceCount: stats.count, requestCount: stats.requests,
    evidenceVersion: { increment: 1 }, ...(reopen ? { status: "INVESTIGATION_PENDING", investigationResultJson: Prisma.DbNull, analyzedVersion: 0 } : {}),
  } });
  const availableAt = new Date(Math.min(Date.now() + AGGREGATION_DELAY_MS, group.createdAt.getTime() + 60_000));
  if (reopen) await enqueue(tx, group.id, availableAt);
  else await tx.outboxMessage.updateMany({ where: { aggregateId: group.id, eventType: "InvestigationRequested", claimedAt: null }, data: { availableAt } });
}

export class PrismaSlsDetectionStore {
  constructor(private readonly prisma: PrismaClient, private readonly keys: KeyProvider) {}

  async claim(connectionId: string, consumerGroup: string, workerId: string): Promise<boolean> {
    await this.prisma.sLSConsumerState.createMany({ data: [{ connectionId, consumerGroup, status: "STOPPED" }], skipDuplicates: true });
    const now = new Date();
    const claimed = await this.prisma.sLSConsumerState.updateMany({
      where: {
        connectionId,
        connection: { status: "ENABLED", OR: [{ workspaceId: null }, { workspace: { automationEnabled: true } }] },
        OR: [{ workerId, leaseExpiresAt: { gt: now } }, { workerId: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: { consumerGroup, workerId, status: "STARTING", leaseExpiresAt: new Date(now.getTime() + 30_000) },
    });
    return claimed.count === 1;
  }

  async renew(connectionId: string, workerId: string): Promise<boolean> {
    const now = new Date();
    const renewed = await this.prisma.sLSConsumerState.updateMany({
      where: { connectionId, workerId, leaseExpiresAt: { gt: now }, connection: { status: "ENABLED", OR: [{ workspaceId: null }, { workspace: { automationEnabled: true } }] } },
      data: { leaseExpiresAt: new Date(now.getTime() + 30_000) },
    });
    return renewed.count === 1;
  }

  async listEnabled(connectionId?: string): Promise<EnabledSlsSource[]> {
    const connections = await this.prisma.dataSourceConnection.findMany({
      where: { status: "ENABLED", type: "ALIYUN_SLS", OR: [{ workspaceId: null }, { workspace: { automationEnabled: true } }], ...(connectionId ? { id: connectionId } : {}) },
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
    for (const log of matches) {
      created += await this.prisma.$transaction(async (tx) => {
        await lockScope(tx, source);
        const actual = await tx.dataSourceConnection.findUniqueOrThrow({ where: { id: source.id }, select: { projectId: true, workspaceId: true } });
        if (actual.projectId !== source.projectId || (actual.workspaceId ?? null) !== (source.workspaceId ?? null)) throw new Error("SLS source scope mismatch");
        const existing = await tx.errorEvent.findUnique({ where: { dataSourceConnectionId_sourcePositionKey: { dataSourceConnectionId: source.id, sourcePositionKey: log.sourcePositionKey } }, select: { id: true } });
        if (existing) return 0;
        const sourceDate = sourceTimestamp(log.record);
        const identity = aggregationIdentity(log.record);
        const event = await tx.errorEvent.create({ data: {
          dataSourceConnectionId: source.id, sourcePositionKey: log.sourcePositionKey, sourceTimestamp: sourceDate,
          logEvidenceJson: evidence(log.record, [source.accessKeyId ?? "", source.accessKeySecret ?? "", source.securityToken ?? ""]),
          ...identity,
        } });
        const candidate = await findGroup(tx, source, identity, sourceDate);
        if (candidate) {
          await tx.errorEvent.update({ where: { id: event.id }, data: { taskId: candidate.id } });
          await refreshGroup(tx, candidate);
          return 0;
        }
        const task = await tx.investigationTask.create({ data: {
          projectId: source.projectId, workspaceId: source.workspaceId ?? null, errorEventId: event.id,
          status: "INVESTIGATION_PENDING", priority: "HIGH", firstSeenAt: sourceDate, lastSeenAt: sourceDate,
        } });
        await tx.errorEvent.update({ where: { id: event.id }, data: { taskId: task.id } });
        await enqueue(tx, task.id, new Date(Date.now() + AGGREGATION_DELAY_MS));
        return 1;
      }, { timeout: 30_000 });
    }
    return created;
  }

  /** Reconcile duplicates without deleting evidence; historical completed investigations require explicit opt-in. */
  async reconcilePending(includeAwaitingApproval = false): Promise<number> {
    const statuses = includeAwaitingApproval ? ["INVESTIGATION_PENDING", "AWAITING_APPROVAL"] as const : ["INVESTIGATION_PENDING"] as const;
    const tasks = await this.prisma.investigationTask.findMany({ where: { status: { in: [...statuses] }, mergedIntoTaskId: null, approvals: { none: {} }, repairRuns: { none: {} } }, orderBy: { createdAt: "asc" }, take: 10_000, select: { id: true, projectId: true, workspaceId: true } });
    let merged = 0;
    for (const task of tasks) {
      merged += await this.prisma.$transaction(async (tx) => {
        await lockScope(tx, task);
        const current = await tx.investigationTask.findUniqueOrThrow({ where: { id: task.id }, include: { events: true, approvals: true, repairRuns: true } });
        if (!statuses.some((status) => status === current.status) || current.mergedIntoTaskId || current.approvals.length || current.repairRuns.length) return 0;
        await tx.$queryRaw`SELECT id FROM "InvestigationTask" WHERE id = ${current.id}::uuid FOR UPDATE`;
        const eligible = await tx.investigationTask.findFirst({ where: { id: current.id, status: { in: [...statuses] }, mergedIntoTaskId: null, approvals: { none: {} }, repairRuns: { none: {} } } });
        if (!eligible) return 0;
        for (const event of current.events) {
          const identity = aggregationIdentity(object(event.logEvidenceJson));
          await tx.errorEvent.update({ where: { id: event.id }, data: identity });
        }
        const anchor = await tx.errorEvent.findUniqueOrThrow({ where: { id: current.errorEventId } });
        const candidate = await findGroup(tx, task, anchor, anchor.sourceTimestamp, task.id);
        if (!candidate || candidate.createdAt > current.createdAt) return 0;
        await tx.errorEvent.updateMany({ where: { taskId: task.id }, data: { taskId: candidate.id } });
        await tx.outboxMessage.deleteMany({ where: { aggregateId: task.id, eventType: "InvestigationRequested" } });
        await tx.investigationTask.update({ where: { id: task.id }, data: { mergedIntoTaskId: candidate.id, status: "CLOSED" } });
        await refreshGroup(tx, candidate);
        return 1;
      }, { timeout: 30_000 });
    }
    return merged;
  }

  async recordBatch(source: EnabledSlsSource, logs: readonly DetectionLog[], created: number, workerId: string): Promise<void> {
    if (!logs.length) return;
    const current = await this.prisma.sLSConsumerState.findUnique({ where: { connectionId: source.id } });
    const summary = object(current?.checkpointSummary);
    const recentLogs = logs.slice(-5).map(({ record }) => evidence(record, [source.accessKeyId, source.accessKeySecret, source.securityToken ?? ""]));
    const result = await this.prisma.sLSConsumerState.updateMany({
      where: { connectionId: source.id, workerId, leaseExpiresAt: { gt: new Date() }, connection: { status: "ENABLED", OR: [{ workspaceId: null }, { workspace: { automationEnabled: true } }] } },
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
      where: { connectionId, workerId, leaseExpiresAt: { gt: new Date() }, connection: { status: "ENABLED", OR: [{ workspaceId: null }, { workspace: { automationEnabled: true } }] } },
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
