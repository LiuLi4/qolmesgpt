-- Group workspace is the log/investigation scope; checkout remains per repository.
CREATE TABLE "GroupWorkspace" (
  "id" UUID NOT NULL,
  "groupId" UUID NOT NULL,
  "relativePath" TEXT NOT NULL,
  "status" "WorkspaceStatus" NOT NULL DEFAULT 'INITIALIZING',
  "lastSyncedAt" TIMESTAMPTZ(6),
  "errorMessage" TEXT,
  "syncOwner" TEXT,
  "syncExpiresAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "GroupWorkspace_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GroupWorkspace_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "GitLabGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GroupWorkspace_groupId_key" ON "GroupWorkspace"("groupId");
CREATE UNIQUE INDEX "GroupWorkspace_relativePath_key" ON "GroupWorkspace"("relativePath");
CREATE TABLE "WorkspaceRepository" (
  "workspaceId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "WorkspaceRepository_pkey" PRIMARY KEY ("workspaceId", "projectId"),
  CONSTRAINT "WorkspaceRepository_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "GroupWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkspaceRepository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
ALTER TABLE "ProjectWorkspace" ADD COLUMN "errorMessage" TEXT;
ALTER TABLE "DataSourceConnection" ALTER COLUMN "projectId" DROP NOT NULL;
ALTER TABLE "DataSourceConnection" ADD COLUMN "workspaceId" UUID;
ALTER TABLE "DataSourceConnection" ADD CONSTRAINT "DataSourceConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "GroupWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DataSourceConnection" ADD CONSTRAINT "DataSourceConnection_scope_check" CHECK (num_nonnulls("projectId", "workspaceId") = 1);
CREATE UNIQUE INDEX "DataSourceConnection_workspaceId_type_key" ON "DataSourceConnection"("workspaceId", "type");
ALTER TABLE "InvestigationTask" ALTER COLUMN "projectId" DROP NOT NULL;
ALTER TABLE "InvestigationTask" ADD COLUMN "workspaceId" UUID;
ALTER TABLE "InvestigationTask" ADD CONSTRAINT "InvestigationTask_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "GroupWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InvestigationTask" ADD CONSTRAINT "InvestigationTask_scope_check" CHECK (num_nonnulls("projectId", "workspaceId") >= 1);
CREATE INDEX "InvestigationTask_workspaceId_status_createdAt_idx" ON "InvestigationTask"("workspaceId", "status", "createdAt");
CREATE TABLE "TaskRepository" (
  "taskId" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  CONSTRAINT "TaskRepository_pkey" PRIMARY KEY ("taskId", "projectId"),
  CONSTRAINT "TaskRepository_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "InvestigationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TaskRepository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
