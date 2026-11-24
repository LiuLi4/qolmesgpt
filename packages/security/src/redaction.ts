const sensitiveKey = /token|secret|password|authorization|api[-_]?key|private[-_]?key/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        sensitiveKey.test(key) ? "[REDACTED]" : redact(child),
      ]),
    );
  }
  return value;
}
