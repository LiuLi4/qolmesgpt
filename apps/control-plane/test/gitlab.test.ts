import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { MemoryGitLabConnectionStore, MemoryOAuthStateStore } from "../dist/integrations/gitlab/memory.js";
import { GitLabService } from "../dist/integrations/gitlab/service.js";
import { normalizeGitLabUrl } from "../dist/integrations/gitlab/crypto.js";
import { canApproveGitLabRole, mapGitLabRole } from "../dist/integrations/gitlab/roles.js";
import { GitBeakerApi, gitBeakerApiFactory } from "../dist/integrations/gitlab/gitbeaker.js";
import type {
  GitLabApi,
  GitLabApiFactory,
  GitLabOAuthClient,
  SecretCipher,
} from "../dist/integrations/gitlab/types.js";

const cipher: SecretCipher = {
  encrypt: (value) => ({ algorithm: "aes-256-gcm", keyVersion: "test", iv: "iv", authTag: "tag", ciphertext: Buffer.from(value).toString("base64url") }),
  decrypt: (value) => Buffer.from(JSON.parse(value).ciphertext, "base64url").toString("utf8"),
};

class FakeApi implements GitLabApi {
  readonly token: string;
  private readonly valid: boolean;

  constructor(token: string, valid = true) {
    this.token = token;
    this.valid = valid;
  }

  async currentUser() {
    if (!this.valid) throw new Error("unauthorized");
    return { id: 7, username: "alice", name: "Alice" };
  }

  async getGroup(groupId: string) {
    return { id: groupId, fullPath: "acme", name: "acme", role: "DEVELOPER" as const, roleCheckedAt: null };
  }

  async listGroups() {
    if (!this.valid) throw new Error("insufficient scope");
    return { items: [{ id: "1", fullPath: "acme", name: "acme", role: "DEVELOPER" as const, roleCheckedAt: null }], nextPage: null, nextCursor: null };
  }

  async listGroupProjects(groupId: string) {
    return { items: [{ id: "11", groupId, name: "service", pathWithNamespace: "acme/service", defaultBranch: "main", webUrl: "https://gitlab.example/acme/service" }], nextPage: null, nextCursor: null };
  }

  async getGroupMembership(_groupId: string, userId: number) {
    return { userId, accessLevel: 30 };
  }
}

function setup(options: { now?: () => Date; valid?: boolean; apiFactory?: GitLabApiFactory } = {}) {
  const connections = new MemoryGitLabConnectionStore();
  const oauthStates = new MemoryOAuthStateStore();
  const apiFactory: GitLabApiFactory = options.apiFactory ?? { create: (_instanceUrl, token) => new FakeApi(token, options.valid ?? true) };
  const oauthClient: GitLabOAuthClient = {
    authorizationUrl: ({ instanceUrl, state }) => `${instanceUrl}/oauth/authorize?state=${encodeURIComponent(state)}`,
    exchangeCode: async () => ({ accessToken: "oauth-token", refreshToken: "refresh-token", expiresIn: 3600 }),
  };
  const service = new GitLabService({
    connections,
    oauthStates,
    apiFactory,
    oauthClient,
    oauthConfig: { clientId: "client", redirectUri: "https://qolmes.example/callback", scopes: ["api"], stateTtlMs: 1_000 },
    cipher,
    keyVersion: "test",
    now: options.now,
  });
  return { service, connections };
}

test("OAuth start fails clearly when the client is not configured", async () => {
  const unconfigured = new GitLabService({
    connections: new MemoryGitLabConnectionStore(),
    oauthStates: new MemoryOAuthStateStore(),
    apiFactory: { create: (_instanceUrl, token) => new FakeApi(token) },
    oauthClient: {
      authorizationUrl: () => "",
      exchangeCode: async () => ({ accessToken: "token" }),
    },
    oauthConfig: { clientId: "", redirectUri: "http://127.0.0.1:5050/api/gitlab/oauth/callback", scopes: ["api"] },
    cipher,
    keyVersion: "test",
  });
  await assert.rejects(
    unconfigured.startOAuth("user-1", { instanceUrl: "http://git.quantgroup.cn" }),
    /GitLab OAuth is not configured.*GITLAB_OAUTH_CLIENT_ID/,
  );
});

