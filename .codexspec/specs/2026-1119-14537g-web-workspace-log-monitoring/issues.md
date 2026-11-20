# Implementation Issues

## SLS Consumer Group protocol is not available in the maintained Node SDK

- **Task**: T009 [BLOCKING]
- **Error**: `@alicloud/log@1.2.6` has no Consumer Group membership, shard assignment, checkpoint/ack, rebalance, or stable source-position API.
- **Attempted**: Inspected the official MIT package and searched npm/GitHub for a maintained TypeScript implementation with the required semantics.
- **Status**: Blocked pending a supported protocol/client. Polling is not an accepted workaround under REQ-016 and NFR-006/NFR-007.
