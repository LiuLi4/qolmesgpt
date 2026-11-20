export function redactSecret(value: string): string {
  if (value.length <= 8) return "[REDACTED]";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export * from "./encryption.js";
export * from "./redaction.js";
export * from "./execution.js";
