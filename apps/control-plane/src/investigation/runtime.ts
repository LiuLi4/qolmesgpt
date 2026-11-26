import type { GitLabApi } from "../integrations/gitlab/types.js";
import { snapshotRepository } from "./repositories.js";
import { gitBeakerApiFactory } from "../integrations/gitlab/gitbeaker.js";
import { parseEncryptedSecret } from "../integrations/gitlab/types.js";
import { fileURLToPath } from "node:url";
import { decryptSecret, loadCredentialKey } from "@qolmesgpt/security";
import { PrismaSlsDetectionStore } from "../detection/prisma.js";
import { prepareInvestigation } from "./context.js";
import type { InvestigationJob } from "./prisma.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaInvestigationStore } from "./prisma.js";

/** Bound SDK rate-limit/backoff waits as well as its underlying request timeout. */
export async function readInvestigationProject(api: GitLabApi, projectId: string, timeoutMs = 10_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      api.getProject!(projectId),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("REPOSITORY_API_TIMEOUT")), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function createInvestigationRuntime() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const { keys } = await loadCredentialKey();
  const sources = new PrismaSlsDetectionStore(prisma, keys);
  const root = process.env.QOLMESGPT_WORKSPACE_ROOT ?? fileURLToPath(new URL("../../../web/.qolmesgpt-workspaces/", import.meta.url));
  const openSnapshot = (job: InvestigationJob) => async (repo: NonNullable<InvestigationJob["repositories"]>[number]) => {
    const deadline = Date.now() + 20_000;
    if (!job.workspaceId || !repo.branch) throw new Error("REPOSITORY_CONFIGURATION_MISSING");
    const link = await prisma.workspaceRepository.findFirst({ where: { workspaceId: job.workspaceId, projectId: repo.id, active: true }, include: { project: { include: { connection: true } }, workspace: { include: { group: true } } } });
    if (!link || link.project.connectionId !== link.workspace.group.connectionId || link.project.connection.status !== "ACTIVE" || (link.project.connection.expiresAt && link.project.connection.expiresAt <= new Date())) throw new Error("REPOSITORY_ACCESS_UNAVAILABLE");
    const token = decryptSecret(parseEncryptedSecret(link.project.connection.accessTokenCiphertext), keys);
    const api = gitBeakerApiFactory.create(link.project.connection.instanceUrl, token, { queryTimeout: 10_000 });
    const project = await readInvestigationProject(api, link.project.externalProjectId);
    if (project.pathWithNamespace !== repo.projectPath) throw new Error("REPOSITORY_IDENTITY_CHANGED");
    return snapshotRepository(root, { projectId: repo.id, projectPath: repo.projectPath, branch: repo.branch, remoteUrl: project.remoteUrl ?? `${project.webUrl}.git`, instanceUrl: link.project.connection.instanceUrl, token, deadline });
  };
  return { prepare: (job: InvestigationJob) => prepareInvestigation(job, sources, root, undefined, job.workspaceId ? openSnapshot(job) : undefined), store: new PrismaInvestigationStore(prisma), close: () => prisma.$disconnect() };
}
