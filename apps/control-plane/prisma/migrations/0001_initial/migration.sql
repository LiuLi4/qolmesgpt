-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ConnectionAuthType" AS ENUM ('OAUTH', 'PAT');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'INVALID', 'REVOKED');

-- CreateEnum
CREATE TYPE "WorkspaceStatus" AS ENUM ('INITIALIZING', 'READY', 'OCCUPIED', 'DIRTY', 'FAILED');

-- CreateEnum
CREATE TYPE "DataSourceType" AS ENUM ('ALIYUN_SLS');

-- CreateEnum
CREATE TYPE "DataSourceStatus" AS ENUM ('CONFIGURED', 'VERIFIED', 'ENABLED', 'PAUSED', 'FAILED');

-- CreateEnum
CREATE TYPE "VerificationKind" AS ENUM ('CONNECTION', 'READ');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "ConsumerStatus" AS ENUM ('STARTING', 'RUNNING', 'DEGRADED', 'STOPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "InvestigationTaskStatus" AS ENUM ('INVESTIGATION_PENDING', 'INVESTIGATING', 'AWAITING_APPROVAL', 'REPAIRING', 'VERIFIED', 'FAILED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('HIGH');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "GitLabGroupRole" AS ENUM ('GUEST', 'REPORTER', 'DEVELOPER', 'MAINTAINER', 'OWNER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RepairRunStatus" AS ENUM ('PENDING', 'RUNNING', 'TESTS_PASSED', 'SLS_RECHECK_PASSED', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "MergeRequestStatus" AS ENUM ('PENDING', 'CREATED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "authSubject" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitLabConnection" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "instanceUrl" TEXT NOT NULL,
    "authType" "ConnectionAuthType" NOT NULL,
    "accessTokenCiphertext" TEXT NOT NULL,
    "refreshTokenCiphertext" TEXT,
    "credentialKeyVersion" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6),
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "GitLabConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitLabGroup" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "externalGroupId" TEXT NOT NULL,
    "fullPath" TEXT NOT NULL,
    "roleSnapshot" "GitLabGroupRole" NOT NULL DEFAULT 'UNKNOWN',
    "roleSyncedAt" TIMESTAMPTZ(6),

    CONSTRAINT "GitLabGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "groupId" UUID NOT NULL,
    "externalProjectId" TEXT NOT NULL,
    "pathWithNamespace" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectWorkspace" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "relativePath" TEXT NOT NULL,
    "headSha" TEXT,
    "branch" TEXT,
    "status" "WorkspaceStatus" NOT NULL DEFAULT 'INITIALIZING',
    "lockOwner" TEXT,
    "lockExpiresAt" TIMESTAMPTZ(6),
    "fencingToken" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ProjectWorkspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSourceConnection" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "type" "DataSourceType" NOT NULL,
    "configJson" JSONB NOT NULL,
    "credentialsCiphertext" TEXT NOT NULL,
    "credentialKeyVersion" TEXT NOT NULL,
    "status" "DataSourceStatus" NOT NULL DEFAULT 'CONFIGURED',
    "enabledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DataSourceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSourceVerification" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "kind" "VerificationKind" NOT NULL,
    "status" "VerificationStatus" NOT NULL,
    "testedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "safeSummary" JSONB,
    "errorCode" TEXT,

    CONSTRAINT "DataSourceVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SLSConsumerState" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "consumerGroup" TEXT NOT NULL,
    "workerId" TEXT,
    "shardAssignments" JSONB,
    "checkpointSummary" JSONB,
    "status" "ConsumerStatus" NOT NULL DEFAULT 'STOPPED',
    "lastHeartbeatAt" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SLSConsumerState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErrorEvent" (
    "id" UUID NOT NULL,
    "dataSourceConnectionId" UUID NOT NULL,
    "sourcePositionKey" TEXT NOT NULL,
    "sourceTimestamp" TIMESTAMPTZ(6) NOT NULL,
    "logEvidenceJson" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrorEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvestigationTask" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "errorEventId" UUID NOT NULL,
    "status" "InvestigationTaskStatus" NOT NULL DEFAULT 'INVESTIGATION_PENDING',
    "priority" "TaskPriority" NOT NULL DEFAULT 'HIGH',
    "investigationResultJson" JSONB,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "InvestigationTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "approverUserId" UUID NOT NULL,
    "groupRoleAtApproval" "GitLabGroupRole" NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "approvedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "roleCheckedAt" TIMESTAMPTZ(6) NOT NULL,
    "authorizationVersion" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairRun" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "branch" TEXT NOT NULL,
    "status" "RepairRunStatus" NOT NULL DEFAULT 'PENDING',
    "testResult" JSONB,
    "slsRecheckResult" JSONB,
    "fencingToken" BIGINT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(6),
    "finishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "RepairRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MergeRequest" (
    "id" UUID NOT NULL,
    "repairRunId" UUID NOT NULL,
    "externalMrId" TEXT,
    "url" TEXT,
    "status" "MergeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MergeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxMessage" (
    "id" UUID NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "availableAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMPTZ(6),
    "claimOwner" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_authSubject_key" ON "User"("authSubject");

-- CreateIndex
CREATE INDEX "GitLabConnection_userId_status_idx" ON "GitLabConnection"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GitLabConnection_userId_instanceUrl_key" ON "GitLabConnection"("userId", "instanceUrl");

-- CreateIndex
CREATE INDEX "GitLabGroup_connectionId_fullPath_idx" ON "GitLabGroup"("connectionId", "fullPath");

-- CreateIndex
CREATE UNIQUE INDEX "GitLabGroup_connectionId_externalGroupId_key" ON "GitLabGroup"("connectionId", "externalGroupId");

-- CreateIndex
CREATE INDEX "Project_groupId_pathWithNamespace_idx" ON "Project"("groupId", "pathWithNamespace");

-- CreateIndex
CREATE UNIQUE INDEX "Project_connectionId_externalProjectId_key" ON "Project"("connectionId", "externalProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectWorkspace_projectId_key" ON "ProjectWorkspace"("projectId");

-- CreateIndex
CREATE INDEX "DataSourceConnection_projectId_status_idx" ON "DataSourceConnection"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DataSourceConnection_projectId_type_key" ON "DataSourceConnection"("projectId", "type");

-- CreateIndex
CREATE INDEX "DataSourceVerification_connectionId_kind_testedAt_idx" ON "DataSourceVerification"("connectionId", "kind", "testedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SLSConsumerState_connectionId_key" ON "SLSConsumerState"("connectionId");

-- CreateIndex
CREATE INDEX "ErrorEvent_dataSourceConnectionId_sourceTimestamp_idx" ON "ErrorEvent"("dataSourceConnectionId", "sourceTimestamp");

-- CreateIndex
CREATE INDEX "ErrorEvent_fingerprint_idx" ON "ErrorEvent"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "ErrorEvent_dataSourceConnectionId_sourcePositionKey_key" ON "ErrorEvent"("dataSourceConnectionId", "sourcePositionKey");

-- CreateIndex
CREATE UNIQUE INDEX "InvestigationTask_errorEventId_key" ON "InvestigationTask"("errorEventId");

-- CreateIndex
CREATE INDEX "InvestigationTask_projectId_status_createdAt_idx" ON "InvestigationTask"("projectId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Approval_taskId_decision_approvedAt_idx" ON "Approval"("taskId", "decision", "approvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RepairRun_idempotencyKey_key" ON "RepairRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "RepairRun_taskId_status_idx" ON "RepairRun"("taskId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MergeRequest_repairRunId_key" ON "MergeRequest"("repairRunId");

-- CreateIndex
CREATE INDEX "OutboxMessage_availableAt_claimedAt_idx" ON "OutboxMessage"("availableAt", "claimedAt");

-- CreateIndex
CREATE INDEX "OutboxMessage_aggregateType_aggregateId_idx" ON "OutboxMessage"("aggregateType", "aggregateId");

-- AddForeignKey
ALTER TABLE "GitLabConnection" ADD CONSTRAINT "GitLabConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitLabGroup" ADD CONSTRAINT "GitLabGroup_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "GitLabConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "GitLabConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "GitLabGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectWorkspace" ADD CONSTRAINT "ProjectWorkspace_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSourceConnection" ADD CONSTRAINT "DataSourceConnection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSourceVerification" ADD CONSTRAINT "DataSourceVerification_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "DataSourceConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SLSConsumerState" ADD CONSTRAINT "SLSConsumerState_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "DataSourceConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErrorEvent" ADD CONSTRAINT "ErrorEvent_dataSourceConnectionId_fkey" FOREIGN KEY ("dataSourceConnectionId") REFERENCES "DataSourceConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationTask" ADD CONSTRAINT "InvestigationTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvestigationTask" ADD CONSTRAINT "InvestigationTask_errorEventId_fkey" FOREIGN KEY ("errorEventId") REFERENCES "ErrorEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "InvestigationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_approverUserId_fkey" FOREIGN KEY ("approverUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepairRun" ADD CONSTRAINT "RepairRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "InvestigationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepairRun" ADD CONSTRAINT "RepairRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "ProjectWorkspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MergeRequest" ADD CONSTRAINT "MergeRequest_repairRunId_fkey" FOREIGN KEY ("repairRunId") REFERENCES "RepairRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxMessage" ADD CONSTRAINT "OutboxMessage_aggregateId_fkey" FOREIGN KEY ("aggregateId") REFERENCES "InvestigationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
