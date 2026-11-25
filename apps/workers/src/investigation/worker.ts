import type { InvestigationJob, InvestigationResult, HolmesClient } from "./client.js";

type Store = {
  isAutomationEnabled?(taskId: string): Promise<boolean>;
  defer?(outboxId: string, owner: string): Promise<void>;
  claim(owner: string): Promise<InvestigationJob | null>;
  complete(outboxId: string, owner: string, result: InvestigationResult, evidenceVersion: number): Promise<void>;
  fail(outboxId: string, owner: string, error: { code: string; message: string }, retryAt: Date | null): Promise<void>;
};

const RETRY_DELAYS_MS = [30_000, 120_000];

export async function runInvestigationOnce(store: Store, client: HolmesClient, owner: string): Promise<boolean> {
  const job = await store.claim(owner);
  if (!job) return false;
  const controller = new AbortController();
  let checking = false;
  const check = async () => {
    if (!store.isAutomationEnabled || checking) return;
    checking = true;
    try { if (!(await store.isAutomationEnabled(job.taskId))) controller.abort(new Error("HOLMES_AUTOMATION_PAUSED")); }
    catch { controller.abort(new Error("HOLMES_AUTOMATION_UNAVAILABLE")); }
    finally { checking = false; }
  };
  await check();
  const timer = store.isAutomationEnabled ? setInterval(() => { void check(); }, 1000) : undefined;
  try {
    controller.signal.throwIfAborted();
    const result = await client.investigate(job, controller.signal);
    await check();
    controller.signal.throwIfAborted();
    await store.complete(job.outboxId, owner, result, job.evidenceVersion);
  } catch (error) {
    if (controller.signal.aborted && store.defer) {
      await store.defer(job.outboxId, owner);
      return true;
    }
    const message = error instanceof Error ? error.message : "HOLMES_INVESTIGATION_FAILED";
    if (message === "Investigation outbox lease lost") return true;
    const retryDelay = RETRY_DELAYS_MS[job.attempts - 1];
    try {
      await store.fail(job.outboxId, owner, { code: message.startsWith("HOLMES_") ? message : "HOLMES_INVESTIGATION_FAILED", message: message.startsWith("HOLMES_") ? message : "HolmesGPT investigation failed" }, retryDelay ? new Date(Date.now() + retryDelay) : null);
    } catch (failure) {
      // A pause may revoke the claim between the model failure and this write.
      if (!(failure instanceof Error) || failure.message !== "Investigation outbox lease lost") throw failure;
    }
  } finally {
    if (timer) clearInterval(timer);
  }
  return true;
}
