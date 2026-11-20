import { Gitlab } from "@gitbeaker/rest";
import type { GitLabApi, GitLabGroupSummary, GitLabPage, GitLabProjectSummary, GitLabUser, GitLabMembership } from "./types.js";
import { mapGitLabRole } from "./roles.js";

interface ExpandedResponse<T> {
  data: T;
  headers: Record<string, string>;
}

function pageFrom<T>(response: T[] | ExpandedResponse<T[]>): GitLabPage<T> {
  const body = Array.isArray(response) ? response : response.data;
  const headers = Array.isArray(response) ? {} : response.headers;
  const nextPageValue = headers["x-next-page"];
  const nextPage = nextPageValue ? Number(nextPageValue) || null : null;
  return { items: body, nextPage, nextCursor: headers["x-next-cursor"] ?? null };
}

export class GitBeakerApi implements GitLabApi {
  constructor(private readonly client: Gitlab<false>) {}

  async currentUser(): Promise<GitLabUser> {
    const user = await this.client.Users.showCurrentUser();
    return { id: user.id, username: user.username, name: user.name };
  }

  async listGroups(page = 1): Promise<GitLabPage<GitLabGroupSummary>> {
    const response = await this.client.Groups.all({ pagination: "offset", page, perPage: 100, showExpanded: true });
    const result = pageFrom(response as unknown as GitLabGroupSummary[] | ExpandedResponse<GitLabGroupSummary[]>);
    return {
      ...result,
      items: result.items.map((group) => ({
        id: String(group.id),
        fullPath: group.fullPath ?? (group as unknown as { full_path?: string }).full_path ?? group.name,
        name: group.name,
        role: mapGitLabRole(
          (group as unknown as { accessLevel?: number; access_level?: number; group_access_level?: number }).accessLevel ??
            (group as unknown as { access_level?: number }).access_level ??
            (group as unknown as { group_access_level?: number }).group_access_level,
        ),
        roleCheckedAt: null,
      })),
    };
  }

  async listGroupProjects(groupId: string, page = 1): Promise<GitLabPage<GitLabProjectSummary>> {
    const response = await this.client.Groups.allProjects(groupId, { pagination: "offset", page, perPage: 100, showExpanded: true });
    const result = pageFrom(response as unknown as GitLabProjectSummary[] | ExpandedResponse<GitLabProjectSummary[]>);
    return {
      ...result,
      items: result.items.map((project) => {
        const raw = project as unknown as Record<string, unknown>;
        return {
          id: String(raw.id),
          groupId,
          name: String(raw.name),
          pathWithNamespace: String(raw.path_with_namespace ?? raw.pathWithNamespace),
          defaultBranch: String(raw.default_branch ?? raw.defaultBranch ?? "main"),
          webUrl: String(raw.web_url ?? raw.webUrl),
        };
      }),
    };
  }

  async getGroupMembership(groupId: string, userId: number): Promise<GitLabMembership> {
    const member = await this.client.GroupMembers.show(groupId, userId, { includeInherited: true });
    return { userId: member.id, accessLevel: member.access_level };
  }
}

export const gitBeakerApiFactory = {
  create(instanceUrl: string, accessToken: string): GitLabApi {
    return new GitBeakerApi(new Gitlab({ host: instanceUrl, token: accessToken }));
  },
};
