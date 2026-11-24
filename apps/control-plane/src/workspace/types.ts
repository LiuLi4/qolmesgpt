export type WorkspaceStatus = "INITIALIZING" | "READY" | "OCCUPIED" | "DIRTY" | "FAILED";

export interface WorkspaceProject {
  readonly projectId: string;
  readonly remoteUrl: string;
  readonly defaultBranch: string;
  readonly relativePath: string;
}

export interface WorkspaceRecord {
  readonly id: string;
  readonly projectId: string;
  readonly remoteUrl: string;
  readonly relativePath: string;
  readonly headSha: string | null;
  readonly branch: string | null;
  readonly status: WorkspaceStatus;
  readonly lockOwner: string | null;
  readonly lockExpiresAt: Date | null;
  readonly fencingToken: bigint;
}

export interface WorkspaceLease {
  readonly projectId: string;
  readonly owner: string;
  readonly fencingToken: bigint;
  readonly expiresAt: Date;
}

export interface WorkspaceStore {
  findByProjectId(projectId: string): Promise<WorkspaceRecord | null>;
  create(input: Omit<WorkspaceRecord, "id">): Promise<WorkspaceRecord>;
  update(projectId: string, patch: Partial<Pick<WorkspaceRecord, "headSha" | "branch" | "status" | "remoteUrl" | "relativePath">>): Promise<WorkspaceRecord>;
  acquireLock(projectId: string, owner: string, now: Date, ttlMs: number): Promise<WorkspaceLease | null>;
  releaseLock(projectId: string, owner: string, fencingToken: bigint): Promise<boolean>;
  assertFence(projectId: string, owner: string, fencingToken: bigint, now: Date): Promise<void>;
}

export interface GitRunner {
  run(args: readonly string[], cwd: string): Promise<string>;
}
