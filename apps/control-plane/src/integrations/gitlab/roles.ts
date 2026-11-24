import type { GitLabRole } from "./types.js";

export function mapGitLabRole(accessLevel: number | string | null | undefined): GitLabRole {
  const level = typeof accessLevel === "string" ? Number(accessLevel) : accessLevel;
  switch (level) {
    case 50:
      return "OWNER";
    case 40:
      return "MAINTAINER";
    case 30:
      return "DEVELOPER";
    case 20:
      return "REPORTER";
    case 10:
      return "GUEST";
    default:
      return "UNKNOWN";
  }
}

export function canApproveGitLabRole(role: GitLabRole): boolean {
  return role === "DEVELOPER" || role === "MAINTAINER" || role === "OWNER";
}
