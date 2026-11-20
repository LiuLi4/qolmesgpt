# 实施任务：Web 项目工作区与日志故障闭环

**Plan**: `.codexspec/specs/2026-1119-14537g-web-workspace-log-monitoring/plan.md`
**Design**: `.codexspec/specs/2026-1119-14537g-web-workspace-log-monitoring/design.md`
**Status**: Draft

## Task Groups

### Group A — TypeScript foundation and persistence

#### T001 [P] [x] 建立 TypeScript workspace 与质量检查入口

- **Outcome**: 创建 `apps/control-plane`、`apps/web`、`apps/workers`、`packages/contracts`、`packages/security` 的 workspace 配置；提供 build、lint、typecheck 和 test scripts。
- **Paths**: `package.json`, `pnpm-workspace.yaml` (or selected package-manager equivalent), `tsconfig.base.json`, `apps/*/package.json`, `packages/*/package.json`.
- **Dependencies**: None.
- **Covers**: REQ-027, REQ-028; **Plan**: Phase 1, PLD-001.
- **Verification**: workspace installs cleanly; scripts resolve without modifying Python project behavior.

#### T002 [x] 实现 Prisma schema、迁移与本地 PostgreSQL

- **Outcome**: 建立设计中的实体、关系、索引、唯一约束、timestamptz 和 outbox 表；提供 Docker PostgreSQL 开发启动配置。
- **Paths**: `apps/control-plane/prisma/schema.prisma`, `apps/control-plane/prisma/migrations/`, `docker-compose.yml`, `apps/control-plane/src/db/`.
- **Dependencies**: T001.
- **Covers**: REQ-006–REQ-012, REQ-018, REQ-022–REQ-026, REQ-030–REQ-036, NFR-002, NFR-005, NFR-007; **Plan**: Phase 1, PostgreSQL and Prisma Persistence.
- **Verification**: migration applies twice; all design unique constraints are present; hosted PostgreSQL URL is configuration-only.
- **Test Scenarios**:
  1. Fresh Docker database applies all migrations and Prisma client can query each core entity.
  2. Reapplying migrations is a no-op.
  3. Duplicate `(dataSourceConnectionId, sourcePositionKey)` and duplicate `errorEventId` are rejected.
  4. Transaction rollback leaves no ErrorEvent, task, or outbox row.

#### T003 [x] 实现领域状态机、DTO、错误码与脱敏序列化

- **Outcome**: 实现任务状态、审批状态、修复状态、固定 high priority、标准错误响应和禁止返回 secrets/绝对路径的 DTO。
- **Paths**: `packages/contracts/src/domain.ts`, `packages/contracts/src/errors.ts`, `packages/contracts/src/dto.ts`, `apps/control-plane/src/domain/`.
- **Dependencies**: T001, T002.
- **Covers**: REQ-018, REQ-020–REQ-025, REQ-034, NFR-001–NFR-003; **Plan**: Phase 1, task state model.
- **Verification**: transition table and DTO snapshots are documented in tests.
- **Test Scenarios**:
  1. Valid pending→investigating→awaiting approval→repairing→verified path succeeds.
  2. Invalid transition and repair without approval are rejected.
  3. Investigation/repair failure preserves source evidence and enters FAILED.
  4. Serialized responses omit credential plaintext, authorization headers, and absolute workspace paths.

#### T004 [x] 实现加密、密钥版本与敏感字段防泄露

- **Outcome**: 提供 envelope encryption adapter、key version metadata、development secret injection and redaction utilities。
- **Paths**: `packages/security/src/encryption.ts`, `packages/security/src/redaction.ts`, `apps/control-plane/src/security/`.
- **Dependencies**: T001, T002.
- **Covers**: REQ-012, NFR-001; **Plan**: Phase 1, credential protection gate.
- **Verification**: ciphertext is persisted; decrypt works only server-side; logs and errors redact secrets.
- **Test Scenarios**:
  1. Encrypt/decrypt round trip returns original secret.
  2. Wrong key version fails closed.
  3. API DTO, outbox payload, ordinary log and error report contain no plaintext secret.

