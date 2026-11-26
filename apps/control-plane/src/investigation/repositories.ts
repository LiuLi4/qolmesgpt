import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { devNull } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { safeWorkspacePath } from "../workspace/group.js";
import { validBranch } from "../workspace/repositories.js";

const exec = promisify(execFile);
export interface RepositoryVersion {
  projectId: string; projectPath: string; branch: string; commitSha: string | null;
  readAt: string; status: "READ" | "FAILED"; errorCode?: string;
}
export interface RepositorySnapshot {
  version: RepositoryVersion;
  search(terms: readonly string[]): Promise<string[]>;
  close(): Promise<void>;
}

/** A per-investigation bare repository: neither developer edits nor repair checkouts are touched. */
export async function snapshotRepository(root: string, input: { projectId: string; projectPath: string; branch: string; remoteUrl: string; instanceUrl: string; token: string; deadline?: number }): Promise<RepositorySnapshot> {
  const deadline = input.deadline ?? Date.now() + 20_000;
  if (!validBranch(input.branch)) throw new Error("INVALID_INVESTIGATION_BRANCH");
  const url = new URL(input.remoteUrl); const origin = new URL(input.instanceUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin.origin || url.username || url.password || url.search || url.hash) throw new Error("INVALID_REPOSITORY_ORIGIN");
  const base = await safeWorkspacePath(root, ".investigation-snapshots");
  await mkdir(base, { recursive: true });
  const path = await mkdtemp(resolve(base, "snapshot-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "4", GIT_CONFIG_KEY_0: `http.${url.origin}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`oauth2:${input.token}`).toString("base64")}`, GIT_CONFIG_KEY_1: "http.followRedirects", GIT_CONFIG_VALUE_1: "false", GIT_CONFIG_KEY_2: "core.hooksPath", GIT_CONFIG_VALUE_2: devNull, GIT_CONFIG_KEY_3: "protocol.file.allow", GIT_CONFIG_VALUE_3: "never" };
  const run = async (args: string[]) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("REPOSITORY_SNAPSHOT_TIMEOUT");
    return (await exec("git", args, { cwd: path, env, timeout: Math.min(20_000, remaining), maxBuffer: 256_000 })).stdout;
  };
  try {
    await run(["init", "--bare", "--quiet"]);
    await run(["fetch", "--quiet", "--depth=1", "--no-tags", input.remoteUrl, `refs/heads/${input.branch}`]);
    const commitSha = (await run(["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).trim();
    if (!/^[a-f0-9]{40,64}$/.test(commitSha)) throw new Error("INVALID_REPOSITORY_COMMIT");
    return {
      version: { projectId: input.projectId, projectPath: input.projectPath, branch: input.branch, commitSha, readAt: new Date().toISOString(), status: "READ" },
      search: async (terms) => {
        if (!terms.length) return [];
        const args = ["grep", "-n", "-I", "-F", ...terms.slice(0, 6).flatMap((t) => ["-e", t]), commitSha, "--", "*.ts", "*.tsx", "*.js", "*.py", "*.go", "*.java", ":(exclude)*test*", ":(exclude)*lock*", ":(exclude)*config*", ":(exclude)*secret*"];
        let output = "";
        try { output = await run(args); } catch (error) { if ((error as { code?: number }).code !== 1) throw new Error("REPOSITORY_SEARCH_FAILED"); }
        return [...new Set(output.split("\n").flatMap((line) => { const m = /^[a-f0-9]+:([^:]+):(\d+):/.exec(line); return m ? [`${m[1]}:${m[2]}`] : []; }))].slice(0, 60);
      },
      close: () => rm(path, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    if (error instanceof Error && ["REPOSITORY_SNAPSHOT_TIMEOUT", "INVALID_REPOSITORY_COMMIT"].includes(error.message)) throw error;
    throw new Error("REPOSITORY_FETCH_FAILED");
  }
}
