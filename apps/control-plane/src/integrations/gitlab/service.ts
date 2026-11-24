import { createPkceChallenge, createPkceVerifier, createOAuthState as generateState, hashOAuthState, normalizeGitLabUrl } from "./crypto.js";
import { canApproveGitLabRole, mapGitLabRole } from "./roles.js";
import type {
  GitLabApiFactory,
  GitLabConnectionRecord,
  GitLabConnectionStore,
  GitLabGroupSummary,
  GitLabOAuthClient,
  GitLabOAuthConfig,
  GitLabPage,
  GitLabProjectSummary,
  OAuthStateStore,
  SecretCipher,
} from "./types.js";
import { serializeEncryptedSecret } from "./types.js";

export interface GitLabConnectionSummary {
  readonly id: string;
  readonly instanceUrl: string;
  readonly authType: "OAUTH" | "PAT";
  readonly status: "ACTIVE" | "INVALID" | "REVOKED";
  readonly expiresAt: string | null;
  readonly hasCredential: true;
  readonly credentialKeyVersion: string;
}

export interface GitLabServiceDependencies {
  readonly connections: GitLabConnectionStore;
  readonly oauthStates: OAuthStateStore;
  readonly apiFactory: GitLabApiFactory;
  readonly oauthClient: GitLabOAuthClient;
  readonly oauthConfig: GitLabOAuthConfig;
  readonly cipher: SecretCipher;
  readonly keyVersion: string;
  readonly now?: () => Date;
}

function safeConnection(connection: GitLabConnectionRecord): GitLabConnectionSummary {
  return {
    id: connection.id,
    instanceUrl: connection.instanceUrl,
    authType: connection.authType,
    status: connection.status,
    expiresAt: connection.expiresAt?.toISOString() ?? null,
    hasCredential: true,
    credentialKeyVersion: connection.credentialKeyVersion,
  };
}

export class GitLabService {
  private readonly now: () => Date;

