import { createHash } from "node:crypto";

export const FINGERPRINT_WINDOW_MS = 15 * 60_000;
export const REQUEST_WINDOW_MS = 60 * 60_000;
export const AGGREGATION_DELAY_MS = 10_000;

export function logFields(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  let content: Record<string, unknown> = {};
  try {
    const parsed: unknown = typeof record.content === "string" ? JSON.parse(record.content) : record.content;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) content = parsed as Record<string, unknown>;
  } catch { /* Plain text logs have no structured payload. */ }
  return { ...content, ...record };
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(value) && !/^0+$/.test(value) ? value : null;
}

export function normalizeErrorMessage(message: string): string {
  return message.slice(0, 4_096)
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<id>")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.+Z-]+/g, "<time>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ").trim();
}

export function aggregationIdentity(record: Readonly<Record<string, unknown>>) {
  const fields = logFields(record);
  const traceId = identifier(fields.traceId ?? fields.trace_id);
  const requestId = identifier(fields.requestId ?? fields.request_id);
  const service = String(fields.service ?? "");
  const component = String(fields.component ?? "");
  const error = fields.err ?? fields.error;
  const detail = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const message = String(detail.message ?? fields.msg ?? fields.message ?? (typeof record.content === "string" ? record.content : "unknown error"));
  // Preserve exception type, status and route; only volatile identifiers/numbers in the message are normalized.
  const fingerprint = createHash("sha256").update(JSON.stringify([
    service, component, detail.type ?? detail.name ?? fields.errorType ?? "", fields.status ?? "",
    fields.method ?? "", fields.route ?? fields.routeTemplate ?? "", normalizeErrorMessage(message),
  ])).digest("hex");
  return { traceId, requestId, fingerprint, correlationKey: traceId ? `trace:${traceId}` : requestId ? `request:${service}:${requestId}` : null };
}
