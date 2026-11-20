import { AliyunSlsConsumerProtocol, type SlsConsumerConfig } from "./protocol.js";

const PROJECT = "pyxis-telemetry-log";
const LOGSTORE = "pyxis-trace-staging";
const ENDPOINT = "https://cn-shanghai.log.aliyuncs.com";
const GROUP = "qolmesgpt-probe-20261120-codex";

function config(consumerId: string): SlsConsumerConfig {
  const accessKeyId = process.env.SLS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.SLS_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) throw new Error("SLS_ACCESS_KEY_ID and SLS_ACCESS_KEY_SECRET are required");
  return {
    endpoint: ENDPOINT,
    project: PROJECT,
    logstore: LOGSTORE,
    consumerGroup: GROUP,
    consumerId,
    accessKeyId,
    accessKeySecret,
    ...(process.env.SLS_SECURITY_TOKEN ? { securityToken: process.env.SLS_SECURITY_TOKEN } : {}),
  };
}

async function assignedShards(consumer: AliyunSlsConsumerProtocol, current: number[] = []): Promise<number[]> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const assigned = await consumer.heartbeat(current);
    if (assigned.length) return assigned;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("SLS did not assign a shard after six heartbeats");
}

async function main(): Promise<void> {
  const first = new AliyunSlsConsumerProtocol(config("probe-a"));
  await first.ensureConsumerGroup();
  const shards = await first.listShards();
  if (!shards.length) throw new Error("SLS returned no shards");
  const firstAssignment = await assignedShards(first);
  const shard = firstAssignment[0];
  if (shard === undefined) throw new Error("SLS returned an empty assignment");

  const startCursor = await first.getCursor(shard, "begin");
  const firstRead = await first.pullLogs(shard, startCursor, 1);
  const replay = await first.pullLogs(shard, startCursor, 1);
  if (firstRead.logs.length === 0) throw new Error("No staging logs available to verify Protobuf decoding");
  const sourcePositions = firstRead.logs.map((log) => log.sourcePositionKey);
  if (new Set(sourcePositions).size !== sourcePositions.length
    || firstRead.nextCursor !== replay.nextCursor
    || sourcePositions.length !== replay.logs.length
    || sourcePositions.some((position, i) => position !== replay.logs[i]?.sourcePositionKey)) {
    throw new Error("Replayed logs changed their source positions");
  }
  if (firstRead.nextCursor === startCursor) throw new Error("SLS did not advance the cursor");

  await first.updateCheckpoint(shard, firstRead.nextCursor);
  const restarted = new AliyunSlsConsumerProtocol(config("probe-a"));
  const restartedAssignment = await assignedShards(restarted, firstAssignment);
  const checkpoint = (await restarted.getCheckpoints()).find((item) => item.shard === shard);
  if (checkpoint?.checkpoint !== firstRead.nextCursor) throw new Error("Checkpoint was not recovered after consumer restart");
  await restarted.pullLogs(shard, checkpoint.checkpoint, 1);

  const second = new AliyunSlsConsumerProtocol(config("probe-b"));
  let firstAfterRebalance = restartedAssignment;
  let secondAssignment: number[] = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    secondAssignment = await second.heartbeat(secondAssignment);
    firstAfterRebalance = await restarted.heartbeat(firstAfterRebalance);
    if (firstAfterRebalance.length && secondAssignment.length && !firstAfterRebalance.some((item) => secondAssignment.includes(item))) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!firstAfterRebalance.length || !secondAssignment.length || firstAfterRebalance.some((item) => secondAssignment.includes(item))) {
    throw new Error("Two consumers did not receive disjoint shard assignments");
  }
  const transferredShard = secondAssignment.find((item) => restartedAssignment.includes(item));
  if (transferredShard === undefined) throw new Error("Rebalance did not transfer a shard from the first consumer");
  const transferredCursor = await second.getCursor(transferredShard, "begin");
  try {
    await restarted.updateCheckpoint(transferredShard, transferredCursor);
    throw new Error("Revoked consumer was allowed to update a checkpoint");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("does not own shard")) throw error;
  }

  console.log(JSON.stringify({
    project: PROJECT,
    logstore: LOGSTORE,
    group: GROUP,
    shards,
    readShard: shard,
    decodedLogs: firstRead.logs.length,
    replayPositionsStable: true,
    checkpointRecovered: true,
    revokedCheckpointRejected: true,
    firstAssignment: firstAfterRebalance,
    secondAssignment,
  }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "SLS staging probe failed";
  const apiError = /^SLS ([A-Za-z][A-Za-z0-9_]*):/.exec(message);
  console.error(apiError ? `SLS request failed (${apiError[1]})` : message);
  process.exitCode = 1;
});