### Group B — GitLab and workspace

#### T005 [x] 实现 GitLab OAuth/PAT connector 与 Group/project 查询

- **Outcome**: 完成 OAuth state/PKCE callback、PAT validation、用户连接持久化、分页 Group/project 查询和 live membership role lookup。
- **Paths**: `apps/control-plane/src/integrations/gitlab/`, `apps/control-plane/src/routes/gitlab.ts`.
- **Dependencies**: T002–T004.
- **Covers**: REQ-002–REQ-006, REQ-030, REQ-035, NFR-002; **Plan**: Phase 2, Identity and GitLab Connector.
- **Verification**: connector uses authenticated server-side tokens only and returns safe summaries. `pnpm typecheck`, `pnpm build`, `pnpm test`, and Prisma schema validation pass; OAuth/PAT regression tests cover one-time state, expiration/denial, connection preservation, permission-scoped project listing, and approval roles.
- **Test Scenarios**:
  1. OAuth callback with valid state/code creates encrypted connection.
  2. Invalid/expired state, denied callback, expired PAT and insufficient scope do not replace an existing connection.
  3. Project listing excludes projects not visible to the current connection.
  4. Membership roles Developer/Maintainer/Owner pass approval eligibility; other roles fail.

#### T006 [x] 实现项目 checkout workspace、锁和 fencing token

- **Outcome**: 创建持久化项目 checkout、同步和 branch 管理；拒绝路径逃逸、脏 workspace 和失效 lock owner 写入。
- **Paths**: `apps/control-plane/src/workspace/`, `apps/workers/src/workspace/`.
- **Dependencies**: T005.
- **Covers**: REQ-006–REQ-009, REQ-024, NFR-002, NFR-005; **Plan**: Phase 2, Project Workspace Manager.
- **Verification**: checkout path is containment-checked and rejects traversal/symlinks; workspace initialization reuses one checkout only after remote identity verification; dirty sync is blocked; lease locks and fencing tokens reject concurrent or expired owners. Control-plane workspace tests pass.
- **Test Scenarios**:
  1. New project creates/reuses one persistent checkout and reports SHA/status.
  2. Symlink/path traversal and mismatched remote project are rejected.
  3. Concurrent repair attempts serialize; expired fencing token cannot write.
  4. Dirty or corrupted workspace blocks repair and reports diagnostic context.

### Group C — SLS configuration and detection

#### T007 [x] 实现通用 DataSourceAdapter 与 Alibaba SLS 配置 API

- **Outcome**: 定义 adapter contract，实现 `aliyun-sls` config validation、connection/read test routes、safe verification records and enable gate。
- **Paths**: `packages/contracts/src/data-source.ts`, `apps/control-plane/src/integrations/sls/`, `apps/control-plane/src/routes/data-sources.ts`.
- **Dependencies**: T002–T004.
- **Covers**: REQ-010–REQ-015, NFR-003–NFR-004; **Plan**: Phase 3, SLS Data Source Adapter.
- **Verification**: generic adapter contracts, normalized SLS config routes, encrypted Prisma writer, verification records, and the two-pass enablement gate are implemented and covered by TypeScript tests.
- **Test Scenarios**:
  1. Valid SLS Project/Logstore/Endpoint and credentials are stored encrypted.
  2. Invalid endpoint, unauthorized credentials, missing project/logstore and malformed config return distinct failures.
  3. Successful bounded read with zero matches is distinct from API failure.
  4. Enable is rejected until both connection and read verification succeed.

#### T008 [x] 实现 SLS 读取、错误规则与 staging smoke adapter

