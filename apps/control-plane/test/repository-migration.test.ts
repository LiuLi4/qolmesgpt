import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isolatedDatabase } from "./database-fixture.ts";

test("repository migration backfills owning Group nodes and default branches without changing automation or evidence", { skip: !process.env.DATABASE_URL }, async () => {
 const db=await isolatedDatabase(process.env.DATABASE_URL!,"0009_workspace_repository_groups");const p=db.prisma;
 try {
  const user=await p.user.create({data:{authSubject:randomUUID()}});
  const c=await p.gitLabConnection.create({data:{userId:user.id,instanceUrl:"http://git.example",authType:"PAT",accessTokenCiphertext:"test",credentialKeyVersion:"v1"}});
  const g=await p.gitLabGroup.create({data:{connectionId:c.id,externalGroupId:"root",fullPath:"acme"}});
  const wId=randomUUID(),projectId=randomUUID();
  await p.$executeRaw`INSERT INTO "GroupWorkspace" (id,"groupId","relativePath",status,"automationEnabled","updatedAt") VALUES (${wId}::uuid,${g.id}::uuid,'root','READY',false,now())`;
  await p.project.create({data:{id:projectId,connectionId:c.id,groupId:g.id,externalProjectId:"api",pathWithNamespace:"acme/api",defaultBranch:"dev",createdByUserId:user.id}});
  await p.projectWorkspace.create({data:{projectId,relativePath:"checkout",branch:"old-branch"}});
  await p.$executeRaw`INSERT INTO "WorkspaceRepository" ("workspaceId","projectId",active) VALUES (${wId}::uuid,${projectId}::uuid,true)`;
  const sql=await readFile(new URL("../prisma/migrations/0009_workspace_repository_groups/migration.sql",import.meta.url),"utf8");
  for(const statement of sql.split(";").map(s=>s.trim()).filter(Boolean))await p.$executeRawUnsafe(statement);
  const link=await p.workspaceRepository.findUniqueOrThrow({where:{workspaceId_projectId:{workspaceId:wId,projectId}},include:{repositoryGroup:true}});
  assert.equal(link.investigationBranch,"dev");assert.equal(link.repositoryGroup?.externalGroupId,"root");assert.equal(link.repositoryGroup?.workspaceId,wId);
  assert.equal((await p.groupWorkspace.findUniqueOrThrow({where:{id:wId}})).automationEnabled,false);
  assert.equal(await p.errorEvent.count(),0);
 }finally{await db.close()}
});
