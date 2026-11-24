import { normalizeSlsConfig, safeSlsConfig, type SlsConfigInput } from "../integrations/sls/config.js";
import { AliyunSlsAdapter } from "../integrations/sls/adapter.js";
import type { SlsAdapter, SlsRange } from "../integrations/sls/types.js";
import type { DataSourceConnectionTestResult, DataSourceReadTestResult } from "@qolmesgpt/contracts";

export interface DataSourceRouteContext {
  readonly userId: string;
  readonly projectId?: string;
  readonly workspaceId?: string;
  readonly sourceId?: string;
}

export interface SlsDataSourceWriter {
  createForWorkspace?(workspaceId: string, userId: string, config: ReturnType<typeof normalizeSlsConfig>, sourceId?: string): Promise<{ id: string; status: "CONFIGURED" }>;
  create(projectId: string, config: ReturnType<typeof normalizeSlsConfig>): Promise<{ id: string; status: "CONFIGURED" }>;
}

export interface SlsVerificationStore {
  matchesConfig(connectionId: string, config: ReturnType<typeof normalizeSlsConfig>): Promise<boolean>;
  recordConnection(connectionId: string, result: DataSourceConnectionTestResult): Promise<void>;
  recordRead(connectionId: string, result: DataSourceReadTestResult): Promise<void>;
  canEnable(connectionId: string): Promise<boolean>;
  enable(connectionId: string): Promise<{ status: "ENABLED" }>;
}

export class DataSourceRoutes {
  constructor(private readonly writer: SlsDataSourceWriter, private readonly adapter: SlsAdapter = new AliyunSlsAdapter(), private readonly verifications?: SlsVerificationStore) {}

  async createSls(context: DataSourceRouteContext, input: SlsConfigInput) {
    const config = normalizeSlsConfig(input);
    if (Boolean(context.projectId) === Boolean(context.workspaceId)) throw new Error("Exactly one workspace or legacy project scope is required");
    const connection = context.workspaceId
      ? await this.writer.createForWorkspace!(context.workspaceId, context.userId, config, context.sourceId)
      : await this.writer.create(context.projectId!, config);
    return { ...connection, type: "aliyun-sls" as const, config: safeSlsConfig(config) };
  }

  testConnection(_context: DataSourceRouteContext, input: SlsConfigInput) {
    return this.adapter.validate(normalizeSlsConfig(input));
  }

  testRead(_context: DataSourceRouteContext, input: SlsConfigInput, range: SlsRange, limit: number) {
    return this.adapter.readSample(normalizeSlsConfig(input), range, limit);
  }

  async verifyConnection(connectionId: string, input: SlsConfigInput) {
    const config = normalizeSlsConfig(input);
    if (!this.verifications || !(await this.verifications.matchesConfig(connectionId, config))) throw new Error("SLS configuration does not match the saved connection");
    const result = await this.adapter.validate(config);
    if (this.verifications) await this.verifications.recordConnection(connectionId, result);
    return result;
  }

  async verifyRead(connectionId: string, input: SlsConfigInput, range: SlsRange, limit: number) {
    const config = normalizeSlsConfig(input);
    if (!this.verifications || !(await this.verifications.matchesConfig(connectionId, config))) throw new Error("SLS configuration does not match the saved connection");
    const result = await this.adapter.readSample(config, range, limit);
    if (this.verifications) await this.verifications.recordRead(connectionId, result);
    return result;
  }

  async enable(connectionId: string) {
    if (!this.verifications) throw new Error("Data source verification store is unavailable");
    if (!(await this.verifications.canEnable(connectionId))) throw new Error("SLS connection and read verification must both pass before enabling");
    return this.verifications.enable(connectionId);
  }
}
