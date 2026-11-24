import type { SlsPulledLog, AliyunSlsConsumerProtocol } from "./protocol.js";

type Reader = Pick<AliyunSlsConsumerProtocol, "listShards" | "getCursor" | "readLogs">;

// Replay reads the same one-group positions as the consumer, without joining its group or moving checkpoints.
export async function backfillSls(
  protocol: Reader, from: Date, to: Date,
  persist: (logs: readonly SlsPulledLog[]) => Promise<number>,
  continuation?: Record<string, string>,
): Promise<{ scanned: number; created: number; complete: boolean; cursors: Record<string, string> }> {
  const start = from.getTime(); const end = to.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 86_400_000 || end > Date.now() + 1000) {
    throw new Error("Historical read must be a positive interval of at most 24 hours ending no later than now");
  }
  const shards = await protocol.listShards();
  const cursors: Record<string, string> = {};
  let scanned = 0; let created = 0; let pulls = 0;
  for (const shard of shards) {
    if (continuation && !Object.hasOwn(continuation, String(shard))) continue;
    let cursor = continuation?.[String(shard)] ?? await protocol.getCursor(shard, Math.floor(start / 1000));
    if (typeof cursor !== "string" || !cursor || cursor.length > 512) throw new Error("Invalid historical cursor");
    const stop = await protocol.getCursor(shard, Math.ceil(end / 1000));
    while (cursor !== stop && pulls < 100) {
      const batch = await protocol.readLogs(shard, cursor, 1); pulls++;
      const logs = batch.logs.filter((log) => Number(log.record.__time__) * 1000 >= start && Number(log.record.__time__) * 1000 < end);
      scanned += logs.length;
      if (logs.length) created += await persist(logs);
      if (batch.nextCursor === cursor) throw new Error("Historical SLS cursor stalled; retry after checking retention and time range");
      cursor = batch.nextCursor;
    }
    if (cursor !== stop) cursors[String(shard)] = cursor;
  }
  return { scanned, created, complete: Object.keys(cursors).length === 0, cursors };
}
