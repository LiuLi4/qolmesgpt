import { PrismaPg } from "@prisma/adapter-pg";
import { decryptSecret, encryptSecret, NsjailExecutionRunner, loadCredentialKey } from "@qolmesgpt/security";
import { PrismaClient } from "../generated/prisma/client.js";
import { gitBeakerApiFactory } from "../integrations/gitlab/gitbeaker.js";
import { FetchGitLabOAuthClient } from "../integrations/gitlab/oauth.js";
import { PrismaGitLabConnectionStore, PrismaOAuthStateStore } from "../integrations/gitlab/prisma.js";
import { PrismaRepairStore } from "./repair-prisma.js";
import { PrismaWorkspaceLeaseManager } from "./workspace-lease.js";
import { GitLabService } from "../integrations/gitlab/service.js";

export async function createRepairRuntime(): Promise<{
  outbox: PrismaRepairStore;
  repair: PrismaRepairStore;
  workspace: PrismaWorkspaceLeaseManager;
  executor: NsjailExecutionRunner;
  roles: { getApprovalRole: (userId: string, connectionId: string, groupId: string) => Promise<{ role: string; eligible: boolean }> };
  config: { workspaceRoot: string; jailRoot: string };
  close: () => Promise<void>;
}> {
  const connectionString = process.env.DATABASE_URL;
  const workspaceRoot = process.env.QOLMESGPT_WORKSPACE_ROOT;
  const jailRoot = process.env.QOLMESGPT_REPAIR_JAIL_ROOT;
  const instanceUrl = process.env.GITLAB_INSTANCE_URL ?? "https://gitlab.com";
  const clientId = process.env.GITLAB_OAUTH_CLIENT_ID;
  const redirectUri = process.env.GITLAB_OAUTH_REDIRECT_URI;
  if (!connectionString || !workspaceRoot || !jailRoot || !clientId || !redirectUri) throw new Error("DATABASE_URL, credential key, workspace root, repair jail root and GitLab OAuth settings are required");
  const { keyVersion, keys } = await loadCredentialKey();
  const cipher = { encrypt: (value: string) => encryptSecret(value, keyVersion, keys), decrypt: (value: string) => decryptSecret(JSON.parse(value), keys) };
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const gitlab = new GitLabService({
    connections: new PrismaGitLabConnectionStore(prisma),
    oauthStates: new PrismaOAuthStateStore(prisma),
    apiFactory: gitBeakerApiFactory,
    oauthClient: new FetchGitLabOAuthClient(),
    oauthConfig: { clientId, clientSecret: process.env.GITLAB_OAUTH_CLIENT_SECRET, redirectUri, scopes: ["api", "read_user"] },
    cipher,
    keyVersion,
  });
  const store = new PrismaRepairStore(prisma, workspaceRoot);
  return { outbox: store, repair: store, workspace: new PrismaWorkspaceLeaseManager(prisma), executor: new NsjailExecutionRunner(), roles: gitlab, config: { workspaceRoot, jailRoot }, close: () => prisma.$disconnect() };
}
