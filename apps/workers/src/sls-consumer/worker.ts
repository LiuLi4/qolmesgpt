import type { EnabledSlsSource, PrismaSlsDetectionStore } from "@qolmesgpt/control-plane";
import { AliyunSlsConsumerProtocol } from "./protocol.js";
import { consumeShard } from "./consume.js";

type Store = Pick<PrismaSlsDetectionStore, "listEnabled" | "persist" | "setState" | "claim" | "renew" | "release">;
type Protocol = Pick<AliyunSlsConsumerProtocol, "ensureConsumerGroup" | "heartbeat" | "getCheckpoints" | "getCursor" | "pullLogs" | "updateCheckpoint">;
type ProtocolFactory = (source: EnabledSlsSource, group: string, workerId: string) => Protocol;

const HEARTBEAT_INTERVAL_MS = 10_000;
const EMPTY_WAIT_MS = 500;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function failureCode(error: unknown): string {
  if (error instanceof Error) {
    const sls = /^SLS ([A-Za-z][A-Za-z0-9_]*):/.exec(error.message);
    if (sls) return sls[1] ?? "SLS_REQUEST_FAILED";
    if (error.message.includes("lease")) return "CONNECTION_LEASE_LOST";
    if (error.message.includes("cursor") || error.message.includes("shard")) return "SLS_POSITION_FAILURE";
  }
  return "CONSUMER_OPERATION_FAILED";
}

export function slsConsumerGroup(connectionId: string): string {
  return `qolmesgpt-${connectionId}`;
}

export function defaultProtocol(source: EnabledSlsSource, group: string, workerId: string): Protocol {
  return new AliyunSlsConsumerProtocol({
    endpoint: source.endpoint,
    project: source.project,
    logstore: source.logstore,
    consumerGroup: group,
    consumerId: workerId,
    accessKeyId: source.accessKeyId,
    accessKeySecret: source.accessKeySecret,
    ...(source.securityToken ? { securityToken: source.securityToken } : {}),
  });
}

export async function runSlsSource(
  source: EnabledSlsSource,
  store: Store,
  workerId: string,
  signal: AbortSignal,
  factory: ProtocolFactory = defaultProtocol,
): Promise<void> {
  const group = slsConsumerGroup(source.id);
  let backoff = 1_000;
  let lastCheckpoint: string | null = null;
  while (!signal.aborted) {
    let assignments: number[] = [];
    let claimed = false;
    try {
      claimed = await store.claim(source.id, group, workerId);
    } catch {
      await wait(backoff, signal);
      backoff = Math.min(backoff * 2, 30_000);
      continue;
    }
    if (!claimed) {
      await wait(5_000, signal);
      continue;
    }
    try {
      await store.setState(source.id, group, workerId, "STARTING", [], { lagging: false, lastCheckpoint });
      const protocol = factory(source, group, workerId);
      await protocol.ensureConsumerGroup();
      const cursors = new Map<number, string>();
      let lastHeartbeat = 0;
      while (!signal.aborted) {
        const now = Date.now();
        if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
          if (!(await store.renew(source.id, workerId))) throw new Error("SLS worker lost its connection lease");
          const next = await protocol.heartbeat(assignments);
          const old = new Set(assignments);
          assignments = next;
          for (const shard of cursors.keys()) if (!assignments.includes(shard)) cursors.delete(shard);
          if (assignments.some((shard) => !old.has(shard))) {
            const checkpoints = await protocol.getCheckpoints();
            for (const shard of assignments) {
              if (cursors.has(shard)) continue;
              const checkpoint = checkpoints.find((entry) => entry.shard === shard)?.checkpoint;
              cursors.set(shard, checkpoint || await protocol.getCursor(shard, Math.floor(source.enabledAt.getTime() / 1_000)));
            }
          }
          lastHeartbeat = Date.now();
          let lagging = false;
          for (const shard of assignments) {
            if (cursors.get(shard) !== await protocol.getCursor(shard, "end")) lagging = true;
          }
          await store.setState(source.id, group, workerId, assignments.length ? "RUNNING" : "STARTING", assignments, { lagging, lastCheckpoint });
        }

        let progressed = false;
        for (const shard of assignments) {
          if (signal.aborted) break;
          if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) break;
          const cursor = cursors.get(shard);
          if (!cursor) throw new Error("Assigned shard has no cursor");
          const fenced = {
            pullLogs: protocol.pullLogs.bind(protocol),
            updateCheckpoint: async (ownedShard: number, nextCursor: string) => {
              if (!(await store.renew(source.id, workerId))) throw new Error("SLS worker lost its connection lease");
              await protocol.updateCheckpoint(ownedShard, nextCursor);
            },
          };
          const result = await consumeShard(fenced, shard, cursor, (logs) => store.persist(source, logs, workerId).then(() => undefined));
          cursors.set(shard, result.cursor);
          if (result.cursor !== cursor) {
            progressed = true;
            lastCheckpoint = result.cursor;
            backoff = 1_000;
          }
        }
        if (!progressed) await wait(EMPTY_WAIT_MS, signal);
      }
    } catch (error) {
      if (signal.aborted) break;
      try {
        await store.setState(source.id, group, workerId, "DEGRADED", [], { lagging: true, lastCheckpoint, errorCode: failureCode(error), retryAt: new Date(Date.now() + backoff).toISOString() });
      } catch {
        // The database may be the failing dependency; retry the whole source.
      }
      await wait(backoff, signal);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
  try { await store.release(source.id, workerId); } catch { /* Shutdown must continue during a database outage. */ }
}

export async function runSlsWorker(store: Store, workerId: string, signal: AbortSignal, factory: ProtocolFactory = defaultProtocol): Promise<void> {
  const active = new Map<string, { revision: number; controller: AbortController; task: Promise<void> }>();
  try {
    while (!signal.aborted) {
      try {
        const enabled = await store.listEnabled();
        const revisions = new Map(enabled.map((source) => [source.id, source.revision]));
        for (const [id, item] of active) {
          if (revisions.get(id) !== item.revision) {
            item.controller.abort();
            await item.task;
            active.delete(id);
          }
        }
        for (const source of enabled) {
          if (active.has(source.id)) continue;
          const controller = new AbortController();
          active.set(source.id, { revision: source.revision, controller, task: runSlsSource(source, store, workerId, controller.signal, factory) });
        }
      } catch {
        // Discovery resumes after a transient database outage.
      }
      await wait(5_000, signal);
    }
  } finally {
    for (const item of active.values()) item.controller.abort();
    await Promise.all([...active.values()].map((item) => item.task));
  }
}
