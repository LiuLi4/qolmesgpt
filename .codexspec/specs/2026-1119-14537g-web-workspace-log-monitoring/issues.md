# Implementation Issues

## Issue: SLS Consumer Group protocol is not available in the reviewed TypeScript client

- **Task**: T009
- **Error**: The official `@alicloud/log@1.2.6` client exposes bounded log APIs but no Consumer Group membership, shard assignment, checkpoint/ack, rebalance, retry, or stable per-record source-position API.
- **Attempted**: Inspected the published MIT package and its client surface; checked the repository's existing protocol decision record. The required real-time semantics cannot be demonstrated with this client.
- **Status**: Blocked. T010 and later detection/repair stages must not substitute periodic polling. Resume when a supported client or verified protocol implementation is selected and passes the required probe.