- **Outcome**: 实现 bounded log read/search、structured error results and default error classifier; provide staging configuration path for `cn-shanghai / pyxis-telemetry-log / pyxis-trace-staging` without committed secrets.
- **Paths**: `apps/control-plane/src/integrations/sls/client.ts`, `apps/control-plane/src/integrations/sls/classifier.ts`, `apps/control-plane/test/sls/`.
- **Dependencies**: T007.
- **Covers**: REQ-013–REQ-017, REQ-032, NFR-003; **Plan**: Phase 3, PLD-004.
- **Verification**: bounded read, distinct no-data/API failure results, default error classifier, staging project/logstore defaults, and secret-free safe summaries are covered by mock tests. Live staging smoke remains an environment-dependent follow-up and is not run without credentials.
- **Test Scenarios**:
  1. `level >= 50` classifies as error.
  2. `status >= 500` classifies as error.
  3. `msg`/`content` containing error keywords classifies as error.
  4. Normal level/status/message is not classified as error.
  5. Staging read uses the configured project/logstore and never prints credentials.

#### T009 [x] 验证 SLS Consumer Group 协议与 source position

- **Outcome**: Produce a checked-in protocol probe/decision record proving group membership, shard assignment, checkpoint/ack, rebalance, retry and stable per-record source position, or record a blocking failure.
- **Paths**: `apps/workers/src/sls-consumer/staging-probe.ts`, `apps/workers/src/sls-consumer/protocol.ts`, `docs/decisions/sls-consumer-group.md`.
- **Dependencies**: T008.
- **Covers**: REQ-016, REQ-032–REQ-033, NFR-006–NFR-007; **Plan**: Phase 4, PLD-003.
- **Verification**: Transport-stub tests and the live staging probe verify the Node.js request/signing boundary, group lifecycle, heartbeat assignment, PullLogs Protobuf decoding, stable source positions, checkpoint recovery, revoked ownership protection, and disjoint rebalance assignments against `pyxis-telemetry-log/pyxis-trace-staging`; no polling fallback is accepted.
- **Test Scenarios**:
  1. Consumer can join a group and receive shard assignment.
  2. Ack/checkpoint resumes after restart from the last committed position.
  3. Rebalance revokes and reassigns shards without concurrent writes.
  4. Duplicate delivery yields the same stable source position key.
  5. Missing stable position or unsupported protocol fails the gate explicitly.

#### T010 [x] 实现 SLS consumer worker 与检测事务

- **Outcome**: Implement enabled-connection consumer, health/lag state, reconnect/recovery, classifier dispatch and transactional ErrorEvent/task/outbox creation; commit checkpoint only after persistence succeeds.
- **Paths**: `apps/workers/src/sls-consumer/`, `apps/workers/src/detection/`, `apps/control-plane/src/detection/`.
- **Dependencies**: T002–T004, T008, T009.
- **Covers**: REQ-016–REQ-018, REQ-032–REQ-034, NFR-006–NFR-007; **Plan**: Phase 4, SLS Consumer Service and Detection Pipeline.
- **Verification**: Worker unit tests cover checkpoint ordering, source recovery and transient PullLogs retry. PostgreSQL integration tests cover per-position idempotency, independent same-fingerprint cards, non-error filtering, outbox creation, and transaction rollback. `SLSConsumerState` exposes assignments, heartbeat, lagging flag, and last checkpoint. Live staging card creation remains a T016 end-to-end check once a project connection is enabled.
- **Test Scenarios**:
  1. Enabled verified source consumes an error and creates exactly one event/task/outbox row.
  2. Non-error log advances checkpoint without creating a task.
  3. Database failure prevents checkpoint ack and allows replay.
  4. Duplicate source position is idempotent; distinct positions with same fingerprint create separate tasks.
  5. Disconnect/rebalance recovers without dropping uncommitted records.

### Group D — Investigation and repair

#### T011 实现 outbox/investigation worker 与 HolmesGPT adapter

