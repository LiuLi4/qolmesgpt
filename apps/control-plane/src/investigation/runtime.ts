import { fileURLToPath } from "node:url";
import { loadCredentialKey } from "@qolmesgpt/security";
import { PrismaSlsDetectionStore } from "../detection/prisma.js";
import { prepareInvestigation } from "./context.js";
import type { InvestigationJob } from "./prisma.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaInvestigationStore } from "./prisma.js";

export async function createInvestigationRuntime() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const { keys } = await loadCredentialKey();
  const sources = new PrismaSlsDetectionStore(prisma, keys);
  const root = process.env.QOLMESGPT_WORKSPACE_ROOT ?? fileURLToPath(new URL("../../../web/.qolmesgpt-workspaces/", import.meta.url));
  return { prepare: (job: InvestigationJob) => prepareInvestigation(job, sources, root), store: new PrismaInvestigationStore(prisma), close: () => prisma.$disconnect() };
}