  constructor(private readonly deps: GitLabServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async startOAuth(userId: string, input: { instanceUrl: string }): Promise<{ authorizationUrl: string; expiresAt: string }> {
    if (!this.deps.oauthConfig.clientId.trim()) {
      throw new Error("GitLab OAuth is not configured. Set GITLAB_OAUTH_CLIENT_ID and register the callback URL in GitLab.");
    }
    const instanceUrl = normalizeGitLabUrl(input.instanceUrl);
    const state = generateState();
    const verifier = createPkceVerifier();
    const expiresAt = new Date(this.now().getTime() + (this.deps.oauthConfig.stateTtlMs ?? 10 * 60_000));
    await this.deps.oauthStates.create({
      userId,
      instanceUrl,
      stateHash: hashOAuthState(state),
      codeVerifierCiphertext: serializeEncryptedSecret(this.deps.cipher.encrypt(verifier)),
      expiresAt,
    });
    const config = this.deps.oauthConfig;
    return {
      authorizationUrl: this.deps.oauthClient.authorizationUrl({
        instanceUrl,
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        scopes: config.scopes,
        state,
        codeChallenge: createPkceChallenge(verifier),
      }),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async completeOAuth(userId: string, input: { state?: string; code?: string; error?: string; errorDescription?: string }): Promise<GitLabConnectionSummary> {
    if (input.error) throw new Error(`GitLab authorization denied: ${input.errorDescription ?? input.error}`);
    if (!input.state || !input.code) throw new Error("GitLab OAuth callback requires state and code");
    const record = await this.deps.oauthStates.consume(userId, hashOAuthState(input.state), this.now());
    if (!record) throw new Error("GitLab OAuth state is invalid, expired, or already used");
    const verifier = this.deps.cipher.decrypt(record.codeVerifierCiphertext);
    const config = this.deps.oauthConfig;
    const token = await this.deps.oauthClient.exchangeCode({
      instanceUrl: record.instanceUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      code: input.code,
      codeVerifier: verifier,
    });
    const api = this.deps.apiFactory.create(record.instanceUrl, token.accessToken);
    await this.validateAuthenticatedAccess(api);
    const connection = await this.deps.connections.upsert({
      userId,
      instanceUrl: record.instanceUrl,
      authType: "OAUTH",
      accessTokenCiphertext: serializeEncryptedSecret(this.deps.cipher.encrypt(token.accessToken)),
      refreshTokenCiphertext: token.refreshToken ? serializeEncryptedSecret(this.deps.cipher.encrypt(token.refreshToken)) : null,
      credentialKeyVersion: this.deps.keyVersion,
      expiresAt: token.expiresIn ? new Date(this.now().getTime() + token.expiresIn * 1000) : null,
    });
    return safeConnection(connection);
  }

  async connectPAT(userId: string, input: { instanceUrl: string; personalAccessToken: string }): Promise<GitLabConnectionSummary> {
    const instanceUrl = normalizeGitLabUrl(input.instanceUrl);
    if (!input.personalAccessToken.trim()) throw new Error("GitLab PAT is required");
    const api = this.deps.apiFactory.create(instanceUrl, input.personalAccessToken);
    await this.validateAuthenticatedAccess(api);
    const connection = await this.deps.connections.upsert({
      userId,
      instanceUrl,
      authType: "PAT",
      accessTokenCiphertext: serializeEncryptedSecret(this.deps.cipher.encrypt(input.personalAccessToken)),
      refreshTokenCiphertext: null,
      credentialKeyVersion: this.deps.keyVersion,
      expiresAt: null,
    });
    return safeConnection(connection);
  }

  async listGroups(userId: string, connectionId: string, page = 1): Promise<GitLabPage<GitLabGroupSummary>> {
    const api = await this.apiFor(userId, connectionId);
    return api.listGroups(page);
  }

  async getGroup(userId: string, connectionId: string, groupId: string): Promise<GitLabGroupSummary> {
    return (await this.apiFor(userId, connectionId)).getGroup(groupId);
  }

  async listWorkspaceProjects(userId: string, connectionId: string, groupId: string): Promise<GitLabProjectSummary[]> {
    const api = await this.apiFor(userId, connectionId);
    const result = new Map<string, GitLabProjectSummary>();
    let page = 1;
    for (let count = 0; count < 1_000; count++) {
      const response = await api.listGroupProjects(groupId, page, true);
      for (const project of response.items) result.set(project.id, project);
      if (!response.nextPage) return [...result.values()];
      if (response.nextPage <= page) throw new Error("Invalid GitLab project pagination");
      page = response.nextPage;
    }
    throw new Error("GitLab Group exceeds the 100000-project synchronization limit");
  }

  async listProjects(userId: string, connectionId: string, groupId: string, page = 1): Promise<GitLabPage<GitLabProjectSummary>> {
    const api = await this.apiFor(userId, connectionId);
    return api.listGroupProjects(groupId, page);
  }

  async getApprovalRole(userId: string, connectionId: string, groupId: string): Promise<{ role: ReturnType<typeof mapGitLabRole>; eligible: boolean; checkedAt: string }> {
    const api = await this.apiFor(userId, connectionId);
    const user = await api.currentUser();
    const membership = await api.getGroupMembership(groupId, user.id);
    const role = mapGitLabRole(membership.accessLevel);
    return { role, eligible: canApproveGitLabRole(role), checkedAt: this.now().toISOString() };
  }

  async getAccessToken(userId: string, connectionId: string): Promise<string> {
    const connection = await this.deps.connections.findById(userId, connectionId);
    if (!connection || connection.status !== "ACTIVE") throw new Error("GitLab connection is unavailable");
    if (connection.expiresAt && connection.expiresAt <= this.now()) throw new Error("GitLab connection has expired");
    return this.deps.cipher.decrypt(connection.accessTokenCiphertext);
  }

  private async apiFor(userId: string, connectionId: string) {
    const connection = await this.deps.connections.findById(userId, connectionId);
    if (!connection || connection.status !== "ACTIVE") throw new Error("GitLab connection is unavailable");
    if (connection.expiresAt && connection.expiresAt <= this.now()) throw new Error("GitLab connection has expired");
    const accessToken = this.deps.cipher.decrypt(connection.accessTokenCiphertext);
    return this.deps.apiFactory.create(connection.instanceUrl, accessToken);
  }

  private async validateAuthenticatedAccess(api: Awaited<ReturnType<GitLabService["apiFor"]>>): Promise<void> {
    await api.currentUser();
    await api.listGroups(1);
  }
}
