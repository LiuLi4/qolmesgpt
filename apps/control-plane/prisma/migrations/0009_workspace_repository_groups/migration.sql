ALTER TABLE "GroupWorkspace" ADD COLUMN "repositoryConfigVersion" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "repositoryConfigManaged" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "WorkspaceRepositoryGroup" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(), "workspaceId" UUID NOT NULL,
 "externalGroupId" TEXT NOT NULL, "fullPath" TEXT NOT NULL,
 "positionX" INTEGER NOT NULL DEFAULT 80, "positionY" INTEGER NOT NULL DEFAULT 80,
 CONSTRAINT "WorkspaceRepositoryGroup_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "WorkspaceRepositoryGroup_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "GroupWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WorkspaceRepositoryGroup_workspaceId_externalGroupId_key" ON "WorkspaceRepositoryGroup"("workspaceId", "externalGroupId");
ALTER TABLE "WorkspaceRepository" ADD COLUMN "investigationBranch" TEXT NOT NULL DEFAULT 'main', ADD COLUMN "repositoryGroupId" UUID;
ALTER TABLE "WorkspaceRepository" ADD CONSTRAINT "WorkspaceRepository_repositoryGroupId_fkey" FOREIGN KEY ("repositoryGroupId") REFERENCES "WorkspaceRepositoryGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
INSERT INTO "WorkspaceRepositoryGroup" ("workspaceId","externalGroupId","fullPath")
 SELECT w.id,g."externalGroupId",g."fullPath" FROM "GroupWorkspace" w JOIN "GitLabGroup" g ON g.id=w."groupId";
UPDATE "WorkspaceRepository" r SET "investigationBranch"=COALESCE(NULLIF(p."defaultBranch",''),'main'), "repositoryGroupId"=n.id
 FROM "Project" p, "WorkspaceRepositoryGroup" n
 WHERE p.id=r."projectId" AND n."workspaceId"=r."workspaceId";
