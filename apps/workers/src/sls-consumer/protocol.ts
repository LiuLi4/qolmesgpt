import { createHash, createHmac } from "node:crypto";
import protobuf from "protobufjs";

export interface SlsConsumerConfig {
  readonly endpoint: string;
  readonly project: string;
  readonly logstore: string;
  readonly consumerGroup: string;
  readonly consumerId: string;
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly securityToken?: string;
}

export interface SlsShardCheckpoint {
  readonly shard: number;
  readonly checkpoint: string;
  readonly consumer?: string;
}

export interface SlsPulledLog {
  readonly record: Readonly<Record<string, string | number>>;
  readonly sourcePositionKey: string;
}

export interface SlsPulledBatch {
  readonly logs: readonly SlsPulledLog[];
  readonly nextCursor: string;
  readonly logGroupCount: number;
}

const logProto = protobuf.parse(`
syntax = "proto2";
package sls;
message Log {
  required uint32 Time = 1;
  message Content { required string Key = 1; required string Value = 2; }
  repeated Content Contents = 2;
  optional fixed32 TimeNs = 4;
}
message LogTag { required string Key = 1; required string Value = 2; }
message LogGroup {
  repeated Log Logs = 1;
  optional string Reserved = 2;
  optional string Topic = 3;
  optional string Source = 4;
  repeated LogTag LogTags = 6;
}
message LogGroupList { repeated LogGroup logGroupList = 1; }
`).root.lookupType("sls.LogGroupList");

const DEFAULT_PULL_COUNT = 1000;
const MAX_PULL_COUNT = 1000;
const REQUEST_TIMEOUT_MS = 15_000;

