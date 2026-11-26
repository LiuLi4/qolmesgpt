import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GitRepositoryCheckout, GroupWorkspaceService, safeWorkspacePath, type RepositoryCheckout } from "../dist/workspace/group.js";

const git = promisify(execFile);

test("checkout accepts equivalent HTTP and SSH origins and preserves repository identity and local edits", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "qolmes-checkout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = resolve(root, "repo");
  await git("git", ["init", "--initial-branch=main", path]);
  await git("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"], { cwd: path });
  await git("git", ["remote", "add", "origin", "http://git.example/group/Service.git"], { cwd: path });
  const checkout = new GitRepositoryCheckout(root);
  const input = { relativePath: "repo", remoteUrl: "http://git.example/group/Service.git", branch: "main", token: "fixture-token" };
  const headSha = (await git("git", ["rev-parse", "HEAD"], { cwd: path })).stdout.trim();
  for (const remote of ["http://git.example/group/Service.git", "https://GIT.EXAMPLE/group/Service.git/", "git@git.example:group/Service.git", "ssh://git@git.example/group/Service.git"]) {
    await git("git", ["remote", "set-url", "origin", remote], { cwd: path });
    assert.deepEqual(await checkout.prepare(input), { headSha, branch: "main", status: "READY" });
  }
  for (const remote of ["git@other.example:group/Service.git", "git@git.example:group/Other.git", "git@git.example:group/service.git", "ssh://git@git.example:2222/group/Service.git"]) {
    await git("git", ["remote", "set-url", "origin", remote], { cwd: path });
    await assert.rejects(checkout.prepare(input), /origin does not match/);
  }
  for (const remote of ["http://user:password@git.example/group/Service.git", "http://git.example/group/Service.git?query=1", "http://git.example/group/Service.git#fragment", "ssh://root@git.example/group/Service.git", "file:///group/Service.git"]) {
    await git("git", ["remote", "set-url", "origin", remote], { cwd: path });
    await assert.rejects(checkout.prepare(input), /Invalid GitLab repository URL/);
  }
  await git("git", ["remote", "set-url", "origin", input.remoteUrl], { cwd: path });
  await writeFile(resolve(path, "local.txt"), "keep local edits");
  assert.equal((await checkout.prepare(input)).status, "DIRTY");
});

test("HTTP clone ignores global SSH rewrites and authenticates with the configured token", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "qolmes-http-clone-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = resolve(root, "source");
  await git("git", ["init", "--initial-branch=main", source]);
  await git("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"], { cwd: source });
  const authorization = `Basic ${Buffer.from("oauth2:fixture-token").toString("base64")}`;
  const received: string[] = [];
  const server = createServer(async (req, res) => {
    received.push(req.headers.authorization ?? "");
    if (req.headers.authorization !== authorization) { res.writeHead(401); res.end(); return; }
    if (req.method === "GET" && req.url === "/group/repo.git/info/refs?service=git-upload-pack") {
      res.setHeader("content-type", "application/x-git-upload-pack-advertisement");
      const service = "# service=git-upload-pack\n";
      res.write((Buffer.byteLength(service) + 4).toString(16).padStart(4, "0") + service + "0000");
      const { stdout } = await git("git", ["upload-pack", "--stateless-rpc", "--advertise-refs", source], { encoding: "buffer" });
      res.end(stdout);
    } else if (req.method === "POST" && req.url === "/group/repo.git/git-upload-pack") {
      res.setHeader("content-type", "application/x-git-upload-pack-result");
      const child = spawn("git", ["upload-pack", "--stateless-rpc", source]);
      req.pipe(child.stdin);
      child.stdout.pipe(res);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const remoteUrl = `http://127.0.0.1:${address.port}/group/repo.git`;
  const globalConfig = resolve(root, "global.gitconfig");
  await writeFile(globalConfig, `[url "ssh://git@127.0.0.1:1/"]\n\tinsteadOf = http://127.0.0.1:${address.port}/\n`);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  t.after(() => { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; });
  const checkout = new GitRepositoryCheckout(root);
  assert.equal((await checkout.prepare({ relativePath: "checkout", remoteUrl, branch: "main", token: "fixture-token" })).status, "READY");
  assert.ok(received.length >= 2);
  assert.ok(received.every((header) => header === authorization));
  assert.equal((await checkout.prepare({ relativePath: "checkout", remoteUrl, branch: "main", token: "fixture-token" })).status, "READY");
});

test("a Group Workspace enrolls every accessible descendant repository and prepares an isolated checkout", async () => {
  const workspace = { id: "workspace-1", groupId: "root-1", relativePath: "groups/workspace-1", status: "INITIALIZING" };
  const repositoryLinks = new Map<string, { workspaceId: string; projectId: string; active: boolean }>();
  const checkoutRecords = new Map<string, { id: string; relativePath: string; status: string }>();
  const fakePrisma = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(fakePrisma),
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


test("synchronization claim rejects a concurrent manual configuration committed after the initial read", async () => {
  const prisma = {
    groupWorkspace: {
      findFirst: async () => ({ id: "w", repositoryConfigManaged: false, repositoryConfigVersion: 0 }),
      updateMany: async ({where}: {where: Record<string,unknown>}) => {
        assert.equal(where.repositoryConfigManaged,false);
        assert.equal(where.repositoryConfigVersion,0);
        return { count: 0 };
      },
    },
  };
  await assert.rejects(new GroupWorkspaceService(prisma as never,{} as never,"/unused").synchronize("u","w"),/already running/);
});
