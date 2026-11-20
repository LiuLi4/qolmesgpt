import type { SlsLogRecord } from "./types.js";

export interface SlsErrorClassification {
  readonly isError: boolean;
  readonly reason: "level" | "status" | "keyword" | "none";
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function contentText(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof value === "string") return [value.slice(0, 4_096)];
  if (Array.isArray(value)) return value.slice(0, 20).flatMap((item) => contentText(item, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.values(value).slice(0, 40).flatMap((item) => contentText(item, depth + 1));
  }
  return [];
}

export function classifySlsError(record: SlsLogRecord): SlsErrorClassification {
  let content: Record<string, unknown> = {};
  if (typeof record.content === "string") {
    try {
      const parsed: unknown = JSON.parse(record.content);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) content = parsed as Record<string, unknown>;
    } catch {
      // Plain-text content remains available for keyword matching.
    }
  }
  const level = numberValue(record.level ?? content.level);
  if (level !== null && level >= 50) return { isError: true, reason: "level" };
  const status = numberValue(record.status ?? content.status);
  if (status !== null && status >= 500) return { isError: true, reason: "status" };
  const values = Object.keys(content).length ? contentText(content) : [record.content];
  const text = [record.msg, record.message, ...values]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (/\b(error|exception|fatal|panic|failed|failure|timeout)\b/.test(text)) return { isError: true, reason: "keyword" };
  return { isError: false, reason: "none" };
}
