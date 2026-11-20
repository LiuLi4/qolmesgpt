# Implementation Issues

## Issue: SLS Consumer Group has no verified TypeScript read path

- **Task**: T009
- **Error**: `@alicloud/log@1.2.6` has no Consumer Group lifecycle APIs. `@alicloud/sls20201230@5.12.0` provides generated group, heartbeat, checkpoint, and cursor methods, but documents PullLogs as unsupported by the OpenAPI SDK and does not decode the Protobuf log-group response.
- **Attempted**: Reviewed both official Node.js SDK surfaces and package licenses, and compared the official Python consumer implementation as a reference. The Python implementation would require a separate runtime/service boundary; the TypeScript SDK methods alone do not provide a working read path. The incomplete OpenAPI SDK dependency was not retained.
- **Status**: Blocked. T010 and later detection/repair stages must not substitute periodic polling. Resume after a Node.js client or verified adapter passes a staging protocol probe for PullLogs decoding, assignment/rebalance, checkpoint recovery, retry, and stable source position.
