import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { snapshotRepository } from "../dist/investigation/repositories.js";
const git = promisify(execFile);
test("investigation fetches selected branch latest SHA, retains immutable reads, and isolates branches without touching checkout", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "qolmes-snapshot-")); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = resolve(root, "source");
  await git("git", ["init", "--initial-branch=main", repo]);
  const commit = async (text: string) => { await writeFile(resolve(repo, "handler.ts"), text); await git("git", ["add", "."], { cwd: repo }); await git("git", ["-c", "user.name=Test", "-c", "user.email=t@invalid", "-c", "commit.gpgsign=false", "commit", "-m", "update"], { cwd: repo }); return (await git("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(); };
  const old = await commit("export const causalMarker = 1;\n");
  await git("git", ["branch", "staging"], { cwd: repo });
  const auth = `Basic ${Buffer.from("oauth2:fixture-secret").toString("base64")}`;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== auth) { res.writeHead(401); res.end(); return; }
    if (req.method === "GET") {
      res.setHeader("content-type", "application/x-git-upload-pack-advertisement"); const service = "# service=git-upload-pack\n";
      res.write((Buffer.byteLength(service)+4).toString(16).padStart(4,"0")+service+"0000");
      res.end((await git("git", ["upload-pack", "--stateless-rpc", "--advertise-refs", repo], { encoding: "buffer" })).stdout);
    } else { res.setHeader("content-type", "application/x-git-upload-pack-result"); const child=spawn("git",["upload-pack","--stateless-rpc",repo]); req.pipe(child.stdin); child.stdout.pipe(res); }
  });
  await new Promise<void>((done)=>server.listen(0,"127.0.0.1",done)); t.after(()=>new Promise<void>((done)=>server.close(()=>done())));
  const address=server.address(); assert.ok(address&&typeof address!=="string");
  const instanceUrl=`http://127.0.0.1:${address.port}`;
  const input={ projectId:"p", projectPath:"g/api", branch:"main", remoteUrl:instanceUrl+"/g/api.git", instanceUrl, token:"fixture-secret" };
  const first=await snapshotRepository(root,input); t.after(()=>first.close()); assert.equal(first.version.commitSha,old);
  const latest=await commit("export const unrelated = 2;\n");
  await writeFile(resolve(repo,"local.txt"),"keep edits");
  const next=await snapshotRepository(root,input); t.after(()=>next.close()); assert.equal(next.version.commitSha,latest);
  assert.deepEqual(await first.search(["causalMarker"]),["handler.ts:1"]); assert.deepEqual(await next.search(["causalMarker"]),[]);
  const other=await snapshotRepository(root,{...input,branch:"staging"}); t.after(()=>other.close()); assert.equal(other.version.commitSha,old);
  assert.equal(await readFile(resolve(repo,"local.txt"),"utf8"),"keep edits");
  await assert.rejects(snapshotRepository(root,{...input,branch:"missing"}),/REPOSITORY_FETCH_FAILED/);
  await assert.rejects(snapshotRepository(root,{...input,branch:"--upload-pack=bad"}),/INVALID_INVESTIGATION_BRANCH/);
  await assert.rejects(snapshotRepository(root,{...input,remoteUrl:"http://other.invalid/g/api.git"}),/INVALID_REPOSITORY_ORIGIN/);
  const linked=resolve(root,"linked"); await symlink(root,linked);
  await assert.rejects(snapshotRepository(linked,input),/symlinks/);
});
