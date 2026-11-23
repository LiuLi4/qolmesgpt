import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { GroupWorkspaceService, safeWorkspacePath, type RepositoryCheckout } from "../dist/workspace/group.js";

test("a Group Workspace enrolls every accessible descendant repository and prepares an isolated checkout", async () => {
  const workspace = { id: "workspace-1", groupId: "root-1", relativePath: "groups/workspace-1", status: "INITIALIZING" };
  const repositoryLinks = new Map<string, { workspaceId: string; projectId: string; active: boolean }>();
  const checkoutRecords = new Map<string, { id: string; relativePath: string; status: string }>();
  const fakePrisma = {
    gitLabGroup: { upsert: async ({ create }: { create: { connectionId: string; externalGroupId: string; fullPath: string } }) => ({ id: create.externalGroupId === "root-1" ? "root-1" : create.externalGroupId, ...create }) },
    groupWorkspace: {
      upsert: async () => workspace,
      findFirst: async () => ({ ...workspace, group: { externalGroupId: "root-1", fullPath: "acme/platform", connectionId: "connection-1", connection: { instanceUrl: "http://git.example" } } }),
      updateMany: async () => ({ count: 1 }),
    },
    project: { upsert: async ({ create }: { create: { externalProjectId: string; pathWithNamespace: string } }) => ({ id: `project-${create.externalProjectId}`, ...create }) },
    workspaceRepository: {
      upsert: async ({ create }: { create: { workspaceId: string; projectId: string } }) => { repositoryLinks.set(create.projectId, { ...create, active: true }); return create; },
      updateMany: async () => ({ count: 0 }),
    },
    projectWorkspace: {
      upsert: async ({ create }: { create: { projectId: string; relativePath: string } }) => { const value = { id: `checkout-${create.projectId}`, relativePath: create.relativePath, status: "INITIALIZING" }; checkoutRecords.set(create.projectId, value); return value; },
      updateMany: async () => ({ count: 1 }),
    },
  } as never;
  const gitlab = {
    getGroup: async () => ({ id: "root-1", fullPath: "acme/platform", name: "platform", role: "MAINTAINER" as const, roleCheckedAt: null }),
    getAccessToken: async () => "fixture-token",
    listWorkspaceProjects: async () => [
      { id: "11", groupId: "root-1", namespacePath: "acme/platform", name: "api", pathWithNamespace: "acme/platform/api", defaultBranch: "main", webUrl: "http://git.example/acme/platform/api", remoteUrl: "http://git.example/acme/platform/api.git" },
      { id: "12", groupId: "child-1", namespacePath: "acme/platform/mobile", name: "mobile", pathWithNamespace: "acme/platform/mobile/mobile", defaultBranch: "develop", webUrl: "http://git.example/acme/platform/mobile/mobile", remoteUrl: "http://git.example/acme/platform/mobile/mobile.git" },
    ],
  } as never;
  const prepared: string[] = [];
  const checkout: RepositoryCheckout = { prepare: async (input) => { assert.equal(input.token, "fixture-token"); prepared.push(input.relativePath); return { headSha: "abc123", branch: input.branch, status: "READY" }; } };
  const service = new GroupWorkspaceService(fakePrisma, gitlab, "/tmp/qolmes-workspaces", checkout);
  assert.deepEqual(await service.create("user-1", "connection-1", "root-1"), workspace);
  await service.synchronize("user-1", workspace.id);
  assert.deepEqual(prepared.sort(), ["groups/workspace-1/repositories/project-11", "groups/workspace-1/repositories/project-12"].sort());
  assert.equal(repositoryLinks.size, 2);
  assert.deepEqual([...checkoutRecords.values()].map((item) => item.status), ["INITIALIZING", "INITIALIZING"]);
});

test("Group Workspace checkout paths reject traversal and symlinks", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "qolmes-group-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(safeWorkspacePath(root, "../outside"), /escapes/);
  const outside = await mkdtemp(resolve(tmpdir(), "qolmes-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(resolve(root, "groups"));
  await symlink(outside, resolve(root, "groups/link"));
  await assert.rejects(safeWorkspacePath(root, "groups/link/repo"), /symlinks/);
});
