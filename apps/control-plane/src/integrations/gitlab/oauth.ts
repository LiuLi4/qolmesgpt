import { normalizeGitLabUrl } from "./crypto.js";
import type { GitLabOAuthClient } from "./types.js";

export class FetchGitLabOAuthClient implements GitLabOAuthClient {
  authorizationUrl(input: Parameters<GitLabOAuthClient["authorizationUrl"]>[0]): string {
    const url = new URL(`${normalizeGitLabUrl(input.instanceUrl)}/oauth/authorize`);
    url.searchParams.set("client_id", input.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", input.scopes.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async exchangeCode(input: Parameters<GitLabOAuthClient["exchangeCode"]>[0]): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
    const response = await fetch(`${normalizeGitLabUrl(input.instanceUrl)}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: input.clientId,
        ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
        code: input.code,
        grant_type: "authorization_code",
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      }),
    });
    if (!response.ok) throw new Error(`GitLab OAuth token exchange failed (${response.status})`);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || typeof (payload as { access_token?: unknown }).access_token !== "string") {
      throw new Error("GitLab OAuth token response did not contain an access token");
    }
    const token = payload as { access_token: string; refresh_token?: string; expires_in?: number };
    return { accessToken: token.access_token, refreshToken: token.refresh_token, expiresIn: token.expires_in };
  }
}
