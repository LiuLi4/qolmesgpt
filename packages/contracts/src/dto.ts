export interface SafeCredentialSummary {
  readonly configured: boolean;
  readonly authType: "OAUTH" | "PAT";
  readonly keyVersion: string;
}

export interface WorkspaceSummary {
  readonly id: string;
  readonly status: string;
  readonly headSha: string | null;
  readonly relativePath: string;
}

export function toSafeCredentialSummary(input: {
  authType: "OAUTH" | "PAT";
  keyVersion: string;
  accessTokenCiphertext?: string;
}): SafeCredentialSummary {
  return {
    configured: Boolean(input.accessTokenCiphertext),
    authType: input.authType,
    keyVersion: input.keyVersion,
  };
}
