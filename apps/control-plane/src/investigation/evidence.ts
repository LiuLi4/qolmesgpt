import { createHash } from "node:crypto";
import { logFields } from "../detection/aggregation.js";
import { Prisma } from "../generated/prisma/client.js";

export interface EvidenceSummary {
  totalLogs: number;
  totalRequests: number;
  requestsWithDiagnosticLogs: number;
  requestsWithoutDiagnosticLogs: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  messageTypes: { message: string; status: string; logs: number; requests: number }[];
  omittedMessageTypes: number;
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function evidenceFields(value: unknown): Record<string, unknown> {
  const entry = object(value);
  return logFields(object(entry.log ?? entry.logEvidenceJson ?? entry));
}
export function completionLog(value: unknown): boolean {
  const fields = evidenceFields(value);
  return /^(?:request completed|request finished|request ended)$/i.test(String(fields.msg ?? fields.message ?? "").trim());
}
function signature(value: unknown): string {
  const f = evidenceFields(value);
  return JSON.stringify([f.service, f.component, f.tenantId ?? f.tenant, f.msg ?? f.message, f.status, f.errorCode ?? object(f.err).code, f.route ?? f.routeTemplate ?? f.path]);
}
export function requestKey(value: unknown): string {
  const entry = object(value); const f = evidenceFields(value);
  const trace = entry.traceId ?? f.traceId ?? f.trace_id;
  const request = entry.requestId ?? f.requestId ?? f.request_id;
  return String(entry.correlationKey || (trace ? `trace:${trace}` : request ? `request:${f.service ?? ""}:${request}` : entry.eventId ?? ""));
}
function time(value: unknown): string {
  const e = object(value); const f = evidenceFields(value);
  const exact = Number(f.time);
  if (Number.isFinite(exact) && exact > 1_000_000_000_000 && Number.isFinite(new Date(exact).getTime())) return new Date(exact).toISOString();
  const d = new Date(String(e.timestamp ?? f._time_ ?? ""));
  if (Number.isFinite(d.getTime())) return d.toISOString();
  const unix = Number(f.__time__);
  return Number.isFinite(unix) && Number.isFinite(new Date(unix * 1000).getTime()) ? new Date(unix * 1000).toISOString() : "";
}

/** First retain one example of each diagnostic signature, then spread remaining budget over requests. */
export function prioritizeEvidence(values: readonly unknown[]): unknown[] {
  const sorted = values.filter((v) => !object(v).contextDiagnostics).slice().sort((a, b) => Number(completionLog(a)) - Number(completionLog(b)) || time(a).localeCompare(time(b)) || String(object(a).eventId ?? "").localeCompare(String(object(b).eventId ?? "")));
  const signatures = new Set<string>(); const requests = new Set<string>();
  const diagnosticRequests = new Set(sorted.filter((v) => !completionLog(v)).map(requestKey).filter(Boolean));
  const first: unknown[] = []; const diagnostic: unknown[] = []; const linked: unknown[] = []; const diverse: unknown[] = []; const rest: unknown[] = [];
  for (const v of sorted) {
    const key = signature(v); const request = requestKey(v);
    if (!signatures.has(key)) { first.push(v); signatures.add(key); requests.add(request); }
    else if (!completionLog(v)) diagnostic.push(v);
    else if (diagnosticRequests.has(request)) linked.push(v);
    else if (request && !requests.has(request)) { diverse.push(v); requests.add(request); }
    else rest.push(v);
  }
  return [...first, ...diagnostic, ...linked, ...diverse, ...rest];
}

const PREFERRED = ["msg", "message", "err", "error", "errorCode", "code", "stack", "type", "name", "status", "method", "route", "routeTemplate", "path", "url", "upstream", "provider", "durationMs", "service", "component", "tenantId", "tenant", "traceId", "requestId", "spanId", "parentSpanId", "time", "__time__"];
function compact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 1000 ? value.slice(0, 1000) + "…[truncated]" : value;
  if (depth > 3) return "[depth limit]";
  if (Array.isArray(value)) return value.slice(0, 10).map((v) => compact(v, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 25).map(([k, v]) => [k, compact(v, depth + 1)]));
  return value;
}

