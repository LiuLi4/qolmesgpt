import type { PrismaClient } from "../../generated/prisma/client.js";
import type { GitLabConnectionRecord, GitLabConnectionStore, OAuthStateRecord, OAuthStateStore } from "./types.js";

export class PrismaGitLabConnectionStore implements GitLabConnectionStore {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(input: Parameters<GitLabConnectionStore["upsert"]>[0]): Promise<GitLabConnectionRecord> {
    return this.prisma.gitLabConnection.upsert({
      where: { userId_instanceUrl: { userId: input.userId, instanceUrl: input.instanceUrl } },
      create: { ...input, status: "ACTIVE" },
      update: { ...input, status: "ACTIVE" },
    });
  }

  async findById(userId: string, connectionId: string): Promise<GitLabConnectionRecord | null> {
    return this.prisma.gitLabConnection.findFirst({ where: { id: connectionId, userId } });
  }
}

export class PrismaOAuthStateStore implements OAuthStateStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: Omit<OAuthStateRecord, "id" | "consumedAt">): Promise<OAuthStateRecord> {
    return this.prisma.gitLabOAuthState.create({ data: input });
  }

  async consume(userId: string, stateHash: string, now: Date): Promise<OAuthStateRecord | null> {
    const result = await this.prisma.gitLabOAuthState.updateMany({
      where: { userId, stateHash, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (result.count !== 1) return null;
    return this.prisma.gitLabOAuthState.findUnique({ where: { stateHash } });
  }
}
