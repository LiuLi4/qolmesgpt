import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadCredentialKey } from "../dist/index.js";

test("web and worker reuse one development credential key across concurrent starts", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "qolmesgpt-key-"));
  try {
    const [web, worker] = await Promise.all([
      loadCredentialKey({}, homeDirectory), loadCredentialKey({}, homeDirectory),
    ]);
    assert.deepEqual(web.keys.getKey("v1"), worker.keys.getKey("v1"));
    const path = join(homeDirectory, ".qolmesgpt", "credential-key-v1");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await readFile(path, "utf8")).trim(), web.keys.getKey("v1").toString("base64"));
    assert.throws(() => worker.keys.getKey("other-version"), /unavailable/);
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("explicit credential keys take precedence and production never creates a local key", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "qolmesgpt-key-"));
  try {
    const key = randomBytes(32);
    const loaded = await loadCredentialKey({ NODE_ENV: "production", QOLMESGPT_CREDENTIAL_KEY_BASE64: key.toString("base64"), QOLMESGPT_CREDENTIAL_KEY_VERSION: "v2" }, homeDirectory);
    assert.deepEqual(loaded.keys.getKey("v2"), key);
    await assert.rejects(loadCredentialKey({ NODE_ENV: "production" }, homeDirectory), /required in production/);
    await assert.rejects(loadCredentialKey({ QOLMESGPT_CREDENTIAL_KEY_BASE64: "invalid" }, homeDirectory), /32 bytes/);
    await assert.rejects(stat(join(homeDirectory, ".qolmesgpt")), { code: "ENOENT" });
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});
