import type { PrismaClient } from "../../generated/prisma/client.js";
import type { SecretCipher } from "../gitlab/types.js";
import type { SlsConfig } from "./types.js";
import { serializeEncryptedSecret } from "../gitlab/types.js";
import type { DataSourceConnectionTestResult, DataSourceReadTestResult } from "@qolmesgpt/contracts";

export class PrismaSlsDataSourceWriter {
  constructor(private readonly prisma: PrismaClient, private readonly cipher: SecretCipher, private readonly keyVersion: string) {}

  async create(projectId: string, config: SlsConfig): Promise<{ id: string; status: "CONFIGURED" }> {
    const stored = await this.prisma.dataSourceConnection.upsert({
      where: { projectId_type: { projectId, type: "ALIYUN_SLS" } },
      create: {
        projectId,
        type: "ALIYUN_SLS",
        configJson: { endpoint: config.endpoint, project: config.project, logstore: config.logstore },
        credentialsCiphertext: serializeEncryptedSecret(this.cipher.encrypt(JSON.stringify({ accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret, securityToken: config.securityToken }))),
        credentialKeyVersion: this.keyVersion,
        status: "CONFIGURED",
      },
      update: {
        configJson: { endpoint: config.endpoint, project: config.project, logstore: config.logstore },
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
  constructor(private readonly prisma: PrismaClient) {}

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
    const [connection, read] = await Promise.all([
      this.prisma.dataSourceVerification.findFirst({ where: { connectionId, kind: "CONNECTION", status: "PASSED" }, orderBy: { testedAt: "desc" } }),
      this.prisma.dataSourceVerification.findFirst({ where: { connectionId, kind: "READ", status: "PASSED" }, orderBy: { testedAt: "desc" } }),
    ]);
    return Boolean(connection && read);
  }

  async enable(connectionId: string): Promise<{ status: "ENABLED" }> {
    await this.prisma.dataSourceConnection.update({ where: { id: connectionId }, data: { status: "ENABLED", enabledAt: new Date() } });
    return { status: "ENABLED" };
  }
}
