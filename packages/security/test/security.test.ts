import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { decryptSecret, encryptSecret } from "../src/encryption.ts";
import { redact } from "../src/redaction.ts";

const key = randomBytes(32);
const keyProvider = { getKey: () => key };

test("encrypts and decrypts with a key version", () => {
  const encrypted = encryptSecret("sls-access-key", "dev-v1", keyProvider);
  assert.equal(decryptSecret(encrypted, keyProvider), "sls-access-key");
  assert.notEqual(encrypted.ciphertext, "sls-access-key");
});

test("fails closed when the key version is unavailable", () => {
  const encrypted = encryptSecret("secret", "dev-v1", keyProvider);
  assert.throws(
    () => decryptSecret(encrypted, { getKey: () => randomBytes(32) }),
  );
});

test("redacts credentials recursively", () => {
  assert.deepEqual(
    redact({ token: "secret", nested: { authorization: "Bearer secret", level: 30 } }),
    { token: "[REDACTED]", nested: { authorization: "[REDACTED]", level: 30 } },
  );
});
