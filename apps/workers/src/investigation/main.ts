import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createInvestigationRuntime } from "@qolmesgpt/control-plane";
import { HttpHolmesClient } from "./client.js";
import { runInvestigationOnce } from "./worker.js";

const baseUrl = process.env.HOLMESGPT_URL;
if (!baseUrl) throw new Error("HOLMESGPT_URL is required");
const runtime = await createInvestigationRuntime();
const client = new HttpHolmesClient(baseUrl, process.env.HOLMESGPT_API_KEY);
const owner = `investigator-${hostname()}-${randomUUID()}`;
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  while (!controller.signal.aborted) {
    const claimed = await runInvestigationOnce(runtime.store, { investigate: async (job, signal) => { signal?.throwIfAborted(); const prepared = await runtime.prepare(job); signal?.throwIfAborted(); return client.investigate(prepared, signal); } }, owner);
    if (!claimed) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
} finally {
  await runtime.close();
}
