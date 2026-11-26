import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { isolatedDatabase } from "./database-fixture.ts";
import { GroupWorkspaceService } from "../dist/workspace/group.js";
import { PrismaApprovalStore } from "../dist/approvals/prisma.js";
import type { GitLabProjectSummary } from "../src/integrations/gitlab/types.js";
import { WorkspaceRepositoryService } from "../dist/workspace/repositories.js";

test("repository designer saves cross-Group branches atomically and fences stale or unauthorized changes", { skip: !process.env.DATABASE_URL }, async () => {
  const db = await isolatedDatabase(process.env.DATABASE_URL!); const p = db.prisma;
  try {
    const user = await p.user.create({ data: { authSubject: randomUUID() } });
    const conn = await p.gitLabConnection.create({ data: { userId: user.id, instanceUrl: "http://git.example", authType: "PAT", accessTokenCiphertext: "test", credentialKeyVersion: "v1" } });
    const g = await p.gitLabGroup.create({ data: { connectionId: conn.id, externalGroupId: "1", fullPath: "one" } });
    const w = await p.groupWorkspace.create({ data: { groupId: g.id, relativePath: "workspace", status: "READY", automationEnabled: false } });
    const project = (id: string) => ({ id, groupId: id, namespacePath: id === "1" ? "one" : "two", pathWithNamespace: `${id === "1" ? "one" : "two"}/api`, name: "api", webUrl: `http://git.example/${id}/api`, remoteUrl: `http://git.example/${id}/api.git`, defaultBranch: "main" });
    const api = { getGroup: async (_u: string, _c: string, id: string) => ({ id, fullPath: id === "1" ? "one" : "two" }),
      listWorkspaceProjects: async (_u: string, _c: string, id: string) => [project(id)],
      getBranch: async (_u: string, _c: string, _p: string, branch: string) => { if (branch === "missing") throw new Error("secret upstream"); return { name: branch, commitSha: "a".repeat(40) }; } };
    const service = new WorkspaceRepositoryService(p, api as never);
    const pages: number[]=[];
    const catalogService=new WorkspaceRepositoryService(p,{...api,listProjects:async(_u:string,_c:string,_g:string,page:number,recursive:boolean)=>{pages.push(page);assert.equal(recursive,true);return {items:[project(String(page))],nextPage:page===1?2:null,nextCursor:null}}} as never);
    assert.equal((await catalogService.catalog(user.id,w.id,"1",1)).nextPage,2);
    assert.equal((await catalogService.catalog(user.id,w.id,"1",2)).items[0]?.id,"2");
    assert.deepEqual(pages,[1,2]);
    const input = { expectedVersion: 0, nodes: [{ externalGroupId: "1", x: 80, y: 80, repositories: [{ externalProjectId: "1", branch: "main" }] }, { externalGroupId: "2", x: 350, y: 180, repositories: [{ externalProjectId: "2", branch: "dev" }] }] };
    await service.save(user.id, w.id, input);
    const loaded = await service.get(user.id, w.id);
    assert.equal(loaded.version, 1); assert.equal(loaded.nodes.length, 2);
    assert.equal(loaded.nodes[1]?.repositories[0]?.branch, "dev");
    await new GroupWorkspaceService(p, {} as never, "/unused").synchronize(user.id, w.id);
    assert.equal((await service.get(user.id, w.id)).nodes.length, 2);
    const external = await p.project.findFirstOrThrow({ where: { externalProjectId: "2" } });
    const event = await p.errorEvent.create({ data: { dataSourceConnectionId: (await p.dataSourceConnection.create({ data: { workspaceId: w.id, type: "ALIYUN_SLS", configJson: {}, credentialsCiphertext: "x", credentialKeyVersion: "v1" } })).id, fingerprint: "test", sourcePositionKey: "test", sourceTimestamp: new Date(), logEvidenceJson: {} } });
    const task = await p.investigationTask.create({ data: { workspaceId: w.id, projectId: external.id, errorEventId: event.id, status: "AWAITING_APPROVAL" } });
    assert.equal(await new PrismaApprovalStore(p).findTask(task.id), null);
    assert.equal((await p.groupWorkspace.findUniqueOrThrow({ where: { id: w.id } })).automationEnabled, false);
    await assert.rejects(service.get(randomUUID(), w.id), /not found/);
    await assert.rejects(service.save(user.id, w.id, input), /changed/);
    await assert.rejects(service.save(user.id, w.id, { ...input, expectedVersion: 1, nodes: [...input.nodes, input.nodes[1]!] }), /Duplicate/);
    await assert.rejects(service.save(user.id, w.id, { expectedVersion: 1, nodes: [{ ...input.nodes[0]!, repositories: [{ externalProjectId: "2", branch: "dev" }] }] }), /unavailable/);
    await assert.rejects(service.save(user.id, w.id, { expectedVersion: 1, nodes: [{ ...input.nodes[0]!, repositories: [{ externalProjectId: "1", branch: "missing" }] }] }), /branch unavailable/);
    assert.equal((await service.get(user.id, w.id)).version, 1);
    await service.save(user.id, w.id, { expectedVersion: 1, nodes: [{ ...input.nodes[1]!, repositories: [{ externalProjectId: "2", branch: "staging" }] }] });
    assert.equal((await service.get(user.id, w.id)).nodes[0]?.repositories[0]?.branch, "staging");
    assert.equal(await p.workspaceRepository.count({ where: { workspaceId: w.id, active: false } }), 1);
    const many: GitLabProjectSummary[]=Array.from({length:101},(_,i)=>({...project(String(i)),id:String(i),groupId:"1",pathWithNamespace:`one/api-${i}`}));
    const large=new WorkspaceRepositoryService(p,{...api,listWorkspaceProjects:async()=>many} as never);
    await large.save(user.id,w.id,{expectedVersion:2,nodes:[{externalGroupId:"1",x:80,y:80,repositories:many.map(p=>({externalProjectId:p.id,branch:"main"}))}]});
    assert.equal((await large.get(user.id,w.id)).nodes[0]?.repositories.length,101);
  } finally { await db.close(); }
});


