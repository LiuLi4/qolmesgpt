export function controlPlaneStatus(): { adapter: string } {
  return { adapter: "aliyun-sls" };
}

export { PrismaSlsDetectionStore } from "./detection/prisma.js";
export type { EnabledSlsSource, DetectionLog } from "./detection/prisma.js";
export { classifySlsError } from "./integrations/sls/classifier.js";
export { aggregationIdentity, normalizeErrorMessage, logFields, FINGERPRINT_WINDOW_MS, REQUEST_WINDOW_MS } from "./detection/aggregation.js";
export { createSlsDetectionRuntime } from "./detection/runtime.js";
export { PrismaInvestigationStore } from "./investigation/prisma.js";
export type { InvestigationJob, InvestigationResult } from "./investigation/prisma.js";
export { createInvestigationRuntime } from "./investigation/runtime.js";
export { ApprovalRoutes } from "./routes/approvals.js";
export type { ApprovalRecord, ApprovalStore, ApprovalTask } from "./routes/approvals.js";
export { PrismaApprovalStore } from "./approvals/prisma.js";
export { PrismaRepairStore } from "./approvals/repair-prisma.js";
export type { RepairAuthorization, RepairStore } from "./approvals/repair-types.js";
export { PrismaWorkspaceLeaseManager } from "./approvals/workspace-lease.js";
export { createRepairRuntime } from "./approvals/runtime.js";
export { PrismaClient } from "./generated/prisma/client.js";
export { PrismaPg } from "@prisma/adapter-pg";
export { PrismaSlsDataSourceWriter, PrismaSlsVerificationStore } from "./integrations/sls/prisma.js";
export { PrismaGitLabConnectionStore, PrismaOAuthStateStore } from "./integrations/gitlab/prisma.js";
export { GitLabService } from "./integrations/gitlab/service.js";
export { FetchGitLabOAuthClient } from "./integrations/gitlab/oauth.js";
export { gitBeakerApiFactory } from "./integrations/gitlab/gitbeaker.js";
export { DataSourceRoutes } from "./routes/data-sources.js";

export { GitRepositoryCheckout, GroupWorkspaceService } from "./workspace/group.js";
