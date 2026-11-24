import { randomUUID } from "node:crypto";
import type { GitLabConnectionRecord, GitLabConnectionStore, OAuthStateRecord, OAuthStateStore } from "./types.js";

export class MemoryOAuthStateStore implements OAuthStateStore {
  private readonly records = new Map<string, OAuthStateRecord>();

  async create(input: Omit<OAuthStateRecord, "id" | "consumedAt">): Promise<OAuthStateRecord> {
    const record: OAuthStateRecord = { ...input, id: randomUUID(), consumedAt: null };
    this.records.set(record.stateHash, record);
    return record;
  }

  async consume(userId: string, stateHash: string, now: Date): Promise<OAuthStateRecord | null> {
    const record = this.records.get(stateHash);
    if (!record || record.userId !== userId || record.consumedAt || record.expiresAt <= now) return null;
    const consumed = { ...record, consumedAt: now };
    this.records.set(stateHash, consumed);
    return consumed;
  }
}

export class MemoryGitLabConnectionStore implements GitLabConnectionStore {
  private readonly records = new Map<string, GitLabConnectionRecord>();

  async upsert(input: Parameters<GitLabConnectionStore["upsert"]>[0]): Promise<GitLabConnectionRecord> {
    const previous = [...this.records.values()].find((record) => record.userId === input.userId && record.instanceUrl === input.instanceUrl);
    const now = new Date();
    const record: GitLabConnectionRecord = {
      id: previous?.id ?? randomUUID(),
      ...input,
      status: "ACTIVE",
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return record;
  }

  async findById(userId: string, connectionId: string): Promise<GitLabConnectionRecord | null> {
    const record = this.records.get(connectionId);
    return record?.userId === userId ? record : null;
  }

  all(): readonly GitLabConnectionRecord[] {
    return [...this.records.values()];
  }
}
