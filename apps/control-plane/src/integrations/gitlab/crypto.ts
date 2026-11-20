import { createHash, randomBytes } from "node:crypto";

export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function createPkceVerifier(): string {
  return randomBytes(48).toString("base64url");
}

export function createPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state).digest("base64url");
}

export function normalizeGitLabUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GitLab instance URL must be an absolute HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("GitLab instance URL must be an absolute HTTPS URL without credentials or query parameters");
  }
  return url.toString().replace(/\/$/, "");
}
