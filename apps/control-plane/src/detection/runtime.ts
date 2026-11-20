import { PrismaPg } from "@prisma/adapter-pg";
import type { KeyProvider } from "@qolmesgpt/security";
import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaSlsDetectionStore } from "./prisma.js";

export function createSlsDetectionRuntime(): { store: PrismaSlsDetectionStore; close: () => Promise<void> } {
  const connectionString = process.env.DATABASE_URL;
  const keyBase64 = process.env.QOLMESGPT_CREDENTIAL_KEY_BASE64;
  const keyVersion = process.env.QOLMESGPT_CREDENTIAL_KEY_VERSION ?? "v1";
  if (!connectionString || !keyBase64) throw new Error("DATABASE_URL and QOLMESGPT_CREDENTIAL_KEY_BASE64 are required");
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("QOLMESGPT_CREDENTIAL_KEY_BASE64 must decode to 32 bytes");
  const keys: KeyProvider = {
    getKey(version) {
      if (version !== keyVersion) throw new Error("SLS credential key version is unavailable");
      return key;
    },
  };
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return { store: new PrismaSlsDetectionStore(prisma, keys), close: () => prisma.$disconnect() };
}
