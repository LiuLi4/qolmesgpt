# SLS Consumer Group Protocol Gate

**Status**: BLOCKED pending a supported Node.js real-time consumer or a verified protocol implementation.

**Checked**: 2026-11-20 against the official Node.js SDKs `@alicloud/log@1.2.6` (MIT) and `@alicloud/sls20201230@5.12.0` (Apache-2.0).

## Evidence

- The official Node.js package `@alicloud/log@1.2.6` is published under the MIT license and points to `aliyun/aliyun-log-nodejs-sdk`.
- The package exposes project, logstore, index, bounded log query, histogram, and write APIs.
- The package does not expose Consumer Group membership, shard assignment, checkpoint/ack, rebalance, or a stable per-record source position API.
- The official `@alicloud/sls20201230@5.12.0` OpenAPI package contains generated methods for consumer-group creation/listing, heartbeat assignments, checkpoint reads/updates, and cursor lookup.
- Its generated `pullLogs` method is documented as unsupported by the OpenAPI SDK. PullLogs returns Protocol Buffer data, while the generated method models the response as JSON and does not provide a usable SLS log-group decoder. The presence of a generated method therefore does not establish a working consumer.
- The official Node.js SDK contains SLS Protocol Buffer definitions and bounded-query support, but no Consumer Group implementation. The official Python SDK has consumer-group machinery, but it does not satisfy this project's TypeScript worker runtime without introducing a separate service/runtime boundary.
- GitHub/npm candidate review found no maintained TypeScript package that provides the complete consumer lifecycle and decodable PullLogs stream. The OpenAPI SDK was not added because it cannot satisfy the required read path by itself.

## Decision

The implementation must not replace the required SLS Consumer Group with periodic polling. T010 remains blocked until a supported Node.js consumer or an independently verified adapter can demonstrate:

1. group membership and shard assignment against SLS;
2. PullLogs Protobuf decoding and a stable source-position key;
3. checkpoint/ack only after durable persistence, with restart recovery;
4. rebalance without concurrent ownership and with retry behavior.

The ordinary SLS adapter may proceed with bounded connection/read tests using the official SDK. The staging project and logstore are configuration inputs only and must not be written to this repository with credentials.
