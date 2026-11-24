import type { SlsPulledLog } from "./protocol.js";

export interface PullProtocol {
  pullLogs(shard: number, cursor: string, count: number): Promise<{ logs: readonly SlsPulledLog[]; nextCursor: string; logGroupCount: number }>;
  updateCheckpoint(shard: number, cursor: string): Promise<void>;
}

export async function consumeShard(
  protocol: PullProtocol,
  shard: number,
  cursor: string,
  persist: (logs: readonly SlsPulledLog[]) => Promise<void>,
): Promise<{ cursor: string; logGroupCount: number }> {
  // A fixed one-group pull keeps source-position ordinals stable on replay.
  const batch = await protocol.pullLogs(shard, cursor, 1);
  if (batch.logs.length) await persist(batch.logs);
  if (batch.nextCursor !== cursor) await protocol.updateCheckpoint(shard, batch.nextCursor);
  return { cursor: batch.nextCursor, logGroupCount: batch.logGroupCount };
}
