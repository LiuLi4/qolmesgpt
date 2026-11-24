import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MemoryWorkspaceStore } from "../dist/workspace/memory.js";
import { WorkspaceManager } from "../dist/workspace/manager.js";
import type { GitRunner } from "../dist/workspace/types.js";

class FakeGit implements GitRunner {
  readonly calls: string[][] = [];
  readonly outputs: Record<string, string> = {
    "config --get remote.origin.url": "https://gitlab.example/acme/service.git",
    "rev-parse HEAD": "abc123",
    "branch --show-current": "main",
    "status --porcelain": "",
  };

  async run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    return this.outputs[args.join(" ")] ?? "";
  }
}

async function setup(now: () => Date = () => new Date()) {
  const root = await mkdtemp(join(tmpdir(), "qolmesgpt-workspace-"));
  const store = new MemoryWorkspaceStore();
  const git = new FakeGit();
  const manager = new WorkspaceManager(root, store, git, now);
  return { root, store, git, manager };
}

test("creates and reuses one project checkout with safe relative paths", async (t) => {
  const { root, manager, git } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { projectId: "project-1", remoteUrl: "https://gitlab.example/acme/service.git", defaultBranch: "main", relativePath: "projects/project-1" };
  const first = await manager.ensureWorkspace(project);
  const second = await manager.ensureWorkspace(project);
  assert.equal(first.record.id, second.record.id);
  assert.equal(first.record.status, "READY");
  assert.equal(first.absolutePath, join(root, "projects/project-1"));
  assert.equal(git.calls.filter((args) => args[0] === "clone").length, 1);
});

test("rejects traversal and symlink workspace paths", async (t) => {
  const { root, manager } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(manager.workspacePath("../outside"), /escapes/);
  const outside = await mkdtemp(join(tmpdir(), "qolmesgpt-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, "linked"));
  await assert.rejects(manager.workspacePath("linked/project"), /symlink/);
});

test("project checkout reuses equivalent SSH origins but rejects a different repository", async (t) => {
  const { root, manager, git } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = { projectId: "project-1", remoteUrl: "http://gitlab.example/acme/service.git", defaultBranch: "main", relativePath: "projects/project-1" };
  await manager.ensureWorkspace(project);
  for (const remote of ["git@gitlab.example:acme/service.git", "ssh://git@gitlab.example/acme/service.git"]) {
    git.outputs["config --get remote.origin.url"] = remote;
    assert.equal((await manager.ensureWorkspace(project)).record.status, "READY");
  }
  git.outputs["config --get remote.origin.url"] = "git@gitlab.example:acme/other.git";
  await assert.rejects(manager.ensureWorkspace(project), /origin remote does not match/);
});

test("serializes concurrent locks and rejects stale fencing tokens", async (t) => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const { root, manager, store } = await setup(() => now);
  t.after(() => rm(root, { recursive: true, force: true }));
  await manager.ensureWorkspace({ projectId: "project-1", remoteUrl: "https://gitlab.example/acme/service", defaultBranch: "main", relativePath: "projects/project-1" });
  const first = await manager.acquireLock("project-1", "worker-1");
  await assert.rejects(manager.acquireLock("project-1", "worker-2"), /occupied/);
  await manager.assertLease(first);
  now = new Date("2026-01-01T00:20:00.000Z");
  const expiredManager = new WorkspaceManager(root, store, new FakeGit(), () => now);
  const second = await expiredManager.acquireLock("project-1", "worker-2");
  await assert.rejects(manager.assertLease(first), /no longer valid/);
  await assert.rejects(manager.releaseLock(first), /no longer owned/);
  await expiredManager.releaseLock(second);
});

test("dirty workspace blocks synchronization", async (t) => {
  const { root, manager, git } = await setup();
  t.after(() => rm(root, { recursive: true, force: true }));
  await manager.ensureWorkspace({ projectId: "project-1", remoteUrl: "https://gitlab.example/acme/service", defaultBranch: "main", relativePath: "projects/project-1" });
  git.outputs["status --porcelain"] = " M src/app.ts";
  await assert.rejects(manager.sync("project-1", "https://gitlab.example/acme/service", "main"), /uncommitted/);
});
