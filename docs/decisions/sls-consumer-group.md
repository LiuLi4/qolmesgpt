# SLS Consumer Group Protocol Gate

**Status**: VERIFIED against the staging SLS project with a dedicated Consumer Group. The TypeScript protocol adapter, live probe, and contract tests are checked in.

**Checked**: 2026-11-20 against the official Node.js SDKs `@alicloud/log@1.2.6` (MIT) and `@alicloud/sls20201230@5.12.0` (Apache-2.0).

## Evidence

- The official Node.js package `@alicloud/log@1.2.6` is published under the MIT license and points to `aliyun/aliyun-log-nodejs-sdk`.
- The package exposes project, logstore, index, bounded log query, histogram, and write APIs.
- The package does not expose Consumer Group membership, shard assignment, checkpoint/ack, rebalance, or a stable per-record source position API.
- The official `@alicloud/sls20201230@5.12.0` OpenAPI package contains generated methods for consumer-group creation/listing, heartbeat assignments, checkpoint reads/updates, and cursor lookup.
- Its generated `pullLogs` method is documented as unsupported by the OpenAPI SDK. PullLogs returns Protocol Buffer data, while the generated method models the response as JSON and does not provide a usable SLS log-group decoder. The presence of a generated method therefore does not establish a working consumer.
- The official Node.js SDK contains SLS Protocol Buffer definitions and bounded-query support, but no Consumer Group implementation. The official Python SDK has consumer-group machinery, but it does not satisfy this project's TypeScript worker runtime without introducing a separate service/runtime boundary.
- GitHub/npm candidate review found no maintained TypeScript package that provides the complete consumer lifecycle and decodable PullLogs stream. The OpenAPI SDK was not added because it cannot satisfy the required read path by itself.
- `apps/workers/src/sls-consumer/protocol.ts` implements the missing Node.js boundary directly: HMAC-SHA1 requests, consumer-group lifecycle, heartbeat assignment, cursor lookup, PullLogs Protobuf decoding, and checkpoint updates with ownership checks.
- `apps/workers/test/sls-consumer.test.ts` verifies signing, group creation/reuse, assignment, Protobuf decoding, stable source positions, and rejection of checkpoints for unowned shards. These tests use a transport stub and do not prove connectivity to the staging project.
- `apps/workers/src/sls-consumer/staging-probe.ts` verified two shards in `pyxis-telemetry-log / pyxis-trace-staging` using Consumer Group `qolmesgpt-probe-20261120-codex`. It decoded live logs, compared their source keys on replay from the same cursor, opened a new client that read and resumed from the stored checkpoint, and verified disjoint assignments for two consumers. The adapter rejected a checkpoint write by the former owner of a transferred shard.

## Decision

The implementation must not replace the required SLS Consumer Group with periodic polling. The adapter demonstrated against the staging project:

1. group membership and shard assignment against SLS;
2. PullLogs Protobuf decoding and a stable source-position key;
3. checkpoint write, readback, and resume from a new client;
4. shard reassignment and local checkpoint protection after revocation.

The probe retries while waiting for an assignment. A transport fixture verifies that a failed heartbeat clears local shard ownership until a subsequent heartbeat succeeds. T010 owns the worker's persistence transaction and verifies that the worker acknowledges SLS only after the transaction commits.

Source keys use the input cursor and batch ordinal. The staging probe checks replay from that cursor. T010 must preserve batch boundaries across retries and scope deduplication to the data source connection.

## Run the staging probe

From the repository root, build the worker and run the probe with a local credentials file.

```bash
pnpm --filter @qolmesgpt/workers build
node --env-file="$HOME/.config/qolmesgpt/staging-sls.env" apps/workers/dist/sls-consumer/staging-probe.js
```

Run one probe at a time. It creates or reuses the dedicated test group and updates that group's checkpoint. Allow the previous consumers' 60-second leases to expire before a repeat run.

The ordinary SLS adapter may proceed with bounded connection/read tests using the official SDK. The staging project and logstore are configuration inputs only and must not be written to this repository with credentials.
