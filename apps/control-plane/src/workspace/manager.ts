import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { devNull } from "node:os";
import { repositoryIdentity } from "./remotes.js";
import type { GitRunner, WorkspaceLease, WorkspaceProject, WorkspaceRecord, WorkspaceStore } from "./types.js";

const execFileAsync = promisify(execFile);

export class NodeGitRunner implements GitRunner {
  async run(args: readonly string[], cwd: string): Promise<string> {
    const result = await execFileAsync("git", [...args], { cwd, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_CONFIG_GLOBAL: devNull } });
    return result.stdout.trim();
  }
}

export class WorkspaceManager {
  constructor(
    private readonly rootDirectory: string,
    private readonly store: WorkspaceStore,
    private readonly git: GitRunner = new NodeGitRunner(),
    private readonly now: () => Date = () => new Date(),
    private readonly lockTtlMs = 15 * 60_000,
  ) {}

  async ensureWorkspace(project: WorkspaceProject): Promise<{ record: WorkspaceRecord; absolutePath: string }> {
    const remoteIdentity = repositoryIdentity(project.remoteUrl);
    const absolutePath = await this.safePath(project.relativePath);
    const existing = await this.store.findByProjectId(project.projectId);
    if (existing) {
      if (repositoryIdentity(existing.remoteUrl) !== remoteIdentity || existing.relativePath !== project.relativePath) {
        await this.store.update(project.projectId, { status: "FAILED" });
        throw new Error("Workspace remote or path does not match the selected GitLab project");
      }
      try {
        const actualRemote = repositoryIdentity(await this.git.run(["config", "--get", "remote.origin.url"], absolutePath));
        if (actualRemote !== remoteIdentity) throw new Error("Workspace origin remote does not match the selected GitLab project");
        const headSha = await this.git.run(["rev-parse", "HEAD"], absolutePath);
        const branch = await this.git.run(["branch", "--show-current"], absolutePath);
        const record = await this.store.update(project.projectId, { headSha, branch: branch || project.defaultBranch, status: "READY" });
        return { record, absolutePath };
      } catch (error) {
        await this.store.update(project.projectId, { status: "FAILED" });
        throw new Error(`Workspace verification failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }

    await mkdir(dirname(absolutePath), { recursive: true });
    try {
      await this.store.create({ projectId: project.projectId, remoteUrl: project.remoteUrl, relativePath: project.relativePath, headSha: null, branch: project.defaultBranch, status: "INITIALIZING", lockOwner: null, lockExpiresAt: null, fencingToken: 0n });
      await this.git.run(["clone", "--branch", project.defaultBranch, "--single-branch", project.remoteUrl, absolutePath], dirname(absolutePath));
      const headSha = await this.git.run(["rev-parse", "HEAD"], absolutePath);
      const record = await this.store.update(project.projectId, { headSha, branch: project.defaultBranch, status: "READY" });
      return { record, absolutePath };
    } catch (error) {
      await this.store.update(project.projectId, { status: "FAILED" });
      throw new Error(`Workspace initialization failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  async sync(projectId: string, expectedRemoteUrl: string, branch: string): Promise<WorkspaceRecord> {
    const record = await this.requireRecord(projectId);
    const absolutePath = await this.safePath(record.relativePath);
    if (repositoryIdentity(record.remoteUrl) !== repositoryIdentity(expectedRemoteUrl)) throw new Error("Workspace remote does not match the selected project");
    const status = await this.git.run(["status", "--porcelain"], absolutePath);
    if (status) {
      await this.store.update(projectId, { status: "DIRTY" });
      throw new Error("Workspace has uncommitted changes and cannot be synchronized");
    }
    await this.git.run(["fetch", "--prune", "origin", branch], absolutePath);
    await this.git.run(["checkout", branch], absolutePath);
    await this.git.run(["reset", "--hard", `origin/${branch}`], absolutePath);
    const headSha = await this.git.run(["rev-parse", "HEAD"], absolutePath);
    return this.store.update(projectId, { headSha, branch, status: "READY" });
  }

  async acquireLock(projectId: string, owner: string): Promise<WorkspaceLease> {
    const lease = await this.store.acquireLock(projectId, owner, this.now(), this.lockTtlMs);
    if (!lease) throw new Error("Workspace is currently occupied by another task");
    return lease;
  }

  async assertLease(lease: WorkspaceLease): Promise<void> {
    await this.store.assertFence(lease.projectId, lease.owner, lease.fencingToken, this.now());
  }

  async releaseLock(lease: WorkspaceLease): Promise<void> {
    const released = await this.store.releaseLock(lease.projectId, lease.owner, lease.fencingToken);
    if (!released) throw new Error("Workspace lock is no longer owned by this task");
  }

  async workspacePath(relativePath: string): Promise<string> {
    return this.safePath(relativePath);
  }

  private async requireRecord(projectId: string): Promise<WorkspaceRecord> {
    const record = await this.store.findByProjectId(projectId);
    if (!record) throw new Error("Workspace does not exist");
    return record;
  }

  private async safePath(relativePath: string): Promise<string> {
    if (isAbsolute(relativePath) || relativePath.includes("\0")) throw new Error("Workspace path must be relative");
    const absolutePath = resolve(this.rootDirectory, relativePath);
    const contained = relative(resolve(this.rootDirectory), absolutePath);
    if (!contained || contained.startsWith("..") || isAbsolute(contained)) throw new Error("Workspace path escapes the workspace root");
    await this.assertNoSymlink(resolve(this.rootDirectory), absolutePath);
    return absolutePath;
  }

  private async assertNoSymlink(root: string, target: string): Promise<void> {
    const rootStat = await lstat(root).catch(() => null);
    if (rootStat?.isSymbolicLink()) throw new Error("Workspace root cannot be a symlink");
    const segments = relative(root, target).split("/").filter(Boolean);
    let current = root;
    for (const segment of segments) {
      current = resolve(current, segment);
      const stat = await lstat(current).catch(() => null);
      if (stat?.isSymbolicLink()) throw new Error("Workspace path cannot traverse a symlink");
    }
  }
}
