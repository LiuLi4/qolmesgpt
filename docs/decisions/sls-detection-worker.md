# SLS Detection Worker

The independent TypeScript worker consumes every enabled, verified Alibaba SLS connection through a dedicated Consumer Group named `qolmesgpt-<connection-id>`. It uses the SLS checkpoint as the authoritative cursor. A shard without a checkpoint starts at the connection's fixed enablement timestamp. This avoids historical backfill and gives retries the same start position if a failure occurs before the first checkpoint.

Each PullLogs request reads one log group. The batch's input cursor and log ordinal form the stable source-position key. The worker applies the default error classifier and writes one `ErrorEvent`, one high-priority `InvestigationTask`, and one `InvestigationRequested` outbox row for each new error in one PostgreSQL transaction. The unique `(dataSourceConnectionId, sourcePositionKey)` constraint suppresses replay duplicates. The SLS checkpoint advances only after that transaction succeeds. Normal logs advance the checkpoint without creating cards.

The worker checks assignments every ten seconds, discards revoked shard cursors, loads checkpoints for newly assigned shards, and retries transient SLS or database failures with capped backoff. A PostgreSQL lease allows only one worker instance to own a connection; it must be renewed before checkpoint writes. `SLSConsumerState` stores the lease, status, assignments, a lagging flag, last successful checkpoint, heartbeat time, and a safe error code with retry time on failure. Error evidence is bounded and redacted before persistence. If a connection is paused or disabled, its consumer stops. Updating an enabled connection restarts its consumer with the new configuration.

## Run

Generate the Prisma client and build the workspace, apply migrations to the development database, then start the worker:

```bash
pnpm --filter @qolmesgpt/control-plane db:generate
pnpm build
DATABASE_URL='<postgres-connection-url>' pnpm --filter @qolmesgpt/control-plane exec prisma migrate deploy
DATABASE_URL='<postgres-connection-url>' QOLMESGPT_CREDENTIAL_KEY_BASE64='<base64-encoded-32-byte-key>' pnpm --filter @qolmesgpt/workers start
```

`QOLMESGPT_CREDENTIAL_KEY_VERSION` defaults to `v1`; it must match the version used when the Web API encrypted each connection's credentials. Keep the key outside Git. The worker reads credentials only from encrypted `DataSourceConnection` rows; a local `SLS_ACCESS_KEY_*` environment file alone does not enable a source.

## Verification

- `pnpm test` covers classification, checkpoint ordering, restart recovery, retry, and ownership.
- With the development PostgreSQL container running, `DATABASE_URL='<postgres-connection-url>' pnpm --filter @qolmesgpt/control-plane test` runs the transactional integration test. It proves same-position replay creates no extra task, distinct positions with the same fingerprint create separate tasks, non-errors create no task, outbox rows match tasks, a failed task write rolls back the event, chunk replay is idempotent, and only one worker holds a connection lease.
- The Consumer Group protocol itself was verified against `pyxis-telemetry-log / pyxis-trace-staging`; see `docs/decisions/sls-consumer-group.md`.
- A live staging log creating a card through an enabled project connection remains an end-to-end test for T016, after GitLab project selection and Web configuration are available.
