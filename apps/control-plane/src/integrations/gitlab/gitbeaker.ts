import { Gitlab, type PaginatedResponse } from "@gitbeaker/rest";
import type { GitLabApi, GitLabGroupSummary, GitLabPage, GitLabProjectSummary, GitLabUser, GitLabMembership } from "./types.js";
import { mapGitLabRole } from "./roles.js";

function pageFrom<T>(response: PaginatedResponse<T[], "offset">): GitLabPage<T> {
  return { items: response.data, nextPage: response.paginationInfo.next, nextCursor: null };
}

export class GitBeakerApi implements GitLabApi {
  constructor(private readonly client: Gitlab<false>) {}

  async currentUser(): Promise<GitLabUser> {
    const user = await this.client.Users.showCurrentUser();
    return { id: user.id, username: user.username, name: user.name };
  }

  async getGroup(groupId: string): Promise<GitLabGroupSummary> {
    const group = await this.client.Groups.show(groupId);
    return { id: String(group.id), fullPath: group.full_path, name: group.name, role: "UNKNOWN", roleCheckedAt: null };
  }

  async listGroups(page = 1): Promise<GitLabPage<GitLabGroupSummary>> {
    const response = await this.client.Groups.all({ pagination: "offset", page, perPage: 100, showExpanded: true });
    const result = pageFrom(response);
    return {
      ...result,
      items: result.items.map((group) => ({
        id: String(group.id),
        fullPath: group.full_path ?? group.name,
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

  async listGroupProjects(groupId: string, page = 1, includeSubgroups = false): Promise<GitLabPage<GitLabProjectSummary>> {
    const response = await this.client.Groups.allProjects(groupId, { pagination: "offset", page, perPage: 100, showExpanded: true, includeSubgroups, withShared: false });
    const result = pageFrom(response);
    return {
      ...result,
      items: result.items.map((project) => {
        const raw = project as unknown as Record<string, unknown>;
        const namespace = raw.namespace as { id?: number; full_path?: string } | undefined;
        return {
          id: String(raw.id),
          groupId: String(namespace?.id ?? groupId),
          namespacePath: namespace?.full_path,
          remoteUrl: typeof raw.http_url_to_repo === "string" ? raw.http_url_to_repo : undefined,
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
