# Approval and Repair Execution

An approval is valid only when the task is `AWAITING_APPROVAL`, the task has no earlier decision, and the current GitLab Group role check returns Developer, Maintainer or Owner. The approval transaction records the checked role and timestamp and enqueues one `RepairRequested` outbox message. A rejected decision closes the task.

The Repair Worker rechecks the approver's live GitLab role before acquiring the project workspace lease and before every command. The lease uses a monotonically increasing fencing token; expired or superseded leases fail closed. The worker records `RepairRun` output with bounded stdout/stderr and moves the task to `FAILED` on command failure.

Approval emits a `RepairRequested` outbox message. `start:repair` claims that message with a lease, reads only a structured `repairCommands` array from the investigation result, and retries transient failures before removing the message on final failure. Missing or malformed commands are rejected as `REPAIR_PLAN_MISSING`; natural-language fix text is never executed.

On Linux, commands execute through `nsjail` with a non-privileged UID, isolated network by default, a read-only jail root bind mount, one writable workspace bind mount, CPU/address-space/process/file limits, no shell, an explicit command allowlist, and a wall-clock timeout. The prepared jail root must contain the supported tools and a `/workspace` mount point. macOS development runs only injected executor tests; it refuses actual repair execution because nsjail is unavailable.

The implementation evaluated `google/nsjail` (Apache-2.0, active) as the first supported sandbox dependency. It was not vendored; deployments must provide `/usr/bin/nsjail` and a prepared jail root.

Start the worker with `DATABASE_URL`, `QOLMESGPT_CREDENTIAL_KEY_BASE64`, `QOLMESGPT_WORKSPACE_ROOT`, `QOLMESGPT_REPAIR_JAIL_ROOT`, `GITLAB_OAUTH_CLIENT_ID`, and `GITLAB_OAUTH_REDIRECT_URI` configured. GitLab connection tokens remain encrypted in PostgreSQL and are decrypted only for the live role check.
