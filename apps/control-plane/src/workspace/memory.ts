import { randomUUID } from "node:crypto";
import type { WorkspaceLease, WorkspaceRecord, WorkspaceStore } from "./types.js";

export class MemoryWorkspaceStore implements WorkspaceStore {
  private readonly records = new Map<string, WorkspaceRecord>();

  async findByProjectId(projectId: string): Promise<WorkspaceRecord | null> {
    return this.records.get(projectId) ?? null;
  }

  async create(input: Omit<WorkspaceRecord, "id">): Promise<WorkspaceRecord> {
    if (this.records.has(input.projectId)) throw new Error("Workspace already exists for project");
    const record = { ...input, id: randomUUID() };
    this.records.set(record.projectId, record);
    return record;
  }

  async update(projectId: string, patch: Partial<Pick<WorkspaceRecord, "headSha" | "branch" | "status" | "remoteUrl" | "relativePath">>): Promise<WorkspaceRecord> {
    const current = this.records.get(projectId);
    if (!current) throw new Error("Workspace does not exist");
    const updated = { ...current, ...patch };
    this.records.set(projectId, updated);
    return updated;
  }

  async acquireLock(projectId: string, owner: string, now: Date, ttlMs: number): Promise<WorkspaceLease | null> {
    const current = this.records.get(projectId);
    if (!current) throw new Error("Workspace does not exist");
    if (current.lockOwner && current.lockExpiresAt && current.lockExpiresAt > now && current.lockOwner !== owner) return null;
    const fencingToken = current.fencingToken + 1n;
    const expiresAt = new Date(now.getTime() + ttlMs);
    this.records.set(projectId, { ...current, status: "OCCUPIED", lockOwner: owner, lockExpiresAt: expiresAt, fencingToken });
    return { projectId, owner, fencingToken, expiresAt };
  }

  async releaseLock(projectId: string, owner: string, fencingToken: bigint): Promise<boolean> {
    const current = this.records.get(projectId);
    if (!current || current.lockOwner !== owner || current.fencingToken !== fencingToken) return false;
    this.records.set(projectId, { ...current, status: "READY", lockOwner: null, lockExpiresAt: null });
    return true;
  }

  async assertFence(projectId: string, owner: string, fencingToken: bigint, now: Date): Promise<void> {
    const current = this.records.get(projectId);
    if (!current || current.lockOwner !== owner || current.fencingToken !== fencingToken || !current.lockExpiresAt || current.lockExpiresAt <= now) {
      throw new Error("Workspace fencing token is no longer valid");
    }
  }
}
