import { execFile } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ALLOWED_COMMANDS = new Set(["/usr/bin/bun", "/usr/bin/cargo", "/usr/bin/go", "/usr/bin/make", "/usr/bin/node", "/usr/bin/npm", "/usr/bin/pnpm", "/usr/bin/python3", "/usr/bin/pytest", "/usr/bin/yarn"]);

export interface ExecutionRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly workspacePath: string;
  readonly workspaceRoot: string;
  readonly jailRoot: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface ExecutionResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export type ProcessRunner = (file: string, args: readonly string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;

const runProcess: ProcessRunner = async (file, args, options) => {
  const result = await execFileAsync(file, [...args], {
    shell: false,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" },
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[TRUNCATED]`;
}

export class NsjailExecutionRunner {
  constructor(private readonly runner: ProcessRunner = runProcess, private readonly platform = process.platform) {}

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    if (!ALLOWED_COMMANDS.has(request.command)) throw new Error("Repair command is not allowlisted");
    if (request.args.some((arg) => arg.includes("\0"))) throw new Error("Repair command arguments cannot contain NUL");
    if (this.platform !== "linux") throw new Error("Repair execution requires Linux with nsjail");
    const workspaceRoot = await realpath(request.workspaceRoot);
    const workspacePath = await realpath(request.workspacePath);
    const jailRoot = await realpath(request.jailRoot);
    const workspaceStat = await lstat(request.workspacePath);
    if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) throw new Error("Repair workspace must be a real directory");
    const jailWorkspaceStat = await stat(join(jailRoot, "workspace")).catch(() => null);
    if (!jailWorkspaceStat?.isDirectory()) throw new Error("nsjail rootfs must provide a workspace mount point");
    const relativeWorkspace = relative(workspaceRoot, workspacePath);
    if (!relativeWorkspace || relativeWorkspace.startsWith("..") || isAbsolute(relativeWorkspace)) throw new Error("Repair workspace escapes the configured workspace root");
    const timeoutMs = Math.min(Math.max(request.timeoutMs ?? 120_000, 1_000), 15 * 60_000);
    const maxOutputBytes = Math.min(Math.max(request.maxOutputBytes ?? 64 * 1024, 1_024), 512 * 1024);
    const args = [
      "--mode", "o",
      "--chroot", jailRoot,
      "--bindmount_ro", `${jailRoot}:/`,
      "--user", "65534",
      "--group", "65534",
      "--time_limit", String(Math.ceil(timeoutMs / 1_000)),
      "--rlimit_as", "2048",
      "--rlimit_cpu", String(Math.ceil(timeoutMs / 1_000)),
      "--rlimit_nofile", "64",
      "--rlimit_nproc", "64",
      "--bindmount", `${workspacePath}:/workspace`,
      "--cwd", "/workspace",
      "--",
      request.command,
      ...request.args,
    ];
    try {
      const result = await this.runner("/usr/bin/nsjail", args, { timeout: timeoutMs + 5_000, maxBuffer: Math.min(maxOutputBytes * 8, 512 * 1024) });
      return { command: request.command, args: [...request.args], exitCode: 0, stdout: bounded(result.stdout, maxOutputBytes), stderr: bounded(result.stderr, maxOutputBytes), timedOut: false };
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: unknown };
      return {
        command: request.command,
        args: [...request.args],
        exitCode: typeof failure.code === "number" ? failure.code : 1,
        stdout: bounded(typeof failure.stdout === "string" ? failure.stdout : "", maxOutputBytes),
        stderr: bounded(typeof failure.stderr === "string" ? failure.stderr : "Repair command failed", maxOutputBytes),
        timedOut: failure.killed === true || failure.code === "ETIMEDOUT",
      };
    }
  }
}