- **Outcome**: Claim outbox messages with leases, call authenticated HolmesGPT `/api/chat` with bounded SLS/code evidence, and persist structured investigation results or failures.
- **Paths**: `apps/workers/src/outbox/`, `apps/workers/src/investigation/`, `apps/control-plane/src/integrations/holmes/`.
- **Dependencies**: T003, T006, T010.
- **Covers**: REQ-018–REQ-021, NFR-002–NFR-003; **Plan**: Phase 5, Investigation Adapter and HolmesGPT Engine.
- **Verification**: worker retry and final failure are observable; HolmesGPT never receives GitLab write credentials.
- **Test Scenarios**:
  1. Successful HolmesGPT response moves task to AWAITING_APPROVAL with cause/code/fix evidence.
  2. Timeout, HTTP failure and incomplete response preserve raw error evidence and move task to FAILED.
  3. Worker restart reclaims expired lease without duplicate investigation result.
  4. Evidence is bounded and contains no credentials or unrestricted repository dump.

#### T012 实现审批 API 与 Repair Worker

- **Outcome**: Enforce live Group role and one-person approval; run approved repair under workspace fencing lock with restricted command execution and auditable RepairRun.
- **Paths**: `apps/control-plane/src/routes/approvals.ts`, `apps/workers/src/repair/`, `packages/security/src/execution.ts`.
- **Dependencies**: T005, T006, T011.
- **Covers**: REQ-021–REQ-025, REQ-035, NFR-001–NFR-002, NFR-005; **Plan**: Phase 6, Approval and Repair Worker.
- **Verification**: no code/test/MR side effect occurs without valid approval and lock.
- **Test Scenarios**:
  1. Eligible live Group role approves once and starts a RepairRun.
  2. Non-member/Reporter/Guest, rejected approval, revoked approval or unavailable GitLab role check cannot start repair.
  3. Concurrent repair is blocked by workspace lock/fencing.
  4. Repository command output is bounded and secrets are absent.

#### T013 实现双重验证与幂等 MR 创建

- **Outcome**: Run project automation tests and SLS original-error recheck; permit MR creation only after both pass; use RepairRun idempotency and persist MR relation.
- **Paths**: `apps/workers/src/repair/verification.ts`, `apps/control-plane/src/routes/merge-requests.ts`, `apps/control-plane/src/integrations/gitlab/merge-request.ts`.
- **Dependencies**: T012, T008.
- **Covers**: REQ-025–REQ-026, REQ-036, NFR-002, NFR-005; **Plan**: Phase 6, dual verification gate.
- **Verification**: failed verification blocks MR; network retry cannot create duplicates.
- **Test Scenarios**:
  1. Project tests and SLS recheck both pass, producing one MR and VERIFIED task.
  2. Project tests fail, SLS recheck fails, or either still finds the original error; no MR is created.
  3. MR API timeout followed by retry discovers existing MR instead of opening another.
  4. MR creation failure preserves repair and verification audit records with explicit not-created state.

### Group E — Web UI and release verification

#### T014 实现项目、workspace、SLS 配置与 consumer 状态页面

- **Outcome**: Build Web UI for GitLab connection, project selection, workspace status, SLS config/test/read/enable and consumer health; no YAML editing is required.
- **Paths**: `apps/web/src/features/projects/`, `apps/web/src/features/data-sources/`, `apps/web/src/features/workspaces/`.
- **Dependencies**: T005–T010, API contracts from T007.
- **Covers**: REQ-001, REQ-006–REQ-016, REQ-027–REQ-029, REQ-032; **Plan**: Phase 7, TypeScript Web Client.
- **Verification**: browser flow handles success, failure, empty read and disabled source states.
- **Test Scenarios**:
  1. User connects GitLab, sees only permitted Groups/projects and selects one.
  2. User sees workspace initializing/ready/failed/occupied states.
  3. SLS connection/read tests show distinct pass, fail and no-data states.
  4. Enable action is unavailable until both tests pass.

