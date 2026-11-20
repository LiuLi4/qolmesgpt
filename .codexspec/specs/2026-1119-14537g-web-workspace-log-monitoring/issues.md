# Implementation Issues

## Issue: SLS Consumer Group has no verified TypeScript read path

- **Task**: T009
- **Error**: `@alicloud/log@1.2.6` has no Consumer Group lifecycle APIs. `@alicloud/sls20201230@5.12.0` provides generated group, heartbeat, checkpoint, and cursor methods, but documents PullLogs as unsupported by the OpenAPI SDK and does not decode the Protobuf log-group response.
- **Attempted**: Reviewed both official Node.js SDK surfaces and package licenses, compared the official Python consumer implementation as a reference, and implemented a small TypeScript protocol adapter using `protobufjs` for PullLogs decoding. Mock contract tests pass for signing, group lifecycle, assignment, decoding, source position, and checkpoint ownership.
- **Status**: Resolved. The live staging probe verified assignment, PullLogs decoding, checkpoint recovery, disjoint rebalance assignments, revoked-checkpoint rejection, and stable replay positions against `pyxis-telemetry-log/pyxis-trace-staging`. T010 may proceed; periodic polling remains disallowed.
