import {
  ApprovalRoutes,
  DataSourceRoutes,
  FetchGitLabOAuthClient,
  GitLabService,
  PrismaApprovalStore,
  PrismaClient,
  PrismaGitLabConnectionStore,
  PrismaOAuthStateStore,
  PrismaPg,
  PrismaSlsDataSourceWriter,
  PrismaSlsVerificationStore,
  gitBeakerApiFactory,
} from "@qolmesgpt/control-plane";
import { decryptSecret, encryptSecret, type KeyProvider } from "@qolmesgpt/security";
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WebRuntime {
  readonly prisma: InstanceType<typeof PrismaClient>;
  readonly userId: string;
  readonly sls: DataSourceRoutes;
  readonly gitlab: GitLabService;
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
  const keyVersion = process.env.QOLMESGPT_CREDENTIAL_KEY_VERSION ?? "v1";
  let keyBase64 = process.env.QOLMESGPT_CREDENTIAL_KEY_BASE64;
  if (!keyBase64 && process.env.NODE_ENV !== "production") {
    const keyDirectory = join(homedir(), ".qolmesgpt");
    const keyPath = join(keyDirectory, "credential-key-v1");
    await mkdir(keyDirectory, { recursive: true, mode: 0o700 });
    try {
      keyBase64 = (await readFile(keyPath, "utf8")).trim();
    } catch {
      try {
        const file = await open(keyPath, "wx", 0o600);
        try {
          keyBase64 = randomBytes(32).toString("base64");
          await file.writeFile(keyBase64, "utf8");
        } finally {
          await file.close();
        }
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
        keyBase64 = (await readFile(keyPath, "utf8")).trim();
      }
    }
  }
  if (!keyBase64) throw new Error("QOLMESGPT_CREDENTIAL_KEY_BASE64 is required in production");
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("QOLMESGPT_CREDENTIAL_KEY_BASE64 must decode to 32 bytes");
  const keys: KeyProvider = { getKey: (version) => {
    if (version !== keyVersion) throw new Error("Credential key version is unavailable");
    return key;
  } };
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
  const sls = new DataSourceRoutes(
    new PrismaSlsDataSourceWriter(prisma, cipher, keyVersion),
    undefined,
    new PrismaSlsVerificationStore(prisma, cipher),
  );
  const approvals = new ApprovalRoutes(new PrismaApprovalStore(prisma), gitlab);
  return { prisma, userId: user.id, sls, gitlab, approvals, close: () => prisma.$disconnect() };
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
