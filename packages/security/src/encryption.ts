import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptedSecret {
  readonly algorithm: "aes-256-gcm";
  readonly keyVersion: string;
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

export interface KeyProvider {
  getKey(keyVersion: string): Buffer;
}

export function encryptSecret(
  plaintext: string,
  keyVersion: string,
  keyProvider: KeyProvider,
): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyProvider.getKey(keyVersion), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    keyVersion,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

export function decryptSecret(
  encrypted: EncryptedSecret,
  keyProvider: KeyProvider,
): string {
  if (encrypted.algorithm !== "aes-256-gcm") {
    throw new Error(`Unsupported encryption algorithm: ${encrypted.algorithm}`);
  }
  const decipher = createDecipheriv(
    encrypted.algorithm,
    keyProvider.getKey(encrypted.keyVersion),
    Buffer.from(encrypted.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
