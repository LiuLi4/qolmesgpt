import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../dist/generated/prisma/client.js";

export async function isolatedDatabase(connectionString: string, beforeMigration?: string) {
  const schema = `qolmesgpt_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }, { schema }) });
  async function close() {
    await prisma.$disconnect();
    try { await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.$disconnect(); }
  }
  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const directory = new URL("../prisma/migrations/", import.meta.url);
    for (const migration of (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      if (migration.name === beforeMigration) break;
      const sql = await readFile(new URL(`${migration.name}/migration.sql`, directory), "utf8");
      for (const statement of sql.replace(/^--.*$/gm, "").split(";").map((part) => part.trim()).filter(Boolean)) {
        if (statement === 'CREATE SCHEMA IF NOT EXISTS "public"') continue;
        await prisma.$executeRawUnsafe(statement);
      }
    }
    return { prisma, close, connectionString: url.toString() };
  } catch (error) {
    await close();
    throw error;
  }
}
