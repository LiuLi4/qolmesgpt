import type { InvestigationJob, InvestigationResult, HolmesClient } from "./client.js";

type Store = {
  claim(owner: string): Promise<InvestigationJob | null>;
  complete(outboxId: string, owner: string, result: InvestigationResult): Promise<void>;
  fail(outboxId: string, owner: string, error: { code: string; message: string }, retryAt: Date | null): Promise<void>;
};

const RETRY_DELAYS_MS = [30_000, 120_000];

export async function runInvestigationOnce(store: Store, client: HolmesClient, owner: string): Promise<boolean> {
  const job = await store.claim(owner);
  if (!job) return false;
  try {
    await store.complete(job.outboxId, owner, await client.investigate(job));
  } catch (error) {
    const message = error instanceof Error ? error.message : "HOLMES_INVESTIGATION_FAILED";
    const retryDelay = RETRY_DELAYS_MS[job.attempts - 1];
    await store.fail(job.outboxId, owner, { code: message.startsWith("HOLMES_") ? message : "HOLMES_INVESTIGATION_FAILED", message: message.startsWith("HOLMES_") ? message : "HolmesGPT investigation failed" }, retryDelay ? new Date(Date.now() + retryDelay) : null);
  }
  return true;
}
