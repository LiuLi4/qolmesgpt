import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createSlsDetectionRuntime } from "@qolmesgpt/control-plane";
import { runSlsWorker } from "./worker.js";

const runtime = await createSlsDetectionRuntime();
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  await runSlsWorker(runtime.store, `${hostname()}-${randomUUID()}`, controller.signal);
} finally {
  await runtime.close();
}
