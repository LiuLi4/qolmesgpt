import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KeyProvider } from "./encryption.js";

export async function loadCredentialKey(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): Promise<{ keyVersion: string; keys: KeyProvider }> {
  const keyVersion = env.QOLMESGPT_CREDENTIAL_KEY_VERSION ?? "v1";
  let keyBase64 = env.QOLMESGPT_CREDENTIAL_KEY_BASE64;
  if (!keyBase64 && env.NODE_ENV !== "production") {
    if (!/^[A-Za-z0-9_-]+$/.test(keyVersion)) throw new Error("Invalid credential key version");
    const directory = join(homeDirectory, ".qolmesgpt");
    const path = join(directory, `credential-key-${keyVersion}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      keyBase64 = (await readFile(path, "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = `${path}.${randomBytes(12).toString("hex")}`;
      await writeFile(temporary, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
      try {
        // Publish only the complete key, and never replace a key created by another process.
        try { await link(temporary, path); } catch (linkError) {
          if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") throw linkError;
        }
        keyBase64 = (await readFile(path, "utf8")).trim();
      } finally {
        await unlink(temporary);
      }
    }
  }
  if (!keyBase64) throw new Error("QOLMESGPT_CREDENTIAL_KEY_BASE64 is required in production");
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) throw new Error("QOLMESGPT_CREDENTIAL_KEY_BASE64 must decode to 32 bytes");
  return { keyVersion, keys: { getKey(version) {
    if (version !== keyVersion) throw new Error("Credential key version is unavailable");
    return key;
  } } };
}