/** Pack complete JSON records; never stop scanning when a single record exceeds the remaining budget. */
export function packInvestigationEvidence(values: readonly unknown[], maxCharacters = 60_000, maxRecords = 200) {
  const records: Record<string, unknown>[] = []; const seen = new Set<string>();
  const omitted = new Map<string, number>(); let size = 2; let duplicateLogs = 0; let compactedLogs = 0;
  for (const value of prioritizeEvidence(values)) {
    const entry = object(value); const fields = evidenceFields(value);
    const evidenceId = String(entry.eventId ?? entry.evidenceId ?? `context:${createHash("sha256").update(JSON.stringify([entry.sourceId, time(value), requestKey(value), fields])).digest("hex").slice(0, 24)}`);
    if (seen.has(evidenceId)) { duplicateLogs++; continue; }
    seen.add(evidenceId);
    const keys = [...new Set([...PREFERRED, ...Object.keys(fields)])].filter((k) => k !== "content" && fields[k] !== undefined);
    const log: Record<string, unknown> = {};
    for (const k of keys.slice(0, 40)) {
      const candidate = { ...log, [k]: compact(fields[k]) };
      if (JSON.stringify(candidate).length <= 5000) log[k] = candidate[k];
    }
    if (typeof fields.content === "string") {
      try { JSON.parse(fields.content); } catch { log.content = compact(fields.content); }
    }
    if (JSON.stringify(log) !== JSON.stringify(fields)) compactedLogs++;
    const record = { evidenceId, sourceId: entry.sourceId, timestamp: time(value), requestKey: requestKey(value), traceId: entry.traceId ?? fields.traceId ?? fields.trace_id, requestId: entry.requestId ?? fields.requestId ?? fields.request_id, log };
    const length = JSON.stringify(record).length + 1;
    if (size + length > maxCharacters || records.length >= maxRecords) {
      const name = String(fields.msg ?? fields.message ?? "unknown").slice(0, 200);
      omitted.set(name, (omitted.get(name) ?? 0) + 1); continue;
    }
    records.push(record); size += length;
  }
  records.sort((a, b) => String(a.requestKey).localeCompare(String(b.requestKey)) || String(a.timestamp).localeCompare(String(b.timestamp)) || String(a.evidenceId).localeCompare(String(b.evidenceId)));
  return {
    records,
    coverage: { inputLogs: values.filter((v) => !object(v).contextDiagnostics).length, includedLogs: records.length, duplicateLogs, compactedLogs, omittedLogs: [...omitted.values()].reduce((a, b) => a + b, 0), omittedTypes: [...omitted].slice(0, 30).map(([message, logs]) => ({ message, logs })), diagnostics: values.filter((v) => object(v).contextDiagnostics).slice(0, 1), note: "Diagnostic logs are candidate evidence, not proven causes. Compacted values and omitted records are not absence of errors." },
  };
}

/** Aggregate in PostgreSQL over every event; only a bounded message-type table leaves the database. */
export async function loadTaskEvidence(tx: Prisma.TransactionClient, taskId: string) {
  const message = Prisma.sql`COALESCE(NULLIF("logEvidenceJson"->>'msg', ''), "logEvidenceJson"#>>'{content,msg}', "logEvidenceJson"->>'message', "logEvidenceJson"#>>'{content,message}', '[unstructured]')`;
  const status = Prisma.sql`COALESCE("logEvidenceJson"->>'status', "logEvidenceJson"#>>'{content,status}', '')`;
  const completion = Prisma.sql`lower(trim(${message})) IN ('request completed','request finished','request ended')`;
  const totals = await tx.$queryRaw<{ totalLogs: number; totalRequests: number; diagnosticRequests: number; first: Date | null; last: Date | null }[]>(Prisma.sql`
    SELECT count(*)::int AS "totalLogs", count(DISTINCT COALESCE("correlationKey",id::text))::int AS "totalRequests",
      count(DISTINCT COALESCE("correlationKey",id::text)) FILTER (WHERE NOT (${completion}))::int AS "diagnosticRequests",
      min("sourceTimestamp") AS first, max("sourceTimestamp") AS last FROM "ErrorEvent" WHERE "taskId" = ${taskId}::uuid`);
  const types = await tx.$queryRaw<{ message: string; status: string; logs: number; requests: number; totalTypes: number }[]>(Prisma.sql`
    SELECT left(${message},512) AS message, ${status} AS status, count(*)::int AS logs,
      count(DISTINCT COALESCE("correlationKey",id::text))::int AS requests, count(*) OVER()::int AS "totalTypes"
    FROM "ErrorEvent" WHERE "taskId" = ${taskId}::uuid GROUP BY left(${message},512), ${status}
    ORDER BY count(*) DESC, message, status LIMIT 200`);
  const events = await tx.$queryRaw<{ id: string; dataSourceConnectionId: string; sourceTimestamp: Date; correlationKey: string | null; traceId: string | null; requestId: string | null; logEvidenceJson: Prisma.JsonValue }[]>(Prisma.sql`
    SELECT id, "dataSourceConnectionId", "sourceTimestamp", "correlationKey", "traceId", "requestId", "logEvidenceJson" FROM (
      SELECT *, row_number() OVER (PARTITION BY fingerprint, ${message}, ${status} ORDER BY "sourceTimestamp", id) AS ordinal,
        row_number() OVER (PARTITION BY fingerprint, ${message}, ${status} ORDER BY "sourceTimestamp" DESC, id DESC) AS latest,
        CASE WHEN ${completion} THEN 1 ELSE 0 END AS completion
      FROM "ErrorEvent" WHERE "taskId" = ${taskId}::uuid
    ) ranked ORDER BY completion, CASE WHEN ordinal=1 OR latest=1 THEN 0 ELSE 1 END, ordinal, "sourceTimestamp", id LIMIT 200`);
  const total = totals[0]!;
  const summary: EvidenceSummary = { totalLogs: total.totalLogs, totalRequests: total.totalRequests, requestsWithDiagnosticLogs: total.diagnosticRequests, requestsWithoutDiagnosticLogs: total.totalRequests - total.diagnosticRequests, firstSeenAt: total.first?.toISOString() ?? null, lastSeenAt: total.last?.toISOString() ?? null, messageTypes: types.map(({ message, status, logs, requests }) => ({ message, status, logs, requests })), omittedMessageTypes: Math.max(0, (types[0]?.totalTypes ?? 0) - types.length) };
  return { summary, logs: events.map((e) => ({ eventId: e.id, sourceId: e.dataSourceConnectionId, timestamp: e.sourceTimestamp.toISOString(), correlationKey: e.correlationKey, traceId: e.traceId, requestId: e.requestId, log: e.logEvidenceJson })) as unknown as Prisma.JsonValue[] };
}