test("an expired sync cannot overwrite a manual configuration saved during discovery", { skip: !process.env.DATABASE_URL }, async () => {
  const db = await isolatedDatabase(process.env.DATABASE_URL!); const p = db.prisma;
  try {
    const user = await p.user.create({ data: { authSubject: randomUUID() } });
    const conn = await p.gitLabConnection.create({ data: { userId: user.id, instanceUrl: "http://git.example", authType: "PAT", accessTokenCiphertext: "test", credentialKeyVersion: "v1" } });
    const group = await p.gitLabGroup.create({ data: { connectionId: conn.id, externalGroupId: "1", fullPath: "one" } });
    const workspace = await p.groupWorkspace.create({ data: { groupId: group.id, relativePath: "workspace", status: "READY", automationEnabled: false } });
    const project = (id: string) => ({ id, groupId: id, pathWithNamespace: `${id === "1" ? "one" : "two"}/api`, name: "api", webUrl: `http://git.example/${id}/api`, defaultBranch: "main" });
    const api = {
      getGroup: async (_u: string, _c: string, id: string) => ({ id, fullPath: id === "1" ? "one" : "two" }),
      listWorkspaceProjects: async (_u: string, _c: string, id: string) => [project(id)],
      getBranch: async () => ({ name: "dev", commitSha: "a".repeat(40) }),
    };
    const designer = new WorkspaceRepositoryService(p, api as never);
    const sync = new GroupWorkspaceService(p, { ...api, getAccessToken: async () => "test", listWorkspaceProjects: async () => {
      await p.groupWorkspace.update({ where: { id: workspace.id }, data: { syncExpiresAt: new Date(0) } });
      await designer.save(user.id, workspace.id, { expectedVersion: 0, nodes: [{ externalGroupId: "2", x: 80, y: 80, repositories: [{ externalProjectId: "2", branch: "dev" }] }] });
      return [project("1")];
    } } as never, "/unused", { prepare: async () => { throw new Error("Stale sync must not prepare a checkout"); } });
    await assert.rejects(sync.synchronize(user.id, workspace.id), /lease lost/);
    const saved = await designer.get(user.id, workspace.id);
    assert.equal(saved.version, 1);
    assert.deepEqual(saved.nodes.map((node) => node.externalGroupId), ["2"]);
    assert.equal(saved.nodes[0]?.repositories[0]?.branch, "dev");
    assert.equal(await p.workspaceRepository.count({ where: { workspaceId: workspace.id, active: true, project: { externalProjectId: "1" } } }), 0);
    const state = await p.groupWorkspace.findUniqueOrThrow({ where: { id: workspace.id } });
    assert.equal(state.repositoryConfigManaged, true);
    assert.equal(state.status, "READY");
    assert.equal(state.syncOwner, null);
    assert.equal(state.automationEnabled, false);
  } finally { await db.close(); }
});
