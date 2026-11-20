import type { DataSourceConnectionTestResult, DataSourceReadTestResult, BoundedRange } from "@qolmesgpt/contracts";
import { aliyunSlsClientFactory } from "./client.js";
import type { SlsAdapter, SlsClientFactory, SlsConfig, SlsLogRecord } from "./types.js";

const MAX_LIMIT = 100;
const MAX_RANGE_MS = 15 * 60_000;

function validateConfig(config: SlsConfig): void {
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new Error("SLS endpoint must be an absolute HTTPS URL");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("SLS endpoint must be an absolute HTTPS URL without credentials or query parameters");
  for (const [name, value] of [["project", config.project], ["logstore", config.logstore], ["accessKeyId", config.accessKeyId], ["accessKeySecret", config.accessKeySecret]] as const) {
    if (!value.trim()) throw new Error(`SLS ${name} is required`);
  }
}

function validateRange(range: BoundedRange, limit: number): void {
  if (!(range.from instanceof Date) || !(range.to instanceof Date) || !Number.isFinite(range.from.getTime()) || !Number.isFinite(range.to.getTime()) || range.to <= range.from) throw new Error("SLS read range must be a valid positive interval");
  if (range.to.getTime() - range.from.getTime() > MAX_RANGE_MS) throw new Error("SLS read range cannot exceed 15 minutes");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`SLS read limit must be between 1 and ${MAX_LIMIT}`);
}

function recordsFromResponse(value: unknown): SlsLogRecord[] {
  if (Array.isArray(value)) return value.filter((record): record is SlsLogRecord => Boolean(record && typeof record === "object"));
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  for (const key of ["logs", "data", "records", "body"]) {
    if (Array.isArray(object[key])) return recordsFromResponse(object[key]);
  }
  return [];
}

function safeError(error: unknown): { errorCode: string; message: string } {
  const candidate = error as { code?: unknown; statusCode?: unknown; message?: unknown };
  const errorCode = typeof candidate?.code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(candidate.code)
    ? candidate.code
    : typeof candidate?.statusCode === "number" ? `HTTP_${candidate.statusCode}` : "SLS_REQUEST_FAILED";
  return { errorCode, message: "SLS request failed" };
}

export class AliyunSlsAdapter implements SlsAdapter {
  constructor(private readonly clientFactory: SlsClientFactory = aliyunSlsClientFactory) {}

  async validate(config: SlsConfig): Promise<DataSourceConnectionTestResult> {
    try {
      validateConfig(config);
      const client = this.clientFactory.create(config);
      await client.getProject(config.project);
      await client.getLogStore(config.project, config.logstore);
      return { status: "passed", safeSummary: { endpoint: config.endpoint, project: config.project, logstore: config.logstore, credentialsConfigured: true } };
    } catch (error) {
      const failure = safeError(error);
      return { status: "failed", errorCode: failure.errorCode, safeSummary: { credentialsConfigured: Boolean(config.accessKeyId && config.accessKeySecret), message: failure.message } };
    }
  }

  async readSample(config: SlsConfig, range: BoundedRange, limit: number): Promise<DataSourceReadTestResult<SlsLogRecord>> {
    return this.search(config, "*", range, limit);
  }

  async search(config: SlsConfig, query: string, range: BoundedRange, limit: number): Promise<DataSourceReadTestResult<SlsLogRecord>> {
    try {
      validateConfig(config);
      validateRange(range, limit);
      const result = await this.clientFactory.create(config).getLogs(config.project, config.logstore, range.from, range.to, { query, line: limit, offset: 0, reverse: true });
      const records = recordsFromResponse(result).slice(0, limit);
      return { status: records.length ? "passed" : "no_data", records, safeSummary: { endpoint: config.endpoint, project: config.project, logstore: config.logstore, count: records.length, limit } };
    } catch (error) {
      const failure = safeError(error);
      return { status: "failed", records: [], errorCode: failure.errorCode, safeSummary: { message: failure.message, count: 0, limit } };
    }
  }
}
