import type { BoundedRange, DataSourceAdapter } from "@qolmesgpt/contracts";

export interface SlsConfig {
  readonly endpoint: string;
  readonly project: string;
  readonly logstore: string;
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly securityToken?: string;
}

export interface SlsLogRecord {
  readonly [key: string]: unknown;
}

export interface SlsClient {
  getProject(project: string): Promise<unknown>;
  getLogStore(project: string, logstore: string): Promise<unknown>;
  getLogs(project: string, logstore: string, from: Date, to: Date, query: Record<string, string | number | boolean>): Promise<unknown>;
}

export interface SlsClientFactory {
  create(config: SlsConfig): SlsClient;
}

export type SlsAdapter = DataSourceAdapter<SlsConfig, SlsLogRecord>;
export type SlsRange = BoundedRange;

export const stagingSlsDefaults = {
  region: "cn-shanghai",
  endpoint: "https://cn-shanghai.log.aliyuncs.com",
  project: "pyxis-telemetry-log",
  logstore: "pyxis-trace-staging",
} as const;
