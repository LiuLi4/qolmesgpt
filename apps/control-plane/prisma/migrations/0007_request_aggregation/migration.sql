ALTER TABLE "ErrorEvent" ADD COLUMN "correlationKey" TEXT, ADD COLUMN "traceId" TEXT, ADD COLUMN "requestId" TEXT, ADD COLUMN "taskId" UUID;
ALTER TABLE "InvestigationTask" ADD COLUMN "firstSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "requestCount" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "evidenceVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "analyzedVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "mergedIntoTaskId" UUID;
UPDATE "InvestigationTask" t SET "firstSeenAt" = e."sourceTimestamp", "lastSeenAt" = e."sourceTimestamp" FROM "ErrorEvent" e WHERE e.id = t."errorEventId";
UPDATE "ErrorEvent" e SET "taskId" = t.id FROM "InvestigationTask" t WHERE t."errorEventId" = e.id;
ALTER TABLE "ErrorEvent" ADD CONSTRAINT "ErrorEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "InvestigationTask"(id) ON DELETE SET NULL;
CREATE INDEX "ErrorEvent_taskId_sourceTimestamp_idx" ON "ErrorEvent"("taskId", "sourceTimestamp");
CREATE INDEX "ErrorEvent_correlationKey_idx" ON "ErrorEvent"("correlationKey");
CREATE INDEX "InvestigationTask_workspaceId_lastSeenAt_idx" ON "InvestigationTask"("workspaceId", "lastSeenAt");
