import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { AliyunSlsAdapter } from "../integrations/sls/adapter.js";
import { packInvestigationEvidence, prioritizeEvidence, requestKey, evidenceFields, completionLog } from "./evidence.js";
import { logFields } from "../detection/aggregation.js";
import { evidence, type PrismaSlsDetectionStore } from "../detection/prisma.js";
import type { RepositorySnapshot, RepositoryVersion } from "./repositories.js";
import type { InvestigationJob } from "./prisma.js";

const exec = promisify(execFile);
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

/** Read-only, bounded evidence collection. Never executes text from logs or model output. */
export async function prepareInvestigation(job: InvestigationJob, sources: PrismaSlsDetectionStore, root: string, adapter = new AliyunSlsAdapter(), openSnapshot?: (repo: NonNullable<InvestigationJob["repositories"]>[number]) => Promise<RepositorySnapshot>): Promise<InvestigationJob & { codeEvidence: string[]; repositoryVersions?: RepositoryVersion[] }> {
  const started = Date.now();
  const relatedLogs: unknown[] = [...job.relatedLogs];
  const diagnostics: string[] = [];
  const requestIds = new Set<string>();
  const requests = prioritizeEvidence(job.relatedLogs).filter((entry) => {
    const key = requestKey(entry);
    if (!key || requestIds.has(key)) return false;
    requestIds.add(key); return true;
  }).slice(0, 6).map(object);
  const enabled = (await sources.listEnabled()).filter((source) => job.workspaceId ? source.workspaceId === job.workspaceId : source.projectId === job.projectId && !source.workspaceId).slice(0, 10);
  requestLoop: for (const event of requests) {
    const fields = evidenceFields(event);
    const id = String(event.traceId || fields.traceId || fields.trace_id || event.requestId || fields.requestId || fields.request_id || "");
    const time = new Date(String(event.timestamp)).getTime();
    if (!/^[A-Za-z0-9_.:/-]{1,200}$/.test(id) || !Number.isFinite(time)) continue;
    for (const source of enabled) {
      if (Date.now() - started > 20_000) { diagnostics.push("Log context collection time budget reached"); break requestLoop; }
      const result = await adapter.search(source, `"${id}"`, { from: new Date(time - 5 * 60_000), to: new Date(time + 5 * 60_000) }, 100);
      diagnostics.push(`${source.id}: ${result.status}${result.errorCode ? ` (${result.errorCode})` : ""}; trace/request=${id}; ±5min; limit=100`);
      for (const record of result.records) {
        const fields = logFields(record);
        if (![fields.traceId, fields.trace_id, fields.requestId, fields.request_id].includes(id)) continue;
        relatedLogs.push({ sourceId: source.id, traceId: fields.traceId ?? fields.trace_id, requestId: fields.requestId ?? fields.request_id, timestamp: Number.isFinite(Number(record.__time__)) ? new Date(Number(record.__time__) * 1000).toISOString() : String(event.timestamp), log: evidence(record, [source.accessKeyId, source.accessKeySecret, source.securityToken ?? ""]) });
      }
    }
  }
  const fields = logFields(object(job.errorEvidence));
  const terms = new Set<string>();
  // Prefer stack file locations and exception/service/component names over generic request completion text.
  const text = JSON.stringify(packInvestigationEvidence(relatedLogs).records);
  for (const entry of prioritizeEvidence(relatedLogs).filter((value) => !completionLog(value)).slice(0, 30)) {
    const f = evidenceFields(entry);
    for (const value of [f.errorCode, object(f.err).code, object(f.error).code, f.route, f.routeTemplate]) if (typeof value === "string" && /^[A-Za-z0-9_./:-]{3,100}$/.test(value)) terms.add(value);
    const message = String(f.msg ?? f.message ?? "");
    if (message.length >= 4 && message.length <= 100 && !/[\r\n]/.test(message)) terms.add(message);
  }
  for (const match of text.matchAll(/[A-Za-z0-9_./-]+\.(?:ts|js|py|go|java)(?=[:"\\])/g)) terms.add(match[0].split("/").at(-1)!);
  for (const match of text.matchAll(/\b(?:[A-Z][A-Za-z]+(?:Error|Exception)|E[A-Z_]{4,30})\b/g)) terms.add(match[0]);
  for (const value of [fields.component, fields.service, object(fields.err).type, object(fields.error).name]) if (typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{3,79}$/.test(value)) terms.add(value);
  const codeEvidence: string[] = [];
  const repositoryVersions: RepositoryVersion[] = [];
  const rootPath = await realpath(root).catch(() => null);
  if (!rootPath) diagnostics.push("Workspace checkout root unavailable; code locations not collected");
  for (const repo of (job.repositories ?? [{ id: job.projectId ?? "", projectPath: job.projectPath, workspacePath: job.workspacePath }]).slice(0, 30)) {
    if (openSnapshot && job.workspaceId) {
      let snapshot: RepositorySnapshot | undefined;
      try {
        if (Date.now() - started > 70_000) throw new Error("REPOSITORY_BUDGET_EXCEEDED");
        snapshot = await openSnapshot(repo);
        const locations = await snapshot.search([...terms]);
        repositoryVersions.push(snapshot.version);
        codeEvidence.push(`Repository ${repo.id} (${repo.projectPath}); selected branch ${snapshot.version.branch}; actual commit ${snapshot.version.commitSha}; matching source locations (source text withheld): ${JSON.stringify(locations)}`);
      } catch (error) {
        // Only fixed internal classifications may reach prompts/UI; provider messages can contain secrets.
        const allowed = ["REPOSITORY_CONFIGURATION_MISSING", "REPOSITORY_ACCESS_UNAVAILABLE", "REPOSITORY_IDENTITY_CHANGED", "REPOSITORY_API_TIMEOUT", "REPOSITORY_SNAPSHOT_TIMEOUT", "REPOSITORY_FETCH_FAILED", "REPOSITORY_SEARCH_FAILED", "REPOSITORY_BUDGET_EXCEEDED", "INVALID_INVESTIGATION_BRANCH", "INVALID_REPOSITORY_ORIGIN", "INVALID_REPOSITORY_COMMIT"];
        const errorCode = error instanceof Error && allowed.includes(error.message) ? error.message : "REPOSITORY_READ_FAILED";
        repositoryVersions.push({ projectId: repo.id, projectPath: repo.projectPath, branch: repo.branch ?? "", commitSha: null, readAt: new Date().toISOString(), status: "FAILED", errorCode });
        diagnostics.push(`${repo.projectPath}: ${errorCode}; selected branch could not be read; no cache/default fallback; evidence incomplete`);
      } finally { await snapshot?.close(); }
      continue;
    }
    if (!repo.workspacePath || !rootPath) continue;
    if (Date.now() - started > 35_000) { diagnostics.push("Code context collection time budget reached"); break; }
    try {
      const path = await realpath(resolve(rootPath, repo.workspacePath));
      if (!path.startsWith(rootPath + sep)) throw new Error("OUTSIDE_WORKSPACE");
      if (!terms.size) { diagnostics.push(`${repo.projectPath}: no specific code search terms; code attribution unavailable`); continue; }
      const args = ["grep", "-n", "-I", "-F", ...[...terms].slice(0, 6).flatMap((term) => ["-e", term]), "--", "*.ts", "*.tsx", "*.js", "*.py", "*.go", "*.java", ":(exclude)*test*", ":(exclude)*lock*", ":(exclude)*config*", ":(exclude)*secret*"];
      let output = "";
      try { output = (await exec("git", args, { cwd: path, timeout: 5_000, maxBuffer: 256_000 })).stdout; }
      catch (error) { const failure = error as { code?: number; stdout?: string }; if (failure.code === 1) output = ""; else if (failure.stdout) output = failure.stdout; else throw error; }
      // Keep private source contents out of model prompts: provide locations only.
      const locations = output.split("\n").map((line) => /^([^:]+):(\d+):/.exec(line)).filter((match) => match !== null).slice(0, 60).map((match) => `${match[1]}:${match[2]}`);
      codeEvidence.push(`Repository ${repo.id} (${repo.projectPath}); matching source locations (source text withheld): ${JSON.stringify([...new Set(locations)])}`);
      if (codeEvidence.join("").length > 35_000) break;
    } catch { diagnostics.push(`${repo.projectPath}: code checkout unavailable or search failed`); }
  }
  if (openSnapshot && job.workspaceId) for (const repo of (job.repositories ?? []).slice(30)) repositoryVersions.push({ projectId: repo.id, projectPath: repo.projectPath, branch: repo.branch ?? "", commitSha: null, readAt: new Date().toISOString(), status: "FAILED", errorCode: "REPOSITORY_BUDGET_EXCEEDED" });
  // Both loops are bounded: at most 6 requests * 10 sources * 100 records plus 200 stored events.
  // Leave the final budget decision to the shared packer so no intermediate slice silently drops evidence.
  relatedLogs.unshift({ contextDiagnostics: diagnostics, sampledRequests: requests.length, note: "Context is bounded; empty results do not prove absence of errors." });
  return { ...job, relatedLogs: relatedLogs as InvestigationJob["relatedLogs"], codeEvidence, ...(openSnapshot && job.workspaceId ? { repositoryVersions } : {}) };
}
