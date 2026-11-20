# SLS Consumer Group Protocol Gate

**Status**: BLOCKED pending a supported real-time client or verified protocol implementation.

**Checked**: 2026-11-20 against `@alicloud/log@1.2.6` (MIT).

## Evidence

- The official Node.js package `@alicloud/log@1.2.6` is published under the MIT license and points to `aliyun/aliyun-log-nodejs-sdk`.
- The package exposes project, logstore, index, bounded log query, histogram, and write APIs.
- The package does not expose Consumer Group membership, shard assignment, checkpoint/ack, rebalance, or a stable per-record source position API.
- No second maintained TypeScript client with those semantics was identified during the GitHub/npm review.

## Decision

The implementation must not replace the required SLS Consumer Group with periodic polling. T010 remains blocked until a supported protocol/client can demonstrate:

1. group membership and shard assignment;
2. checkpoint/ack and restart recovery;
3. rebalance without concurrent ownership;
4. retry behavior and a stable source-position key.

The ordinary SLS adapter may proceed with bounded connection/read tests using the official SDK. The staging project and logstore are configuration inputs only and must not be written to this repository with credentials.
