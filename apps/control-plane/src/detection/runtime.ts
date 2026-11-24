import { PrismaPg } from "@prisma/adapter-pg";
import { loadCredentialKey } from "@qolmesgpt/security";
import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaSlsDetectionStore } from "./prisma.js";

export async function createSlsDetectionRuntime(): Promise<{ store: PrismaSlsDetectionStore; close: () => Promise<void> }> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const { keys } = await loadCredentialKey();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return { store: new PrismaSlsDetectionStore(prisma, keys), close: () => prisma.$disconnect() };
}
