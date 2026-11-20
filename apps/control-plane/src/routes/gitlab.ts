import type { GitLabService } from "../integrations/gitlab/service.js";

export interface GitLabRouteContext {
  readonly userId: string;
}

export class GitLabRoutes {
  constructor(private readonly service: GitLabService) {}

  oauthStart(context: GitLabRouteContext, body: { instanceUrl: string }) {
    return this.service.startOAuth(context.userId, body);
  }

  oauthCallback(context: GitLabRouteContext, query: { state?: string; code?: string; error?: string; errorDescription?: string }) {
    return this.service.completeOAuth(context.userId, query);
  }

  connectPAT(context: GitLabRouteContext, body: { instanceUrl: string; personalAccessToken: string }) {
    return this.service.connectPAT(context.userId, body);
  }

  listGroups(context: GitLabRouteContext, connectionId: string, page = 1) {
    return this.service.listGroups(context.userId, connectionId, page);
  }

  listProjects(context: GitLabRouteContext, connectionId: string, groupId: string, page = 1) {
    return this.service.listProjects(context.userId, connectionId, groupId, page);
  }

  getApprovalRole(context: GitLabRouteContext, connectionId: string, groupId: string) {
    return this.service.getApprovalRole(context.userId, connectionId, groupId);
  }
}
