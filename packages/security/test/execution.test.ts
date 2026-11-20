import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NsjailExecutionRunner } from "../dist/execution.js";

test("nsjail execution is fail-closed and bounds the process contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "qolmesgpt-jail-"));
  const workspace = join(root, "workspace");
  const jail = join(root, "rootfs");
  await mkdir(workspace);
  await mkdir(join(jail, "workspace"), { recursive: true });
  try {
    const calls: string[][] = [];
    const runner = new NsjailExecutionRunner(async (file, args) => {
      calls.push([file, ...args]);
      return { stdout: "x".repeat(2000), stderr: "" };
    }, "linux");
    await assert.rejects(runner.execute({ command: "/bin/sh", args: ["-c", "echo unsafe"], workspacePath: workspace, workspaceRoot: root, jailRoot: jail }), /allowlisted/);
    const result = await runner.execute({ command: "/usr/bin/node", args: ["-e", "process.stdout.write('ok')"], workspacePath: workspace, workspaceRoot: root, jailRoot: jail, maxOutputBytes: 1024 });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /TRUNCATED/);
    assert.ok(calls[0]?.includes("--rlimit_nproc"));
    assert.ok(calls[0]?.includes("--bindmount"));
    assert.ok(!calls[0]?.includes("--disable_clone_newnet"));
    const unsupported = new NsjailExecutionRunner(async () => ({ stdout: "", stderr: "" }), "darwin");
    await assert.rejects(unsupported.execute({ command: "/usr/bin/node", args: [], workspacePath: workspace, workspaceRoot: root, jailRoot: jail }), /requires Linux/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
