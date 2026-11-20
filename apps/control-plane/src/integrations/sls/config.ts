import type { SlsConfig } from "./types.js";

export interface SlsConfigInput {
  readonly endpoint: string;
  readonly project: string;
  readonly logstore: string;
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly securityToken?: string;
}

export interface SafeSlsConfig {
  readonly endpoint: string;
  readonly project: string;
  readonly logstore: string;
  readonly credentialsConfigured: true;
}

export function normalizeSlsConfig(input: SlsConfigInput): SlsConfig {
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint);
  } catch {
    throw new Error("SLS endpoint must be an absolute HTTPS URL");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("SLS endpoint must be an absolute HTTPS URL without credentials or query parameters");
  if (!input.project.trim() || !input.logstore.trim()) throw new Error("SLS project and logstore are required");
  if (!input.accessKeyId.trim() || !input.accessKeySecret.trim()) throw new Error("SLS access key ID and secret are required");
  return {
    endpoint: endpoint.toString().replace(/\/$/, ""),
    project: input.project.trim(),
    logstore: input.logstore.trim(),
    accessKeyId: input.accessKeyId,
    accessKeySecret: input.accessKeySecret,
    ...(input.securityToken?.trim() ? { securityToken: input.securityToken } : {}),
  };
}

export function safeSlsConfig(config: SlsConfig): SafeSlsConfig {
  return { endpoint: config.endpoint, project: config.project, logstore: config.logstore, credentialsConfigured: true };
}
