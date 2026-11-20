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

export function classifySlsError(record: SlsLogRecord): SlsErrorClassification {
  const level = numberValue(record.level);
  if (level !== null && level >= 50) return { isError: true, reason: "level" };
  const status = numberValue(record.status);
  if (status !== null && status >= 500) return { isError: true, reason: "status" };
  const text = [record.msg, record.message, record.content]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (/\b(error|exception|fatal|panic|failed|failure)\b/.test(text)) return { isError: true, reason: "keyword" };
  return { isError: false, reason: "none" };
}
