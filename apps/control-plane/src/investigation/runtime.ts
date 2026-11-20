import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaInvestigationStore } from "./prisma.js";

export function createInvestigationRuntime(): { store: PrismaInvestigationStore; close: () => Promise<void> } {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return { store: new PrismaInvestigationStore(prisma), close: () => prisma.$disconnect() };
}
