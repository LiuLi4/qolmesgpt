import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { GitLabService } from "../integrations/gitlab/service.js";
import { repositoryIdentity } from "./remotes.js";

const exec = promisify(execFile);

export interface RepositoryCheckout {
  prepare(input: { relativePath: string; remoteUrl: string; branch: string; token: string }): Promise<{ headSha: string; branch: string; status: "READY" | "DIRTY" }>;
}

export async function safeWorkspacePath(root: string, path: string): Promise<string> {
  const base = resolve(root);
  const target = resolve(base, path);
  const contained = relative(base, target);
  if (!contained || isAbsolute(contained) || contained.startsWith("..")) throw new Error("Workspace path escapes its root");
  let current = base;
  for (const part of ["", ...contained.split("/")]) {
    if (part) current = resolve(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
    if (info?.isSymbolicLink()) throw new Error("Workspace paths cannot contain symlinks");
  }
  return target;
}

export class GitRepositoryCheckout implements RepositoryCheckout {
  constructor(private readonly root: string) {}

  async prepare(input: { relativePath: string; remoteUrl: string; branch: string; token: string }) {
    const path = await safeWorkspacePath(this.root, input.relativePath);
    await mkdir(dirname(path), { recursive: true });
    const remote = new URL(input.remoteUrl);
    if (!["http:", "https:"].includes(remote.protocol) || remote.username || remote.password || remote.search || remote.hash) throw new Error("Invalid GitLab repository URL");
    // Service checkouts use their configured transport, not a developer's global URL rewrites.
    const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0" };
    const exists = await lstat(path).catch(() => null);
    if (!exists) {
      await exec("git", ["clone", "--depth", "1", "--branch", input.branch, "--single-branch", input.remoteUrl, path], {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        env: { ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${remote.origin}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`oauth2:${input.token}`).toString("base64")}` },
      });
    }
    const run = async (args: string[]) => (await exec("git", args, { cwd: path, env, timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim();
    const actual = await run(["config", "--get", "remote.origin.url"]);
    if (repositoryIdentity(actual) !== repositoryIdentity(input.remoteUrl)) throw new Error("Workspace origin does not match the selected repository");
    const dirty = await run(["status", "--porcelain"]);
    return { headSha: await run(["rev-parse", "HEAD"]), branch: await run(["branch", "--show-current"]), status: dirty ? "DIRTY" as const : "READY" as const };
  }
}

type GroupGitLab = Pick<GitLabService, "getGroup" | "getAccessToken" | "listWorkspaceProjects">;

export class GroupWorkspaceService {
  private readonly checkout: RepositoryCheckout;
  constructor(private readonly prisma: PrismaClient, private readonly gitlab: GroupGitLab, root: string, checkout?: RepositoryCheckout) {
    this.checkout = checkout ?? new GitRepositoryCheckout(root);
  }

  async create(userId: string, connectionId: string, groupId: string) {
    const selected = await this.gitlab.getGroup(userId, connectionId, groupId);
    const group = await this.prisma.gitLabGroup.upsert({
      where: { connectionId_externalGroupId: { connectionId, externalGroupId: selected.id } },
      create: { connectionId, externalGroupId: selected.id, fullPath: selected.fullPath },
      update: { fullPath: selected.fullPath },
    });
    const id = randomUUID();
    return this.prisma.groupWorkspace.upsert({
      where: { groupId: group.id },
      create: { id, groupId: group.id, relativePath: `groups/${id}` },
      update: {},
      select: { id: true, relativePath: true, status: true },
    });
  }

  async synchronize(userId: string, workspaceId: string): Promise<void> {
    const workspace = await this.prisma.groupWorkspace.findFirst({
      where: { id: workspaceId, group: { connection: { userId, status: "ACTIVE" } } },
      include: { group: { include: { connection: { select: { instanceUrl: true } } } } },
    });
    if (!workspace) throw new Error("Group Workspace is unavailable");
    const owner = randomUUID();
    const claim = await this.prisma.groupWorkspace.updateMany({
      where: { id: workspaceId, OR: [{ syncOwner: null }, { syncExpiresAt: { lt: new Date() } }] },
      data: { status: "INITIALIZING", syncOwner: owner, syncExpiresAt: new Date(Date.now() + 300_000), errorMessage: null },
    });
    if (!claim.count) throw new Error("Workspace synchronization is already running");
    let failures = 0;
    try {
      const group = await this.gitlab.getGroup(userId, workspace.group.connectionId, workspace.group.externalGroupId);
      const token = await this.gitlab.getAccessToken(userId, workspace.group.connectionId);
      const discovered = await this.gitlab.listWorkspaceProjects(userId, workspace.group.connectionId, workspace.group.externalGroupId);
      const members: { id: string; remoteUrl: string; branch: string }[] = [];
      for (const repository of discovered) {
        if (!repository.pathWithNamespace.startsWith(`${group.fullPath}/`)) throw new Error("GitLab returned a repository outside the selected Group");
        const remoteUrl = repository.remoteUrl ?? `${repository.webUrl.replace(/\/$/, "")}.git`;
        const url = new URL(remoteUrl);
        if (url.origin !== new URL(workspace.group.connection.instanceUrl).origin || url.username || url.password || url.search || url.hash) throw new Error("GitLab repository origin must match its connection");
        const namespace = await this.prisma.gitLabGroup.upsert({
          where: { connectionId_externalGroupId: { connectionId: workspace.group.connectionId, externalGroupId: repository.groupId } },
          create: { connectionId: workspace.group.connectionId, externalGroupId: repository.groupId, fullPath: repository.namespacePath ?? repository.pathWithNamespace.split("/").slice(0, -1).join("/") },
          update: {},
        });
        const project = await this.prisma.project.upsert({
          where: { connectionId_externalProjectId: { connectionId: workspace.group.connectionId, externalProjectId: repository.id } },
          create: { connectionId: workspace.group.connectionId, groupId: namespace.id, externalProjectId: repository.id, pathWithNamespace: repository.pathWithNamespace, defaultBranch: repository.defaultBranch, createdByUserId: userId },
          update: { groupId: namespace.id, pathWithNamespace: repository.pathWithNamespace, defaultBranch: repository.defaultBranch },
        });
        await this.prisma.workspaceRepository.upsert({ where: { workspaceId_projectId: { workspaceId, projectId: project.id } }, create: { workspaceId, projectId: project.id }, update: { active: true } });
        members.push({ id: project.id, remoteUrl, branch: repository.defaultBranch });
      }
      await this.prisma.workspaceRepository.updateMany({ where: { workspaceId, projectId: { notIn: members.map((member) => member.id) } }, data: { active: false } });
      for (const member of members) {
        const renewed = await this.prisma.groupWorkspace.updateMany({ where: { id: workspaceId, syncOwner: owner, syncExpiresAt: { gt: new Date() } }, data: { syncExpiresAt: new Date(Date.now() + 300_000) } });
        if (!renewed.count) throw new Error("Workspace synchronization lease lost");
        const checkout = await this.prisma.projectWorkspace.upsert({
          where: { projectId: member.id }, create: { projectId: member.id, relativePath: `${workspace.relativePath}/repositories/${member.id}`, branch: member.branch }, update: {},
        });
        const locked = await this.prisma.projectWorkspace.updateMany({
          where: { id: checkout.id, OR: [{ lockOwner: null }, { lockExpiresAt: { lt: new Date() } }] },
          data: { lockOwner: owner, lockExpiresAt: new Date(Date.now() + 300_000), fencingToken: { increment: 1 } },
        });
        if (!locked.count) { failures++; continue; }
        try {
          const result = await this.checkout.prepare({ relativePath: checkout.relativePath, remoteUrl: member.remoteUrl, branch: member.branch, token });
          if (result.status !== "READY") failures++;
          await this.prisma.projectWorkspace.updateMany({ where: { id: checkout.id, lockOwner: owner }, data: { ...result, errorMessage: result.status === "DIRTY" ? "Repository contains uncommitted changes" : null } });
        } catch (error) {
          failures++;
          const safe = String(error instanceof Error ? error.message : "Repository checkout failed").replaceAll(token, "[REDACTED]").slice(0, 600);
          await this.prisma.projectWorkspace.updateMany({ where: { id: checkout.id, lockOwner: owner }, data: { status: "FAILED", errorMessage: safe } });
        } finally {
          await this.prisma.projectWorkspace.updateMany({ where: { id: checkout.id, lockOwner: owner }, data: { lockOwner: null, lockExpiresAt: null } });
        }
      }
      await this.prisma.groupWorkspace.updateMany({ where: { id: workspaceId, syncOwner: owner }, data: { status: failures ? "FAILED" : "READY", lastSyncedAt: new Date(), errorMessage: failures ? `${failures} repository checkouts require attention` : null } });
    } catch (error) {
      await this.prisma.groupWorkspace.updateMany({ where: { id: workspaceId, syncOwner: owner }, data: { status: "FAILED", errorMessage: "GitLab Group synchronization failed; retry synchronization and check connection permissions" } });
      throw error;
    } finally {
      await this.prisma.groupWorkspace.updateMany({ where: { id: workspaceId, syncOwner: owner }, data: { syncOwner: null, syncExpiresAt: null } });
    }
  }
}