#### T015 实现任务、调查、审批、修复与 MR 页面

- **Outcome**: Build task list/detail pages with evidence, investigation result, code references, approval action, repair progress, verification results and MR link.
- **Paths**: `apps/web/src/features/tasks/`, `apps/web/src/features/approvals/`, `apps/web/src/features/repairs/`.
- **Dependencies**: T011–T013, T014.
- **Covers**: REQ-018–REQ-026, REQ-034–REQ-036; **Plan**: Phase 7, TypeScript Web Client and task APIs.
- **Verification**: UI reflects server state machine and never presents unapproved repair as actionable.
- **Test Scenarios**:
  1. Error evidence, HolmesGPT conclusion, code context and repair plan are visible together.
  2. Unapproved/rejected task shows no executable repair/MR action.
  3. Eligible approver can submit one approval and see audit result.
  4. Failed test/recheck displays failure reason and no verified MR.
  5. Successful dual verification displays exactly one MR link and audit references.

#### T016 运行全链路质量、staging smoke 与发布检查

- **Outcome**: Execute TypeScript lint/typecheck/build/unit/integration, Prisma migration checks, relevant Python non-LLM tests, browser smoke, staging SLS read and security redaction checks; record artifacts.
- **Paths**: `.github/workflows/`, `apps/*/test/`, `packages/*/test/`, `docs/verification/web-workflow.md`.
- **Dependencies**: T001–T015.
- **Covers**: REQ-001–REQ-036, NFR-001–NFR-007; **Plan**: Phase 7, Verification Strategy and delivery gates.
- **Verification**: all required checks pass; unavailable staging credentials are reported as skipped only for the live test, while mock/contract checks remain mandatory.
- **Test Scenarios**:
  1. Full happy path from project selection to verified MR passes.
  2. Invalid GitLab/SLS credentials and inaccessible project are rejected without state corruption.
  3. Consumer disconnect/replay preserves one-task-per-source-position behavior.
  4. Unapproved repair, failed project tests and failed SLS recheck produce no MR.
  5. Secret scan finds no credentials in UI, logs, telemetry, outbox or commits.

## Dependency Order

`T001 → T002/T003/T004 → T005 → T006 → T007/T008 → T009 → T010 → T011 → T012 → T013 → T014 → T015 → T016`.

T002, T003 and T004 may run in parallel after T001. T007 and T008 are sequential because the adapter contract precedes its SLS implementation. T009 blocks T010; no polling fallback is allowed.

## Coverage Matrix

| Plan component | Tasks | Requirements |
|---|---|---|
| TypeScript foundation | T001 | REQ-027–REQ-028 |
| PostgreSQL/Prisma and domain | T002–T004 | REQ-006–REQ-012, REQ-018, REQ-022–REQ-026, REQ-030–REQ-036, NFR-001–NFR-002, NFR-005, NFR-007 |
| GitLab/workspace | T005–T006 | REQ-002–REQ-009, REQ-024, REQ-026, REQ-030, REQ-035, NFR-002, NFR-005 |
| SLS adapter/configuration | T007–T008 | REQ-010–REQ-017, REQ-032, NFR-003–NFR-004 |
| Consumer/detection | T009–T010 | REQ-016–REQ-018, REQ-032–REQ-034, NFR-006–NFR-007 |
| Investigation | T011 | REQ-018–REQ-021, NFR-002–NFR-003 |
| Approval/repair/MR | T012–T013 | REQ-021–REQ-026, REQ-035–REQ-036, NFR-001–NFR-002, NFR-005 |
| Web UI/release | T014–T016 | REQ-001, REQ-008, REQ-011, REQ-013–REQ-016, REQ-018, REQ-021–REQ-029, REQ-032–REQ-036, NFR-001–NFR-007 |

All testable tasks include individually traceable Test Scenarios. No task is outside the approved plan; T009 is the explicit implementation gate required by PLD-003.
