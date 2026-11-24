import { createRequire } from "node:module";
import type { SlsClient, SlsClientFactory, SlsConfig } from "./types.js";

type SdkClient = new (config: Record<string, unknown>) => {
  getProject(project: string): Promise<unknown>;
  getLogStore(project: string, logstore: string): Promise<unknown>;
  getLogs(project: string, logstore: string, from: Date, to: Date, query: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
};

const require = createRequire(import.meta.url);
const AliyunLogClient = require("@alicloud/log") as SdkClient;

export const aliyunSlsClientFactory: SlsClientFactory = {
  create(config: SlsConfig): SlsClient {
    const client = new AliyunLogClient({
      endpoint: config.endpoint,
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      ...(config.securityToken ? { securityToken: config.securityToken } : {}),
    });
    return {
      getProject: (project) => client.getProject(project),
      getLogStore: (project, logstore) => client.getLogStore(project, logstore),
      getLogs: (project, logstore, from, to, query) => client.getLogs(project, logstore, from, to, query, { timeout: 5_000 }),
    };
  },
};
