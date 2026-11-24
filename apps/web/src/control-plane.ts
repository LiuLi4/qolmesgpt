import {
  ApprovalRoutes,
  DataSourceRoutes,
  FetchGitLabOAuthClient,
  GitLabService,
  GroupWorkspaceService,
  PrismaApprovalStore,
  PrismaClient,
  PrismaGitLabConnectionStore,
  PrismaOAuthStateStore,
  PrismaPg,
  PrismaSlsDataSourceWriter,
  PrismaSlsDetectionStore,
  PrismaSlsVerificationStore,
  gitBeakerApiFactory,
} from "@qolmesgpt/control-plane";
import { decryptSecret, encryptSecret, loadCredentialKey } from "@qolmesgpt/security";
import { join } from "node:path";

export interface WebRuntime {
  readonly prisma: InstanceType<typeof PrismaClient>;
  readonly userId: string;
  readonly sls: DataSourceRoutes;
  readonly detection: PrismaSlsDetectionStore;
  readonly gitlab: GitLabService;
  readonly workspaces: GroupWorkspaceService;
  readonly approvals: ApprovalRoutes;
  readonly close: () => Promise<void>;
}

let runtime: WebRuntime | undefined;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the real control-plane connection`);
  return value;
}

async function createRuntime(): Promise<WebRuntime> {
  const connectionString = required("DATABASE_URL");
  const { keyVersion, keys } = await loadCredentialKey();
  const cipher = {
    encrypt: (value: string) => encryptSecret(value, keyVersion, keys),
    decrypt: (value: string) => decryptSecret(JSON.parse(value), keys),
  };
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const subject = process.env.QOLMESGPT_WEB_AUTH_SUBJECT ?? "local-web-user";
  const user = await prisma.user.upsert({ where: { authSubject: subject }, create: { authSubject: subject }, update: {} });
  const gitlab = new GitLabService({
    connections: new PrismaGitLabConnectionStore(prisma),
    oauthStates: new PrismaOAuthStateStore(prisma),
    apiFactory: gitBeakerApiFactory,
    oauthClient: new FetchGitLabOAuthClient(),
    oauthConfig: {
      clientId: process.env.GITLAB_OAUTH_CLIENT_ID ?? "",
      clientSecret: process.env.GITLAB_OAUTH_CLIENT_SECRET,
      redirectUri: process.env.GITLAB_OAUTH_REDIRECT_URI ?? "http://127.0.0.1:5050/api/gitlab/oauth/callback",
      scopes: ["api", "read_user"],
    },
    cipher,
    keyVersion,
  });
  const workspaces = new GroupWorkspaceService(prisma, gitlab, process.env.QOLMESGPT_WORKSPACE_ROOT ?? join(process.cwd(), ".qolmesgpt-workspaces"));
  const sls = new DataSourceRoutes(
    new PrismaSlsDataSourceWriter(prisma, cipher, keyVersion),
    undefined,
    new PrismaSlsVerificationStore(prisma, cipher),
  );
  const approvals = new ApprovalRoutes(new PrismaApprovalStore(prisma), gitlab);
  return { prisma, userId: user.id, sls, detection: new PrismaSlsDetectionStore(prisma, keys), gitlab, workspaces, approvals, close: () => prisma.$disconnect() };
}

export async function getWebRuntime(): Promise<WebRuntime> {
  if (!runtime) runtime = await createRuntime();
  return runtime;
}

export async function closeWebRuntime(): Promise<void> {
  if (runtime) {
    await runtime.close();
    runtime = undefined;
  }
}
