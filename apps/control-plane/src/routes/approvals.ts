import { canApproveGitLabRole } from "../integrations/gitlab/roles.js";
import type { GitLabService } from "../integrations/gitlab/service.js";

export interface ApprovalTask {
  readonly taskId: string;
  readonly projectId: string;
  readonly groupId: string;
  readonly gitLabConnectionId: string;
  readonly status: "AWAITING_APPROVAL" | "REPAIRING" | "FAILED" | "CLOSED";
}

export interface ApprovalRecord {
  readonly id: string;
  readonly taskId: string;
  readonly approverUserId: string;
  readonly role: "DEVELOPER" | "MAINTAINER" | "OWNER";
  readonly decision: "APPROVED" | "REJECTED";
  readonly approvedAt: string;
  readonly roleCheckedAt: string;
}

export interface ApprovalStore {
  findTask(taskId: string): Promise<ApprovalTask | null>;
  findDecision(taskId: string): Promise<ApprovalRecord | null>;
  createApproval(input: Omit<ApprovalRecord, "id" | "approvedAt">): Promise<ApprovalRecord>;
}

export class ApprovalRoutes {
  constructor(private readonly store: ApprovalStore, private readonly gitlab: Pick<GitLabService, "getApprovalRole">) {}

  async approve(userId: string, taskId: string): Promise<ApprovalRecord> {
    const task = await this.store.findTask(taskId);
    if (!task || task.status !== "AWAITING_APPROVAL") throw new Error("Task is not awaiting approval");
    if (await this.store.findDecision(taskId)) throw new Error("Task already has a decision");
    const role = await this.gitlab.getApprovalRole(userId, task.gitLabConnectionId, task.groupId);
    if (!role.eligible || !canApproveGitLabRole(role.role)) throw new Error("GitLab Group role cannot approve repairs");
    const eligibleRole = role.role as "DEVELOPER" | "MAINTAINER" | "OWNER";
    return this.store.createApproval({ taskId, approverUserId: userId, role: eligibleRole, decision: "APPROVED", roleCheckedAt: role.checkedAt });
  }

  async reject(userId: string, taskId: string): Promise<ApprovalRecord> {
    const task = await this.store.findTask(taskId);
    if (!task || task.status !== "AWAITING_APPROVAL") throw new Error("Task is not awaiting approval");
    if (await this.store.findDecision(taskId)) throw new Error("Task already has a decision");
    const role = await this.gitlab.getApprovalRole(userId, task.gitLabConnectionId, task.groupId);
    if (!role.eligible || !canApproveGitLabRole(role.role)) throw new Error("GitLab Group role cannot reject repairs");
    const eligibleRole = role.role as "DEVELOPER" | "MAINTAINER" | "OWNER";
    return this.store.createApproval({ taskId, approverUserId: userId, role: eligibleRole, decision: "REJECTED", roleCheckedAt: role.checkedAt });
  }
}
