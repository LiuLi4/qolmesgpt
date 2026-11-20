# HolmesGPT Investigation Worker

The investigation worker claims `InvestigationRequested` outbox messages with a five-minute lease, marks the task `INVESTIGATING`, and sends a bounded request to HolmesGPT `POST /api/chat`. The request uses the Holmes structured JSON response format and includes only the project path, workspace reference and redacted persisted log evidence. GitLab access tokens and SLS credentials are never included.

Successful responses must contain a summary, root cause, code context, proposed fix and confidence. The worker stores that result and moves the task to `AWAITING_APPROVAL`. HTTP failures, timeouts and incomplete responses are recorded with a safe error code. The first two failures are retried with capped delays; the third failure moves the task to `FAILED` and removes the outbox message.

Run it with:

```bash
DATABASE_URL='<postgres-connection-url>' HOLMESGPT_URL='http://holmesgpt:8080' HOLMESGPT_API_KEY='<optional-key>' pnpm --filter @qolmesgpt/workers start:investigation
```
