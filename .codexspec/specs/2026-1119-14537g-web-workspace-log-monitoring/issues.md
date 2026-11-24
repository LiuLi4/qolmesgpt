# Implementation Issues

## Issue: SLS Consumer Group has no verified TypeScript read path

- **Task**: T009
- **Error**: `@alicloud/log@1.2.6` has no Consumer Group lifecycle APIs. `@alicloud/sls20201230@5.12.0` provides generated group, heartbeat, checkpoint, and cursor methods, but documents PullLogs as unsupported by the OpenAPI SDK and does not decode the Protobuf log-group response.
- **Attempted**: Reviewed both official Node.js SDK surfaces and package licenses, compared the official Python consumer implementation as a reference, and implemented a small TypeScript protocol adapter using `protobufjs` for PullLogs decoding. Mock contract tests pass for signing, group lifecycle, assignment, decoding, source position, and checkpoint ownership.
- **Status**: Resolved. The live staging probe verified assignment, PullLogs decoding, checkpoint recovery, disjoint rebalance assignments, revoked-checkpoint rejection, and stable replay positions against `pyxis-telemetry-log/pyxis-trace-staging`. T010 may proceed; periodic polling remains disallowed.


## Issue: Real investigation model credentials rejected

- **Task**: T011 / live end-to-end investigation.
- **Observed**: HolmesGPT `/api/chat` reaches the configured provider, which returns HTTP 401: the local OPENROUTER_API_KEY is not a valid OpenRouter key.
- **Status**: Requires a valid model credential configured locally and a Holmes service restart. UI preserves FAILED and offers retry. No fake analysis is stored.
- **Verified independently**: SLS request context (55 additional logs), 10 repository searches, task grouping and database/worker/UI regression checks. Private source text is withheld from prompts and runtime checkouts are ignored by Git.
