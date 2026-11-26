import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { GitLabGroupSummary, GitLabProjectSummary } from "../integrations/gitlab/types.js";
import type { GitLabService } from "../integrations/gitlab/service.js";

type GitLab = Pick<GitLabService, "getGroup" | "listProjects" | "listWorkspaceProjects" | "getBranch" | "listBranches">;
export interface RepositoryNodeInput { id?: string; externalGroupId: string; x: number; y: number; repositories: { externalProjectId: string; branch: string }[] }
export function validBranch(branch: string): boolean {
  return branch.length > 0 && branch.length <= 200 && !branch.startsWith("-") && !branch.startsWith("/") && !branch.endsWith("/") && !branch.endsWith(".") && !branch.includes("..") && !branch.includes("@{") && !branch.includes("//") && branch !== "@" && !/[\x00-\x20\x7f~^:?*\[\\]/.test(branch) && branch.split("/").every((p) => !p.startsWith(".") && !p.endsWith(".lock"));
}

export class WorkspaceRepositoryService {
  constructor(private readonly prisma: PrismaClient, private readonly gitlab: GitLab) {}

  async scope(userId: string, workspaceId: string) {
    const workspace = await this.prisma.groupWorkspace.findFirst({ where: { id: workspaceId, group: { connection: { userId, status: "ACTIVE" } } }, include: { group: { include: { connection: { select: { instanceUrl: true } } } } } });
    if (!workspace) throw new Error("Workspace not found");
    return workspace;
  }

  async get(userId: string, workspaceId: string) {
    const w = await this.scope(userId, workspaceId);
    const nodes = await this.prisma.workspaceRepositoryGroup.findMany({ where: { workspaceId }, orderBy: { fullPath: "asc" }, include: { repositories: { where: { active: true }, include: { project: true } } } });
    return { version: w.repositoryConfigVersion, connectionId: w.group.connectionId, nodes: nodes.map((n) => ({ id: n.id, externalGroupId: n.externalGroupId, fullPath: n.fullPath, x: n.positionX, y: n.positionY, repositories: n.repositories.map((r) => ({ projectId: r.projectId, externalProjectId: r.project.externalProjectId, pathWithNamespace: r.project.pathWithNamespace, branch: r.investigationBranch })) })) };
  }

  async catalog(userId: string, workspaceId: string, groupId: string, page = 1) {
    const w = await this.scope(userId, workspaceId);
    if (!Number.isInteger(page) || page < 1 || page > 1000) throw new Error("Invalid repository page");
    const group = await this.gitlab.getGroup(userId, w.group.connectionId, groupId);
    const projects = await this.gitlab.listProjects(userId, w.group.connectionId, groupId, page, true);
    return { group, ...projects };
  }

  async branches(userId: string, workspaceId: string, externalProjectId: string, page = 1) {
    const w = await this.scope(userId, workspaceId);
    if (!Number.isInteger(page) || page < 1 || page > 1000) throw new Error("Invalid branch page");
    return this.gitlab.listBranches(userId, w.group.connectionId, externalProjectId, page);
  }

  async save(userId: string, workspaceId: string, input: { expectedVersion: number; nodes: RepositoryNodeInput[] }) {
    const w = await this.scope(userId, workspaceId);
    if (!Number.isInteger(input.expectedVersion) || !Array.isArray(input.nodes) || input.nodes.length > 30) throw new Error("Invalid repository configuration");
    if (w.syncOwner && w.syncExpiresAt && w.syncExpiresAt > new Date()) throw new Error("Workspace synchronization is already running");
    if (input.expectedVersion !== w.repositoryConfigVersion) throw new Error("Workspace configuration changed; reload before saving");
    const groups = new Set<string>(); const projects = new Set<string>();
    const validated: { node: RepositoryNodeInput; group: GitLabGroupSummary; selected: { project: GitLabProjectSummary; branch: string }[] }[] = [];
    for (const node of input.nodes) {
      if (!node || typeof node.externalGroupId !== "string" || !node.externalGroupId || !Array.isArray(node.repositories) || node.repositories.length > 100_000 || !Number.isInteger(node.x) || !Number.isInteger(node.y) || node.x < 0 || node.y < 0 || node.x > 5000 || node.y > 5000) throw new Error("Invalid Group node");
      if (groups.has(node.externalGroupId)) throw new Error("Duplicate Group node");
      groups.add(node.externalGroupId);
      const group = await this.gitlab.getGroup(userId, w.group.connectionId, node.externalGroupId);
      const available = await this.gitlab.listWorkspaceProjects(userId, w.group.connectionId, node.externalGroupId);
      const availableById = new Map(available.map((project) => [project.id, project]));
      const selected = [];
      for (const repo of node.repositories) {
        if (!repo || typeof repo.externalProjectId !== "string" || typeof repo.branch !== "string" || !validBranch(repo.branch)) throw new Error("Invalid investigation branch");
        if (projects.has(repo.externalProjectId)) throw new Error("Duplicate repository across Group nodes");
        projects.add(repo.externalProjectId);
        const project = availableById.get(repo.externalProjectId);
        if (!project || !project.pathWithNamespace.startsWith(group.fullPath + "/")) throw new Error("Repository unavailable in selected Group");
        const url = new URL(project.remoteUrl ?? `${project.webUrl}.git`);
        if (url.origin !== new URL(w.group.connection.instanceUrl).origin || url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid repository origin");
        try { const branch = await this.gitlab.getBranch(userId, w.group.connectionId, repo.externalProjectId, repo.branch); if (branch.name !== repo.branch) throw new Error("mismatch"); } catch { throw new Error("GitLab branch unavailable; check branch and access permissions"); }
        selected.push({ project, branch: repo.branch });
      }
      validated.push({ node, group, selected });
    }
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.groupWorkspace.updateMany({ where: { id: workspaceId, repositoryConfigVersion: input.expectedVersion, OR: [{ syncOwner: null }, { syncExpiresAt: { lt: new Date() } }], group: { connection: { userId, status: "ACTIVE" } } }, data: { repositoryConfigVersion: { increment: 1 }, repositoryConfigManaged: true, syncOwner: null, syncExpiresAt: null, status: "READY", errorMessage: null } });
      if (!claimed.count) throw new Error("Workspace configuration changed; reload before saving");
      const ids: string[] = [];
      await tx.workspaceRepository.updateMany({ where: { workspaceId }, data: { active: false } });
      for (const { node, group, selected } of validated) {
        const saved = await tx.workspaceRepositoryGroup.upsert({ where: { workspaceId_externalGroupId: { workspaceId, externalGroupId: node.externalGroupId } }, create: { id: randomUUID(), workspaceId, externalGroupId: group.id, fullPath: group.fullPath, positionX: node.x, positionY: node.y }, update: { fullPath: group.fullPath, positionX: node.x, positionY: node.y } });
        ids.push(saved.id);
        for (const { project: item, branch } of selected) {
          const namespace = await tx.gitLabGroup.upsert({ where: { connectionId_externalGroupId: { connectionId: w.group.connectionId, externalGroupId: item.groupId } }, create: { connectionId: w.group.connectionId, externalGroupId: item.groupId, fullPath: item.namespacePath ?? item.pathWithNamespace.split("/").slice(0,-1).join("/") }, update: {} });
          const project = await tx.project.upsert({ where: { connectionId_externalProjectId: { connectionId: w.group.connectionId, externalProjectId: item.id } }, create: { connectionId: w.group.connectionId, groupId: namespace.id, externalProjectId: item.id, pathWithNamespace: item.pathWithNamespace, defaultBranch: item.defaultBranch, createdByUserId: userId }, update: { groupId: namespace.id, pathWithNamespace: item.pathWithNamespace, defaultBranch: item.defaultBranch } });
          await tx.workspaceRepository.upsert({ where: { workspaceId_projectId: { workspaceId, projectId: project.id } }, create: { workspaceId, projectId: project.id, repositoryGroupId: saved.id, investigationBranch: branch }, update: { active: true, repositoryGroupId: saved.id, investigationBranch: branch } });
        }
      }
      await tx.workspaceRepositoryGroup.deleteMany({ where: { workspaceId, id: { notIn: ids } } });
    }, { timeout: 30_000 });
    return this.get(userId, workspaceId);
  }
}