function assertSegment(value: string, label: string): void {
  if (!value.trim() || value === "." || value === ".." || /[/?#\s]/.test(value)) throw new Error(`SLS ${label} is invalid`);
}

function normalizeEndpoint(endpoint: string, project: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("SLS endpoint must be an absolute HTTPS URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("SLS endpoint must be an HTTPS origin without credentials, port, path, or query");
  }
  parsed.hostname = `${project}.${parsed.hostname}`;
  return parsed;
}

function canonicalResource(path: string, query: Readonly<Record<string, string>>): string {
  const fields = Object.keys(query).sort().map((key) => `${key}=${query[key]}`);
  return fields.length ? `${path}?${fields.join("&")}` : path;
}

function canonicalHeaders(headers: Readonly<Record<string, string>>): string {
  return Object.keys(headers)
    .filter((key) => key.startsWith("x-log-") || key.startsWith("x-acs-"))
    .sort()
    .map((key) => `${key}:${headers[key]?.trim() ?? ""}\n`)
    .join("");
}

function encodeQuery(query: Readonly<Record<string, string>>): string {
  return Object.entries(query).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function extractArray(value: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(value)) return value;
  const record = object(value);
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as unknown[];
  return [];
}

function parseShardIds(value: unknown): number[] {
  const values = extractArray(value, ["shards", "body"]);
  return values.map((item) => typeof item === "number" ? item : Number(object(item).shardID ?? object(item).shardId))
    .filter((shard) => Number.isSafeInteger(shard) && shard >= 0);
}

function parseLogGroups(bytes: Uint8Array): Record<string, unknown>[] {
  const decoded = logProto.decode(bytes);
  const result = logProto.toObject(decoded, { defaults: false, longs: Number, bytes: String }) as Record<string, unknown>;
  return extractArray(result.logGroupList, []) as Record<string, unknown>[];
}

function flattenLogGroups(groups: readonly Record<string, unknown>[], shard: number, cursor: string): SlsPulledLog[] {
  const logs: SlsPulledLog[] = [];
  for (const groupValue of groups) {
    const group = object(groupValue);
    const tags = new Map<string, string>();
    for (const tagValue of extractArray(group.LogTags, [])) {
      const tag = object(tagValue);
      if (typeof tag.Key === "string" && typeof tag.Value === "string") tags.set(`__tag__:${tag.Key}`, tag.Value);
    }
    for (const logValue of extractArray(group.Logs, [])) {
      const log = object(logValue);
      const record: Record<string, string | number> = {
        __time__: Number(log.Time ?? 0),
        ...(typeof group.Topic === "string" ? { __topic__: group.Topic } : {}),
        ...(typeof group.Source === "string" ? { __source__: group.Source } : {}),
      };
      if (typeof log.TimeNs === "number") record.__time_ns_part__ = log.TimeNs;
      for (const [key, value] of tags) record[key] = value;
      for (const contentValue of extractArray(log.Contents, [])) {
        const content = object(contentValue);
        if (typeof content.Key === "string" && typeof content.Value === "string") record[content.Key] = content.Value;
      }
      logs.push({ record, sourcePositionKey: `shard:${shard}:cursor:${cursor}:ordinal:${logs.length}` });
    }
  }
  return logs;
}

export class AliyunSlsConsumerProtocol {
  private readonly endpoint: URL;
  private assignments = new Set<number>();
  private readonly config: SlsConsumerConfig;
  private readonly fetcher: typeof fetch;

  constructor(config: SlsConsumerConfig, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = fetcher;
    assertSegment(config.project, "project");
    assertSegment(config.logstore, "logstore");
    assertSegment(config.consumerGroup, "consumer group");
    assertSegment(config.consumerId, "consumer ID");
    if (!config.accessKeyId.trim() || !config.accessKeySecret.trim()) throw new Error("SLS access key ID and secret are required");
    this.endpoint = normalizeEndpoint(config.endpoint, config.project);
  }

  async ensureConsumerGroup(timeoutSeconds = 60): Promise<void> {
    const path = `/logstores/${encodeURIComponent(this.config.logstore)}/consumergroups`;
    const groups = await this.request("GET", path);
    const existing = extractArray(groups, ["consumerGroups", "consumerGroupList"]).some((item) => {
      const group = object(item);
      return group.consumerGroup === this.config.consumerGroup || group.consumerGroupName === this.config.consumerGroup || group.name === this.config.consumerGroup;
    });
    if (existing) return;
    await this.request("POST", path, {}, { consumerGroup: this.config.consumerGroup, timeout: timeoutSeconds, order: false });
  }

  async listShards(): Promise<number[]> {
    const path = `/logstores/${encodeURIComponent(this.config.logstore)}/shards`;
    const value = await this.request("GET", path);
    return extractArray(value, ["shards", "body"]).map((item) => Number(object(item).shardID ?? object(item).shardId))
      .filter((shard) => Number.isSafeInteger(shard) && shard >= 0);
  }

  async heartbeat(ownedShards: readonly number[]): Promise<number[]> {
    if (ownedShards.some((shard) => !Number.isSafeInteger(shard) || shard < 0)) throw new Error("SLS shard IDs must be non-negative integers");
    const path = `/logstores/${encodeURIComponent(this.config.logstore)}/consumergroups/${encodeURIComponent(this.config.consumerGroup)}`;
    try {
      const assignment = parseShardIds(await this.request("POST", path, { type: "heartbeat", consumer: this.config.consumerId }, [...ownedShards]));
      this.assignments = new Set(assignment);
      return assignment;
    } catch (error) {
      this.assignments.clear();
      throw error;
    }
  }

  async getCheckpoints(): Promise<SlsShardCheckpoint[]> {
    const path = `/logstores/${encodeURIComponent(this.config.logstore)}/consumergroups/${encodeURIComponent(this.config.consumerGroup)}`;
    const values = extractArray(await this.request("GET", path), ["checkpoints", "consumerGroupCheckPoints", "body"]);
    return values.flatMap((item) => {
      const checkpoint = object(item);
      const shard = Number(checkpoint.shard);
      const value = checkpoint.checkpoint ?? checkpoint.checkPoint;
      if (!Number.isSafeInteger(shard) || shard < 0 || typeof value !== "string") return [];
      return [{ shard, checkpoint: value, ...(typeof checkpoint.consumer === "string" ? { consumer: checkpoint.consumer } : {}) }];
    });
  }

  async getCursor(shard: number, from: "begin" | "end" | number): Promise<string> {
    this.assertShard(shard);
    const path = `/logstores/${encodeURIComponent(this.config.logstore)}/shards/${shard}`;
    const value = object(await this.request("GET", path, { type: "cursor", from: String(from) }));
    const body = object(value.body);
    const cursor = value.cursor ?? body.cursor;
    if (typeof cursor !== "string" || !cursor) throw new Error(`SLS returned no cursor for shard ${shard}`);
    return cursor;
  }

  async pullLogs(shard: number, cursor: string, count = DEFAULT_PULL_COUNT): Promise<SlsPulledBatch> {
    this.assertAssignedShard(shard);
    if (!cursor) throw new Error("SLS cursor is required");
    if (!Number.isInteger(count) || count < 1 || count > MAX_PULL_COUNT) throw new Error(`SLS pull count must be between 1 and ${MAX_PULL_COUNT}`);
    const path = `/logstores/${encodeURIComponent(this.config.logstore)}/shards/${shard}`;
    const result = await this.requestBinary("GET", path, { type: "log", cursor, count: String(count) });
    const logs = flattenLogGroups(parseLogGroups(result.body), shard, cursor);
    const nextCursor = result.headers.get("x-log-cursor");
    if (!nextCursor) throw new Error(`SLS PullLogs response omitted x-log-cursor for shard ${shard}`);
    const logGroupCount = Number(result.headers.get("x-log-count") ?? 0);
    return { logs, nextCursor, logGroupCount: Number.isSafeInteger(logGroupCount) && logGroupCount >= 0 ? logGroupCount : 0 };
  }

  async updateCheckpoint(shard: number, checkpoint: string): Promise<void> {
    this.assertAssignedShard(shard);
    if (!checkpoint) throw new Error("SLS checkpoint is required");
    const path = `/logstores/${encodeURIComponent(this.config.logstore)}/consumergroups/${encodeURIComponent(this.config.consumerGroup)}`;
    await this.request("POST", path, {
      type: "checkpoint",
      consumer: this.config.consumerId,
      forceSuccess: "false",
    }, { shard, checkpoint });
  }

  private assertShard(shard: number): void {
    if (!Number.isSafeInteger(shard) || shard < 0) throw new Error("SLS shard ID must be a non-negative integer");
  }

  private assertAssignedShard(shard: number): void {
    this.assertShard(shard);
    if (!this.assignments.has(shard)) throw new Error(`Consumer ${this.config.consumerId} does not own shard ${shard}`);
  }

  private async request(method: string, path: string, query: Readonly<Record<string, string>> = {}, body?: unknown): Promise<unknown> {
    const response = await this.signedFetch(method, path, query, body === undefined ? null : Buffer.from(JSON.stringify(body)), "application/json");
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("SLS returned malformed JSON");
    }
  }

  private async requestBinary(method: string, path: string, query: Readonly<Record<string, string>>): Promise<{ body: Uint8Array; headers: Headers }> {
    const headers = { accept: "application/x-protobuf", "accept-encoding": "" };
    const response = await this.signedFetch(method, path, query, null, "", headers);
    return { body: new Uint8Array(await response.arrayBuffer()), headers: response.headers };
  }

  private async signedFetch(
    method: string,
    path: string,
    query: Readonly<Record<string, string>>,
    body: Buffer | null,
    contentType: string,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<Response> {
    const date = new Date().toUTCString();
    const headers: Record<string, string> = {
      date,
      "x-log-apiversion": "0.6.0",
      "x-log-signaturemethod": "hmac-sha1",
      ...extraHeaders,
    };
    if (contentType) headers["content-type"] = contentType;
    if (body) {
      headers["content-md5"] = createHash("md5").update(body).digest("hex").toUpperCase();
      headers["x-log-bodyrawsize"] = String(body.length);
    }
    if (this.config.securityToken) headers["x-acs-security-token"] = this.config.securityToken;
    const resource = canonicalResource(path, query);
    const stringToSign = `${method}\n${headers["content-md5"] ?? ""}\n${headers["content-type"] ?? ""}\n${date}\n${canonicalHeaders(headers)}${resource}`;
    const signature = createHmac("sha1", this.config.accessKeySecret).update(stringToSign).digest("base64");
    headers.authorization = `LOG ${this.config.accessKeyId}:${signature}`;

    const url = new URL(this.endpoint);
    url.pathname = path;
    const queryString = encodeQuery(query);
    url.search = queryString;
    const requestInit: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (body) {
      // Node's Buffer is a valid undici request body at runtime, but the DOM
      // RequestInit typings do not include Buffer in BodyInit on all TS versions.
      requestInit.body = body as unknown as BodyInit;
    }
    const response = await this.fetcher(url, requestInit);
    if (response.ok) return response;

    let apiMessage = "SLS request failed";
    let apiCode = `HTTP_${response.status}`;
    const errorText = await response.text();
    try {
      const error = object(JSON.parse(errorText) as unknown);
      if (typeof error.errorCode === "string") apiCode = error.errorCode;
      if (typeof error.errorMessage === "string") apiMessage = error.errorMessage;
      else if (typeof object(error.Error).Message === "string") apiMessage = String(object(error.Error).Message);
    } catch {
      apiMessage = errorText.slice(0, 200) || apiMessage;
    }
    throw new Error(`SLS ${apiCode}: ${apiMessage.slice(0, 300)}`);
  }
}