test("GitLab instance URLs accept HTTP and HTTPS without embedded credentials", () => {
  assert.equal(normalizeGitLabUrl("http://git.quantgroup.cn/"), "http://git.quantgroup.cn");
  assert.equal(normalizeGitLabUrl("https://gitlab.example/"), "https://gitlab.example");
  assert.throws(() => normalizeGitLabUrl("ftp://gitlab.example"), /HTTP or HTTPS/);
  assert.throws(() => normalizeGitLabUrl("http://user:password@gitlab.example"), /without credentials/);
  assert.throws(() => normalizeGitLabUrl("http://gitlab.example?token=secret"), /without credentials or query parameters/);
});

test("PAT connections can use an HTTP GitLab instance", async () => {
  const { service, connections } = setup();
  const connection = await service.connectPAT("user-1", {
    instanceUrl: "http://git.quantgroup.cn",
    personalAccessToken: "http-token",
  });
  assert.equal(connection.instanceUrl, "http://git.quantgroup.cn");
  assert.equal(connections.all().length, 1);
});

test("valid OAuth callback creates an encrypted connection and consumes state once", async () => {
  const { service, connections } = setup();
  const started = await service.startOAuth("user-1", { instanceUrl: "https://gitlab.example/" });
  const state = new URL(started.authorizationUrl).searchParams.get("state")!;

  const connection = await service.completeOAuth("user-1", { state, code: "auth-code" });
  assert.equal(connection.authType, "OAUTH");
  assert.equal(connection.hasCredential, true);
  assert.equal(connections.all().length, 1);
  assert.doesNotMatch(connections.all()[0]!.accessTokenCiphertext, /oauth-token/);
  await assert.rejects(service.completeOAuth("user-1", { state, code: "auth-code" }), /invalid, expired, or already used/);
});

test("invalid, expired, and denied OAuth callbacks preserve an existing connection", async () => {
  let current = new Date("2026-01-01T00:00:00.000Z");
  const { service, connections } = setup({ now: () => current });
  await service.connectPAT("user-1", { instanceUrl: "https://gitlab.example", personalAccessToken: "old-token" });

  await assert.rejects(service.completeOAuth("user-1", { state: "wrong", code: "code" }), /invalid, expired, or already used/);
  await assert.rejects(service.completeOAuth("user-1", { error: "access_denied" }), /authorization denied/);
  const started = await service.startOAuth("user-1", { instanceUrl: "https://gitlab.example" });
  const state = new URL(started.authorizationUrl).searchParams.get("state")!;
  current = new Date("2026-01-01T00:00:02.000Z");
  await assert.rejects(service.completeOAuth("user-1", { state, code: "code" }), /invalid, expired, or already used/);

  assert.equal(connections.all().length, 1);
  assert.equal(cipher.decrypt(connections.all()[0]!.accessTokenCiphertext), "old-token");
});

test("invalid PAT does not replace an existing connection and projects use connection scope", async () => {
  const { service, connections } = setup({ valid: false });
  await assert.rejects(service.connectPAT("user-1", { instanceUrl: "https://gitlab.example", personalAccessToken: "bad" }), /unauthorized/);
  assert.equal(connections.all().length, 0);

  const valid = setup();
  await valid.service.connectPAT("user-1", { instanceUrl: "https://gitlab.example", personalAccessToken: "good" });
  const connectionId = valid.connections.all()[0]!.id;
  const projects = await valid.service.listProjects("user-1", connectionId, "1");
  assert.equal(projects.items[0]!.pathWithNamespace, "acme/service");
  const role = await valid.service.getApprovalRole("user-1", connectionId, "1");
  assert.deepEqual(role.role, "DEVELOPER");
  assert.equal(role.eligible, true);
});

test("only Developer, Maintainer, and Owner roles can approve", () => {
  assert.equal(canApproveGitLabRole(mapGitLabRole(30)), true);
  assert.equal(canApproveGitLabRole(mapGitLabRole(40)), true);
  assert.equal(canApproveGitLabRole(mapGitLabRole(50)), true);
  assert.equal(canApproveGitLabRole(mapGitLabRole(20)), false);
  assert.equal(canApproveGitLabRole(mapGitLabRole(10)), false);
  assert.equal(canApproveGitLabRole(mapGitLabRole(undefined)), false);
});

