import type { EncryptedSecret } from "@qolmesgpt/security";

export type GitLabRole = "DEVELOPER" | "MAINTAINER" | "OWNER" | "REPORTER" | "GUEST" | "UNKNOWN";

export interface GitLabUser {
  readonly id: number;
  readonly username: string;
  readonly name: string;
}

export interface GitLabGroupSummary {
  readonly id: string;
  readonly fullPath: string;
  readonly name: string;
  readonly role: GitLabRole;
  readonly roleCheckedAt: string | null;
}

export interface GitLabProjectSummary {
  readonly id: string;
  readonly groupId: string;
  readonly name: string;
  readonly pathWithNamespace: string;
  readonly defaultBranch: string;
  readonly webUrl: string;
  readonly namespacePath?: string;
  readonly remoteUrl?: string;
}

export interface GitLabPage<T> {
  readonly items: readonly T[];
  readonly nextPage: number | null;
  readonly nextCursor: string | null;
}

export interface GitLabMembership {
  readonly userId: number;
  readonly accessLevel: number | string;
}

export interface GitLabApi {
  currentUser(): Promise<GitLabUser>;
  getProject?(projectId: string): Promise<GitLabProjectSummary>;
  listBranches?(projectId: string, page?: number): Promise<GitLabPage<{ name: string; commitSha: string }>>;
  getBranch?(projectId: string, branch: string): Promise<{ name: string; commitSha: string }>;
  getGroup(groupId: string): Promise<GitLabGroupSummary>;
  listGroups(page?: number): Promise<GitLabPage<GitLabGroupSummary>>;
  listGroupProjects(groupId: string, page?: number, includeSubgroups?: boolean): Promise<GitLabPage<GitLabProjectSummary>>;
  getGroupMembership(groupId: string, userId: number): Promise<GitLabMembership>;
}

export interface GitLabApiFactory {
  create(instanceUrl: string, accessToken: string): GitLabApi;
}

export interface OAuthStateRecord {
  readonly id: string;
  readonly userId: string;
  readonly instanceUrl: string;
  readonly stateHash: string;
  readonly codeVerifierCiphertext: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface OAuthStateStore {
  create(input: Omit<OAuthStateRecord, "id" | "consumedAt">): Promise<OAuthStateRecord>;
  consume(userId: string, stateHash: string, now: Date): Promise<OAuthStateRecord | null>;
}

export interface GitLabConnectionRecord {
  readonly id: string;
  readonly userId: string;
  readonly instanceUrl: string;
  readonly authType: "OAUTH" | "PAT";
  readonly accessTokenCiphertext: string;
  readonly refreshTokenCiphertext: string | null;
  readonly credentialKeyVersion: string;
  readonly expiresAt: Date | null;
  readonly status: "ACTIVE" | "INVALID" | "REVOKED";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface GitLabConnectionStore {
  upsert(input: {
    userId: string;
    instanceUrl: string;
    authType: "OAUTH" | "PAT";
    accessTokenCiphertext: string;
    refreshTokenCiphertext: string | null;
    credentialKeyVersion: string;
    expiresAt: Date | null;
  }): Promise<GitLabConnectionRecord>;
  findById(userId: string, connectionId: string): Promise<GitLabConnectionRecord | null>;
}

export interface GitLabOAuthConfig {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly stateTtlMs?: number;
}

export interface GitLabOAuthClient {
  authorizationUrl(input: {
    instanceUrl: string;
    clientId: string;
    redirectUri: string;
    scopes: readonly string[];
    state: string;
    codeChallenge: string;
  }): string;
  exchangeCode(input: {
    instanceUrl: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
  }): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }>;
}

export interface SecretCipher {
  encrypt(value: string): EncryptedSecret;
  decrypt(value: string): string;
}

export function serializeEncryptedSecret(value: EncryptedSecret): string {
  return JSON.stringify(value);
}

export function parseEncryptedSecret(value: string): EncryptedSecret {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || (parsed as { algorithm?: unknown }).algorithm !== "aes-256-gcm") {
    throw new Error("Invalid encrypted secret payload");
  }
  return parsed as EncryptedSecret;
}
