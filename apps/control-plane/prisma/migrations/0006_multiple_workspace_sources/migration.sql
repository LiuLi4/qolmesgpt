DROP INDEX "DataSourceConnection_workspaceId_type_key";
CREATE INDEX "DataSourceConnection_workspaceId_status_idx" ON "DataSourceConnection"("workspaceId", "status");