test("GitBeaker adapter maps expanded responses and pagination safely", async () => {
  const fakeClient = {
    Users: { showCurrentUser: async () => ({ id: 7, username: "alice", name: "Alice" }) },
    Groups: {
      all: async () => ({ data: [{ id: 1, name: "Acme", full_path: "acme", group_access_level: 40 }], paginationInfo: { next: 2 } }),
      allProjects: async () => ({ data: [{ id: 11, name: "Service", path_with_namespace: "acme/service", default_branch: "main", web_url: "https://gitlab.example/acme/service" }], paginationInfo: { next: null } }),
    },
    GroupMembers: { show: async () => ({ id: 7, access_level: 50 }) },
  };
  const api = new GitBeakerApi(fakeClient as never);
  const groups = await api.listGroups(1);
  assert.equal(groups.items[0]!.role, "MAINTAINER");
  assert.equal(groups.nextPage, 2);
  const projects = await api.listGroupProjects("1", 1);
  assert.equal(projects.items[0]!.pathWithNamespace, "acme/service");
  assert.equal(projects.nextPage, null);
  assert.equal((await api.getGroupMembership("1", 7)).accessLevel, 50);
});

test("PAT validation and group/project pagination use real GitBeaker list responses", async (t) => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    requests.push(url.pathname + url.search);
    res.setHeader("content-type", "application/json");
    if (req.headers["private-token"] !== "fixture-token") {
      res.writeHead(401);
      res.end(JSON.stringify({ message: "Unauthorized" }));
      return;
    }
    if (url.pathname === "/api/v4/user") {
      res.end(JSON.stringify({ id: 7, username: "alice", name: "Alice" }));
      return;
    }
    const page = url.searchParams.get("page") ?? "1";
    res.setHeader("x-page", page);
    res.setHeader("x-next-page", page === "1" ? "2" : "");
    res.setHeader("x-per-page", "100");
    res.setHeader("x-total-pages", "2");
    if (url.pathname === "/api/v4/groups") {
      res.end(JSON.stringify([{ id: Number(page), name: `Team ${page}`, full_path: `team-${page}` }]));
      return;
    }
    if (url.pathname === "/api/v4/groups/1/projects") {
      res.end(JSON.stringify(page === "1" ? [{ id: 11, name: "Service", path_with_namespace: "team-1/service", default_branch: "main", web_url: "http://gitlab.example/team-1/service" }] : []));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ message: "Not found" }));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { service, connections } = setup({ apiFactory: gitBeakerApiFactory });
  const connection = await service.connectPAT("user-1", {
    instanceUrl: `http://127.0.0.1:${address.port}`,
    personalAccessToken: "fixture-token",
  });
  assert.equal(connections.all().length, 1);
  const firstGroups = await service.listGroups("user-1", connection.id, 1);
  assert.equal(firstGroups.items[0]!.fullPath, "team-1");
  assert.equal(firstGroups.nextPage, 2);
  assert.equal(firstGroups.nextCursor, null);
  const lastGroups = await service.listGroups("user-1", connection.id, 2);
  assert.equal(lastGroups.items[0]!.fullPath, "team-2");
  assert.equal(lastGroups.nextPage, null);
  const firstProjects = await service.listProjects("user-1", connection.id, "1", 1);
  assert.equal(firstProjects.items[0]!.pathWithNamespace, "team-1/service");
  assert.equal(firstProjects.nextPage, 2);
  const lastProjects = await service.listProjects("user-1", connection.id, "1", 2);
  assert.deepEqual(lastProjects.items, []);
  assert.equal(lastProjects.nextPage, null);
  const workspaceProjects = await service.listWorkspaceProjects("user-1", connection.id, "1");
  assert.deepEqual(workspaceProjects.map((project) => project.pathWithNamespace), ["team-1/service"]);
  assert.ok(requests.some((request) => request.includes("include_subgroups=true") && request.includes("with_shared=false")));
  assert.equal(requests.length, 8);
});
