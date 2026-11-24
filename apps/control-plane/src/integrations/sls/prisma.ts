import type { PrismaClient } from "../../generated/prisma/client.js";
import type { SecretCipher } from "../gitlab/types.js";
import type { SlsConfig } from "./types.js";
import { serializeEncryptedSecret } from "../gitlab/types.js";
import type { DataSourceConnectionTestResult, DataSourceReadTestResult } from "@qolmesgpt/contracts";

export class PrismaSlsDataSourceWriter {
  constructor(private readonly prisma: PrismaClient, private readonly cipher: SecretCipher, private readonly keyVersion: string) {}

  async create(projectId: string, config: SlsConfig): Promise<{ id: string; status: "CONFIGURED" }> {
    return this.store({ projectId }, config);
  }

  async createForWorkspace(workspaceId: string, userId: string, config: SlsConfig, sourceId?: string): Promise<{ id: string; status: "CONFIGURED" }> {
    const workspace = await this.prisma.groupWorkspace.findFirst({ where: { id: workspaceId, group: { connection: { userId, status: "ACTIVE" } } } });
    if (!workspace) throw new Error("Group Workspace is unavailable");
    if (workspace.status !== "READY") throw new Error("Group Workspace repository synchronization must complete before configuring SLS");
    return this.store({ workspaceId }, config, sourceId);
  }

  private async store(scope: { projectId: string; workspaceId?: never } | { workspaceId: string; projectId?: never }, config: SlsConfig, sourceId?: string): Promise<{ id: string; status: "CONFIGURED" }> {
    if (sourceId && scope.workspaceId) {
      const existing = await this.prisma.dataSourceConnection.findFirst({ where: { id: sourceId, workspaceId: scope.workspaceId, type: "ALIYUN_SLS" }, select: { id: true } });
      if (!existing) throw new Error("Data source not found in this workspace");
    }
    const id = scope.workspaceId ? sourceId ?? crypto.randomUUID() : undefined;
    const stored = await this.prisma.dataSourceConnection.upsert({
      where: scope.workspaceId ? { id } : { projectId_type: { projectId: scope.projectId!, type: "ALIYUN_SLS" } },
      create: {
        ...scope,
        type: "ALIYUN_SLS",
        configJson: { endpoint: config.endpoint, project: config.project, logstore: config.logstore, consumerGroup: config.consumerGroup },
        credentialsCiphertext: serializeEncryptedSecret(this.cipher.encrypt(JSON.stringify({ accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret, securityToken: config.securityToken }))),
        credentialKeyVersion: this.keyVersion,
        status: "CONFIGURED",
      },
      update: {
        configJson: { endpoint: config.endpoint, project: config.project, logstore: config.logstore, consumerGroup: config.consumerGroup },
        credentialsCiphertext: serializeEncryptedSecret(this.cipher.encrypt(JSON.stringify({ accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret, securityToken: config.securityToken }))),
        credentialKeyVersion: this.keyVersion,
        status: "CONFIGURED",
        enabledAt: null,
      },
      select: { id: true, status: true },
    });
    return { id: stored.id, status: "CONFIGURED" };
  }
}

export class PrismaSlsVerificationStore {
  constructor(private readonly prisma: PrismaClient, private readonly cipher: SecretCipher) {}

  async matchesConfig(connectionId: string, config: SlsConfig): Promise<boolean> {
    const saved = await this.prisma.dataSourceConnection.findUnique({
      where: { id: connectionId },
      select: { type: true, configJson: true, credentialsCiphertext: true },
    });
    if (!saved || saved.type !== "ALIYUN_SLS") return false;
    try {
      const settings = saved.configJson as Record<string, unknown>;
      const credentials = JSON.parse(this.cipher.decrypt(saved.credentialsCiphertext)) as Record<string, unknown>;
      return settings.endpoint === config.endpoint && settings.project === config.project && settings.logstore === config.logstore && (settings.consumerGroup ?? undefined) === (config.consumerGroup ?? undefined)
        && credentials.accessKeyId === config.accessKeyId && credentials.accessKeySecret === config.accessKeySecret
        && (credentials.securityToken ?? undefined) === (config.securityToken ?? undefined);
    } catch {
      return false;
    }
  }

  async recordConnection(connectionId: string, result: DataSourceConnectionTestResult): Promise<void> {
    await this.prisma.dataSourceVerification.create({
      data: { connectionId, kind: "CONNECTION", status: result.status === "passed" ? "PASSED" : "FAILED", safeSummary: result.safeSummary, errorCode: result.errorCode },
    });
  }

  async recordRead(connectionId: string, result: DataSourceReadTestResult): Promise<void> {
    await this.prisma.dataSourceVerification.create({
      data: { connectionId, kind: "READ", status: result.status === "failed" ? "FAILED" : "PASSED", safeSummary: result.safeSummary, errorCode: result.errorCode },
    });
  }

  async canEnable(connectionId: string): Promise<boolean> {
    const [source, connection, read] = await Promise.all([
      this.prisma.dataSourceConnection.findUnique({ where: { id: connectionId }, select: { updatedAt: true } }),
      this.prisma.dataSourceVerification.findFirst({ where: { connectionId, kind: "CONNECTION" }, orderBy: { testedAt: "desc" } }),
      this.prisma.dataSourceVerification.findFirst({ where: { connectionId, kind: "READ" }, orderBy: { testedAt: "desc" } }),
    ]);
    return Boolean(source && connection?.status === "PASSED" && read?.status === "PASSED"
      && connection.testedAt >= source.updatedAt && read.testedAt >= source.updatedAt);
  }

  async enable(connectionId: string): Promise<{ status: "ENABLED" }> {
    const source = await this.prisma.dataSourceConnection.findUnique({ where: { id: connectionId }, select: { updatedAt: true } });
    if (!source || !(await this.canEnable(connectionId))) throw new Error("SLS connection and read verification must both pass before enabling");
    const updated = await this.prisma.dataSourceConnection.updateMany({
      where: { id: connectionId, updatedAt: source.updatedAt },
      data: { status: "ENABLED", enabledAt: new Date() },
    });
    if (updated.count !== 1) throw new Error("SLS configuration changed during enablement");
    return { status: "ENABLED" };
  }
}
