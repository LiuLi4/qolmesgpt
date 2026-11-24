import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createRepairRuntime } from "@qolmesgpt/control-plane";
import { runRepairWorker } from "./worker.js";

const runtime = await createRepairRuntime();
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try {
  await runRepairWorker(runtime.outbox, runtime.repair, runtime.workspace, runtime.executor, runtime.roles, `repair-${hostname()}-${randomUUID()}`, runtime.config, controller.signal);
} finally {
  await runtime.close();
}
