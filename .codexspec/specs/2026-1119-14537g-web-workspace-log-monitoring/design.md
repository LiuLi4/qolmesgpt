# 技术设计：Web 项目工作区与日志故障闭环

**Related Spec**: `.codexspec/specs/2026-1119-14537g-web-workspace-log-monitoring/spec.md`
**Confirmed Requirements**: `.codexspec/specs/2026-1119-14537g-web-workspace-log-monitoring/requirements.md`
**Created**: 2026-11-20
**Status**: Draft

## Context

本设计承接已确认的产品规格：用户通过 Web UI 连接 GitLab、选择项目、配置 SLS、接收实时日志、创建逐条错误调查任务，并在合格 Group 成员审批后执行修复、双重验证和创建 MR。

当前仓库是 Python HolmesGPT 服务，具备 FastAPI `/api/chat` 调查入口和进程级配置的只读阿里云 SLS toolset。仓库没有产品级 TypeScript 后端或正式 Web UI；`experimental/ag-ui` 是演示项目，README 明确声明不适用于生产。因此新产品由 TypeScript 控制面承载，Python HolmesGPT 保持为内部调查执行引擎。SLS 和 GitLab 的用户/项目级配置归 TypeScript 控制面管理，不写入 HolmesGPT 全局 YAML。

设计沿用 PostgreSQL + Prisma、GitLab Group 权限边界、SLS 实时消费、请求聚合与错误指纹归并、基础任务状态、单人审批和项目测试加 SLS 复查的已确认决策。具体 Web 框架、SLS Node SDK 及消费组部署形态尚无仓库既有约定，本设计定义边界接口，不把未验证的包或部署产品固化为要求。

## Architecture & Components

### TypeScript Web Client

- **Responsibility**: 提供 GitLab 连接、项目选择、workspace 状态、SLS 配置/验证、检测任务列表、调查详情、审批和修复结果界面。所有数据通过受认证的产品 API 读写。
- **Interface**: Web session 请求 TypeScript Control API；不得持有 SLS AccessKey、GitLab PAT 或 OAuth refresh token 明文。
- **Covers**: REQ-001, REQ-002, REQ-003, REQ-005, REQ-008, REQ-011, REQ-013, REQ-018, REQ-021, REQ-022, REQ-023, REQ-027, REQ-029

### TypeScript Control API

- **Responsibility**: 作为产品边界，验证当前用户身份和资源权限；管理用户级 GitLab connection、GitLab Group/项目、workspace、SLS connection、验证记录、调查任务、审批、修复和 MR 记录。所有状态迁移和写操作在此授权。
- **Interface**: REST/JSON API；通过 Prisma 访问 PostgreSQL；调用 GitLab API、SLS Adapter、Workspace Manager、Investigation Adapter 和 Repair Worker。OAuth secret 与 SLS secret 经 KMS/密钥服务加密后存储，解密只发生在服务端短时使用路径。
- **Covers**: REQ-002 至 REQ-015, REQ-018, REQ-021 至 REQ-026, REQ-030, REQ-031, REQ-035, REQ-036, NFR-001 至 NFR-005

### Identity and GitLab Connector

- **Responsibility**: 完成 GitLab OAuth 2.0 回调和 PAT 验证；以 OAuth/PAT 对应的用户权限查询可见 Group 和项目；在项目所属 Group 上读取实时成员角色。Group 是项目授权和审批的权限边界，QolmesGPT 不另建组织租户层。
- **Interface**: 向 Control API 提供 `connectOAuth`, `validatePAT`, `listGroups`, `listProjects`, `getProjectMembership`, `createBranch`, `pushCommit` 和 `createMergeRequest` 等受控操作。审批和开始修复之前重新向 GitLab 检查 approver 当前角色，避免使用过期的本地角色快照。
- **Covers**: REQ-002 至 REQ-006, REQ-026, REQ-030, REQ-035, NFR-002

### SLS Data Source Adapter

- **Responsibility**: 统一管理 SLS 连接配置测试、真实日志读取测试、实时消费和调查时的受限日志检索。第一期只实现 SLS，接口不暴露 SLS 特有凭据给通用任务领域。
- **Interface**: `testConnection(connection)`, `testRead(connection)`, `startConsumer(connection, group, checkpoint)`, `searchLogs(connection, query, range, limit)`。返回结构化日志、源位置和明确的错误/无数据区分。对每条消费记录生成稳定的来源位置键，至少包含 data source、shard、消费位置及组内序号。
- **Covers**: REQ-010 至 REQ-017, REQ-032, NFR-003, NFR-004, NFR-006

### SLS Consumer Service

- **Responsibility**: 在独立 worker 进程中为每个已验证且启用的 SLS connection 建立实时消费；管理消费组成员、分区分配、checkpoint、重连、积压恢复和消费幂等。API 服务不承载长期消费循环。
- **Interface**: 获取待运行的 data source connection；通过 SLS Consumer Group 协议读取日志；将记录和消费位置交给 Detection Pipeline；提交 checkpoint 只在日志事件和任务事务持久化成功后发生。Consumer Group 是日志进度的权威来源；数据库保存消费实例、assignment、最近 checkpoint、健康状态和恢复诊断，不维护一份互相冲突的第二权威游标。
- **Covers**: REQ-016, REQ-018, REQ-032 至 REQ-034, NFR-003, NFR-006, NFR-007

### Detection Pipeline and Task Service

- **Responsibility**: 使用已确认的 SLS 默认错误规则分类日志；将每条匹配日志作为独立 ErrorEvent 写入 PostgreSQL，并关联按请求或指纹归并的 InvestigationTask；更新任务基础状态并提交调查队列。相同日志因重试再次投递时，通过来源位置唯一键实现幂等；不同请求按规范化 fingerprint 在 15 分钟跨度内归并，审批后的任务隔离。
- **Interface**: 接收 `(DataSourceConnection, SourcePosition, LogRecord)`；事务写入 ErrorEvent 和 InvestigationTask 后返回持久化确认。没有匹配错误规则的记录不创建调查任务，但仍允许 consumer 正常确认其位置。
- **Covers**: REQ-017, REQ-018, REQ-033, REQ-034, NFR-003, NFR-007

### Investigation Adapter and HolmesGPT Engine

- **Responsibility**: 调查 worker 将 ErrorEvent 证据、项目/分支信息和经裁剪的代码上下文交给 HolmesGPT Python `/api/chat`，并将结果写回 InvestigationTask。初始证据由 TypeScript 侧的 SLS Adapter 和 GitLab Connector 根据任务所属 project 拉取，避免把项目凭据写入 HolmesGPT 全局配置。调查调用仅提供只读上下文和只读工具能力。
- **Interface**: 接收 `InvestigationTaskId`；查询对应日志和 project checkout/ref；向 HolmesGPT 内部 API 发送调查问题、可验证日志证据和相关代码片段；保存原因、引用证据、关联代码位置、修复建议和调查状态。若需要扩展到 Holmes 内部按请求注入项目级工具权限，需在后续独立设计中定义，不假设当前 `/api/chat` 已支持动态项目工具集。
- **Covers**: REQ-019 至 REQ-021, REQ-032, NFR-002, NFR-003

### Project Workspace Manager

- **Responsibility**: 为每个选定 GitLab 项目分配唯一、持久化的 checkout 目录，维护初始化、同步、占用和失败状态；为修复任务获取项目级互斥锁；构造安全分支并同步 GitLab。
- **Interface**: 接收稳定的内部 Project ID，不接受用户直接提供文件系统路径；checkout 路径由服务端根目录和内部 ID 派生。提供 `ensureWorkspace`, `sync`, `acquireRepairLock`, `releaseRepairLock`, `createRepairBranch`、`applyPatch` 和 `pushBranch` 操作。所有路径必须校验 containment，所有 Git 操作绑定 GitLab Project。
- **Covers**: REQ-006 至 REQ-009, REQ-024, REQ-026, CON-003, NFR-002, NFR-005

### Approval and Repair Worker

- **Responsibility**: Approval Service 校验单个 approver 属于项目 Group 且当前角色是 Developer、Maintainer 或 Owner，记录不可变审批事件。Repair Worker 仅消费已审批任务，在持有 project workspace 锁时修改代码、运行项目自动化测试、执行 SLS 原错误复查；两项验证成功后才允许创建 MR。
- **Interface**: 状态机校验 `待审批 -> 修复中` 只能由有效 Approval 触发；修复 worker 在每次副作用前验证审批仍有效、task 状态符合预期并获得互斥锁。执行输出和验证结果以 RepairRun 记录；MR 创建作为单独的幂等步骤，成功后记录外部 MR ID/URL。
- **Covers**: REQ-022 至 REQ-026, REQ-035, REQ-036, CON-005, NFR-001, NFR-002, NFR-005

### PostgreSQL and Prisma Persistence

- **Responsibility**: 保存用户和 Group/project 关系、加密 connection、workspace、SLS 验证/消费状态、错误事件、调查任务、审批、修复运行和 MR 记录；通过 Prisma 管理关系模型与 schema migrations。
- **Interface**: TypeScript 服务通过 Prisma Client 执行事务和带唯一约束的幂等 upsert。开发使用 Docker PostgreSQL，生产连接托管 PostgreSQL。外部队列先使用 PostgreSQL transactional outbox 与 worker claim/poll，避免数据库提交与独立队列发布之间丢失事件。
- **Covers**: REQ-018, REQ-024 至 REQ-026, REQ-031 至 REQ-036, NFR-002, NFR-005 至 NFR-007

## Key Design Decisions

### Decision 1: TypeScript control plane, Python investigation engine

- **Context**: 产品前后端必须使用 TypeScript，而仓库中的 HolmesGPT 调查引擎和 SLS 查询 toolset 都是 Python；仓库没有正式 TypeScript 后端。
- **Decision**: 新增独立 TypeScript 控制面和 worker，通过内部 API 调用现有 Python HolmesGPT。项目配置、用户权限、SLS 凭据、任务和修复状态由 TypeScript 控制面管理。
- **Alternatives**: 将 HolmesGPT 主服务重写为 TypeScript；将产品后端继续实现为 Python。
- **Trade-offs**: 保留 HolmesGPT 成熟的 Python investigation loop，但引入跨进程 API 契约和两种运行时；必须为内部 API 做服务身份认证及版本兼容。
- **Covers**: REQ-019, REQ-027, REQ-028

### Decision 2: One transactional control database with an outbox

- **Context**: SLS consumer 需要保存事件后推进 checkpoint；调查和修复是异步流程；用户要求先设计数据库。
- **Decision**: PostgreSQL 是所有业务状态的权威存储。将日志事件、独立调查任务和 outbox 消息在同一事务内提交，再由 worker claim outbox 并执行调查。任务和事件对来源位置建立唯一约束以支持至少一次投递。
- **Alternatives**: 先发布到外部消息队列再写数据库；仅使用进程内任务队列。
- **Trade-offs**: PostgreSQL 承担异步任务队列的一部分负载，吞吐规模有限；换来原子性、可恢复性和较少的第一期基础设施。若吞吐或消费积压超过数据库 worker 能力，可把 outbox relay 接到独立消息服务而保留 outbox 事务边界。
- **Covers**: REQ-018, REQ-032 至 REQ-034, NFR-005 至 NFR-007

### Decision 3: SLS Consumer Group owns log progress

- **Context**: 第一阶段明确要求 SLS 实时消费和秒级发现；重启、重平衡和重复投递不能丢失错误日志。
- **Decision**: 使用 SLS Consumer Group 语义管理分区 assignment 与服务端 checkpoint。当前已核实的阿里云官方 `aliyun/aliyun-log-nodejs-sdk`（MIT）公开客户端提供日志查询、索引和写入 API，但没有 Consumer Group、分区分配或 checkpoint 接口；因此实现必须在任务阶段验证官方 Consumer Group 协议并选择可维护的 TypeScript 实现路径（官方协议签名封装或经审查的兼容库），不能假定该 SDK 已提供消费组能力。数据库记录 consumer 健康状态、assignment 和可诊断的 checkpoint 摘要，不另建会与 SLS 进度冲突的游标权威。
- **Alternatives**: 周期性查询日志窗口；仅在 PostgreSQL 维护自有 offset；为每个 logstore 创建独立应用轮询器。
- **Trade-offs**: Consumer Group 需正确实现 group membership、checkpoint 和重平衡协议，SDK 的 Node 支持及版本必须在实现计划前验证；不能用“每秒定时轮询”替代实时消费承诺。
- **Covers**: REQ-016, REQ-032, NFR-006

### Decision 4: Event identity differs from error fingerprint

- **Context**: 最新需求要求请求聚合与错误去重，同时消费可能重投同一记录。
- **Decision**: sourcePositionKey 标识原始日志，trace/request 标识请求，规范化 fingerprint 标识重复错误。ErrorEvent.taskId 建立多对一证据关系；anchor errorEventId 保持向后兼容。Workspace advisory lock 串行归并，行锁隔离审批/调查提交，evidenceVersion 防止旧快照进入审批。
- **Trade-offs**: 时间窗口和关键词代码定位均为有界启发式；不确定性必须出现在调查结果中。源码正文不发送给模型。
- **Covers**: REQ-033, NFR-007

### Decision 5: Authorization follows the live GitLab Group boundary

- **Context**: GitLab Group 是第一期项目和成员权限边界；审批要求角色级校验。
- **Decision**: GitLabConnection 绑定产品用户；Project 关联其 Group；项目读写范围先受连接用户对项目的 GitLab 权限约束。每次审批和开始修复前对 GitLab 查询当前 Group membership role；缓存只用于界面提示，不能单独授权副作用。
- **Alternatives**: 维护 QolmesGPT 独立组织/成员授权；只信任项目创建时的 Group role 快照。
- **Trade-offs**: 依赖 GitLab API 可用性并增加审批时延；避免角色变更后仍允许旧成员审批或写入。用户登录身份认证由独立 `AuthenticatedPrincipal` 接口提供，本设计不选定登录身份提供商。
- **Covers**: REQ-004 至 REQ-006, REQ-030, REQ-035, NFR-002

### Decision 6: Project secrets stay in the TypeScript control plane

- **Context**: SLS 凭据和 GitLab token 属于用户/项目级；现有 Holmes SLS toolset 从全局 YAML/环境加载，不适合为多项目用户动态隔离凭据。
- **Decision**: 加密凭据仅由 TypeScript backend 解密。SLS Adapter 使用连接级凭据执行验证、消费和检索；Holmes 调查通过 Control Plane 提供的、已授权且有界的日志/代码证据调用 `/api/chat`。不向 Holmes 全局 config 写项目密钥，也不向浏览器返回明文。
- **Alternatives**: 为每个项目动态生成 Holmes YAML；把 AccessKey 放入浏览器；把所有 SLS 凭据集中配置在单一进程。
- **Trade-offs**: Control Plane 承担 SLS 查询和证据打包职责；Holmes engine 暂时不能自行用项目凭据追加 SLS 查询。后续若需让 Holmes 自主扩展检索，需设计带 task-scoped identity 的内部 tool/MCP 契约。
- **Covers**: REQ-011 至 REQ-015, REQ-019 至 REQ-021, CON-002, NFR-001, NFR-004

### Decision 7: Repair is a separate capability from investigation

- **Context**: 自动调查是只读行为；代码修改、测试执行和 MR 创建必须先经过人工审批。
- **Decision**: Investigation Adapter 只提供日志和代码读取证据。Approval Service 通过角色校验后发出一次性 Repair Authorization；Repair Worker 在执行每项仓库副作用前校验授权、任务状态和 workspace 锁。Holmes 调查请求不会继承 GitLab 写 token 或代码修改工具。
- **Alternatives**: 同一 Holmes tool call 同时读取和写入 GitLab；仅依赖前端隐藏修复按钮。
- **Trade-offs**: 多一道服务端状态门禁和授权传递，修复编排更复杂；能防止 API 直调、重试或模型工具调用绕开审批。
- **Covers**: REQ-021 至 REQ-026, REQ-035, REQ-036, CON-005

## Data Models / Key Entities

所有 ID 使用内部 UUID；GitLab 的外部 ID 和路径作为普通字段保存。敏感凭据只保存密文、密钥版本和授权元数据。日期统一保存 UTC timestamptz；前端转换用户时区。

| Entity | Key fields / relationships | Constraints | Covers |
|--------|-----------------------------|-------------|--------|
| `User` | `id`, `authSubject`, `createdAt` | `authSubject` unique；身份提供商由认证适配器决定 | REQ-002, REQ-004, REQ-035 |
| `GitLabConnection` | `userId`, `instanceUrl`, `authType`, `accessTokenCiphertext`, `refreshTokenCiphertext`, `expiresAt`, `status` | 用户/实例/连接组合唯一；PAT 与 OAuth 使用同一连接抽象；密文不可进入序列化响应 | REQ-002 至 REQ-004, REQ-012, NFR-001 |
| `GitLabGroup` | `connectionId`, `externalGroupId`, `fullPath` | `(connectionId, externalGroupId)` unique；存储最近同步时间和非授权用途的 role 快照 | REQ-004 至 REQ-006, REQ-030 |
| `Project` | `groupId`, `externalProjectId`, `pathWithNamespace`, `defaultBranch`, `createdByUserId` | `(connectionId, externalProjectId)` unique；组和项目归属需由 GitLab 校验 | REQ-005 至 REQ-007, REQ-030 |
| `ProjectWorkspace` | `projectId`, `relativePath`, `headSha`, `branch`, `status`, `lockOwner`, `lockExpiresAt` | 每项目唯一；路径由服务端生成；锁使用租约并带 fencing token | REQ-007 至 REQ-009, REQ-024, NFR-005 |
| `DataSourceConnection` | `projectId`, `type`, `configJson`, `credentialsCiphertext`, `status`, `enabledAt` | type 首期为 `aliyun-sls`；配置版本化；敏感字段分栏或 envelope 加密 | REQ-010 至 REQ-012, REQ-014, NFR-001, NFR-004 |
| `DataSourceVerification` | `connectionId`, `kind`, `status`, `testedAt`, `safeSummary`, `errorCode` | kind 分为连接和读取；错误摘要经过脱敏；检测启用读取最近成功结果 | REQ-013 至 REQ-015 |
| `SLSConsumerState` | `connectionId`, `consumerGroup`, `workerId`, `shardAssignments`, `checkpointSummary`, `status`, `lastHeartbeatAt` | 每连接/消费组唯一；SLS 服务端 checkpoint 为进度权威；数据库状态用于调度、观测和恢复 | REQ-016, REQ-032, NFR-006 |
| `ErrorEvent` | `dataSourceConnectionId`, `sourcePositionKey`, `sourceTimestamp`, `logEvidenceJson`, `fingerprint` | `(dataSourceConnectionId, sourcePositionKey)` unique；证据脱敏；fingerprint 非唯一 | REQ-017, REQ-018, REQ-033, NFR-007 |
| `InvestigationTask` | `projectId`, `workspaceId`, `errorEventId`, `status`, `priority`, `investigationResultJson`, `firstSeenAt`, `lastSeenAt`, `occurrenceCount`, `requestCount`, `evidenceVersion`, `analyzedVersion` | errorEventId unique；状态受服务端转换表约束；priority 首期固定 high | REQ-018 至 REQ-021, REQ-033, REQ-034 |
| `Approval` | `taskId`, `approverUserId`, `groupRoleAtApproval`, `decision`, `approvedAt`, `authorizationVersion` | 通过决策每任务最多一个有效记录；保存 GitLab 实时 role 检查时间和授权审计信息 | REQ-022, REQ-023, REQ-035, NFR-002 |
| `RepairRun` | `taskId`, `workspaceId`, `branch`, `status`, `testResult`, `slsRecheckResult`, `startedAt`, `finishedAt` | 每次执行单独记录；只能引用有效 Approval；workspace 锁 fencing token 需匹配 | REQ-024, REQ-025, REQ-036, NFR-002, NFR-005 |
| `MergeRequest` | `repairRunId`, `externalMrId`, `url`, `status` | repairRunId unique；创建请求需用 idempotency key 防止重试重复开 MR | REQ-026, REQ-036 |
| `OutboxMessage` | `aggregateType`, `aggregateId`, `eventType`, `payload`, `availableAt`, `claimedAt`, `attempts` | 事务内创建；worker 使用租约 claim；payload 不含凭据明文 | REQ-018, REQ-019, REQ-024, NFR-005 |

### 任务状态

领域状态固定为 `INVESTIGATION_PENDING`、`INVESTIGATING`、`AWAITING_APPROVAL`、`REPAIRING`、`VERIFIED`、`FAILED`、`CLOSED`，UI 展示中文标签。允许的自动转换由服务端状态机控制：`INVESTIGATION_PENDING -> INVESTIGATING -> AWAITING_APPROVAL -> REPAIRING -> VERIFIED`；调查/修复任一失败可转 `FAILED`；用户可从非运行状态关闭任务。拒绝审批如何转状态在已确认基础状态表中没有单独状态，因此拒绝记录留在 Approval，任务仍为 `AWAITING_APPROVAL`，直到再次审批或关闭。

- **Covers**: REQ-018, REQ-020 至 REQ-025, REQ-034, NFR-002

## API / Interface Contracts

产品 API 使用 JSON/HTTPS。所有 project/task/source 操作都要求产品 session 身份，并在 API 层检查当前用户的 GitLab connection、Group 和 project 作用域。API 响应只给 `hasCredential`、凭据类型和安全摘要，不返回密钥。

| Method and path | Contract | Covers |
|---|---|---|
| `POST /api/gitlab/oauth/start` | 创建一次性 OAuth `state`/PKCE 事务并返回 GitLab 授权 URL | REQ-002 |
| `GET /api/gitlab/oauth/callback` | 校验 state、交换 code、保存加密 token；无效/拒绝时不覆盖既有连接 | REQ-002, REQ-004, CON-002 |
| `POST /api/gitlab/connections/pat` | 请求包含 instance URL、PAT；服务端验证当前用户和可见 Group；成功只返回连接摘要 | REQ-003, REQ-004 |
| `GET /api/gitlab/groups` | 返回该用户连接可见的 Group 与最近同步状态 | REQ-004, REQ-030 |
| `GET /api/gitlab/projects?groupId=...&cursor=...` | 按 GitLab 权限分页返回项目，不支持任意 external project 越权读取 | REQ-005, REQ-006 |
| `POST /api/projects` | 以可见的 GitLab project ID 创建产品 Project 并启动 workspace 初始化 | REQ-006 至 REQ-008 |
| `GET /api/projects/{id}/workspace` | 返回初始化/同步/占用/失败状态、当前分支与 SHA，不返回绝对主机路径 | REQ-008, NFR-002 |
| `POST /api/projects/{id}/data-sources` | 创建类型为 `aliyun-sls` 的项目级 connection；请求中包含 endpoint/project/logstore/credentials | REQ-010 至 REQ-012 |
| `POST /api/data-sources/{id}/test-connection` | 测试 endpoint、凭据和 Project/Logstore 授权；记录安全摘要 | REQ-013, REQ-015 |
| `POST /api/data-sources/{id}/test-read` | 执行有界真实日志读取，成功空结果与 API/权限失败分开记录 | REQ-013, REQ-015 |
| `POST /api/data-sources/{id}/enable` | 仅当连接和读取均有有效成功验证记录时启用 consumer | REQ-014, REQ-016 |
| `GET /api/projects/{id}/tasks?status=...` | 返回项目范围内的任务摘要、固定优先级、来源时间和状态 | REQ-018, REQ-034 |
| `GET /api/tasks/{id}` | 返回脱敏日志证据、调查结论、代码引用、修复建议、审批和修复状态 | REQ-018 至 REQ-021 |
| `POST /api/tasks/{id}/approval` | 请求为 approve/reject；服务端实时校验 Group membership 为 Developer/Maintainer/Owner，并拒绝本人连接无权审批的请求 | REQ-022, REQ-023, REQ-035 |
| `POST /api/tasks/{id}/repair` | 请求只启动已审批任务的幂等 RepairRun；不能由 UI 传入 shell command 或 workspace path | REQ-024, REQ-025 |
| `POST /api/repair-runs/{id}/create-mr` | 仅接受双验证成功的 RepairRun；幂等创建并返回 MR ID/URL | REQ-026, REQ-036 |

标准错误响应包含 `code`, `message`, `requestId`；不会包含 token、主机绝对 workspace 路径、原始授权头或未脱敏日志字段。权限失败用 403，资源不可见/不存在用不泄漏信息的 404，验证失败返回可显示的 `verificationStatus=failed`。

### SLS Adapter Interface

```text
DataSourceAdapter
  validate(configRef) -> ConnectionTestResult
  readSample(configRef, boundedRange, limit) -> ReadTestResult
  consume(configRef, consumerGroup, callbacks) -> ConsumerHandle
  search(configRef, query, range, limit) -> LogSearchResult

Consumer callbacks
  onAssigned(shards)
  onRecords(shard, records, sourcePositions)
  onRevoked(shards)
  onError(classifiedError, retryability)
```

- Consumer 必须在 `onRecords` 对应 ErrorEvent/Task 事务提交成功后再 commit/ack checkpoint；未分类记录可以在完成幂等记录或明确丢弃策略后提交。
- `sourcePositionKey` 必须基于实际 SDK 能提供的稳定位置构造；若 SDK 无法提供能区分同一 shard 内多条日志的位置，不能宣称重投递幂等，应在计划阶段解决或升级 SDK。
- `search` 必须应用时间范围和结果上限；超时/API 错误与成功但无匹配数据使用不同 result status。
- **Covers**: REQ-013 至 REQ-018, REQ-032, REQ-033, NFR-003, NFR-006, NFR-007

## Sequence & Data Flow

### 配置和启用 SLS

1. 用户选定 GitLab project；GitLab Connector 验证可见性，Project Service 写入 project 并创建 ProjectWorkspace 初始化任务。
2. 用户提交 SLS connection；API 校验格式并加密凭据保存，创建连接测试记录。
3. SLS Adapter 先调用 SLS 元数据/日志接口验证 endpoint 和权限，再进行有界真实读取；每一步结果分别持久化。
4. 用户启用连接时，服务端检查两类最近有效验证成功，事务设置 enabled 并写入 outbox `DataSourceEnabled`。
5. Consumer Worker 获取启用事件，加入 Consumer Group，持久化 health/assignment 状态并开始实时读取。

**Covers**: REQ-006 至 REQ-016, REQ-030 至 REQ-032

### 错误日志到调查任务

1. Consumer 收到一个带 shard/source position 的日志记录；adapter 规范化字段，保留原始证据的受限副本并脱敏敏感键。
2. Detection Pipeline 使用适配器默认规则分类。非错误记录不创建 task；错误记录进入事务。
3. 同一事务以 `(dataSourceConnectionId, sourcePositionKey)` 创建 ErrorEvent、一个独立 InvestigationTask 和一条 outbox 记录。unique 冲突表示重复投递，返回既有结果，不重复建卡。
4. 事务成功后 consumer 提交该位置 checkpoint。worker claim outbox 后将任务从 `INVESTIGATION_PENDING` 转为 `INVESTIGATING`。
5. Investigation Adapter 从 GitLab checkout/ref 取有限相关代码证据，并附上日志、trace/request IDs、服务/组件/时间范围，调用 HolmesGPT 内部 `/api/chat`。
6. 结构化结果和引用写入 task；成功转到 `AWAITING_APPROVAL`，失败转到 `FAILED` 并保留源证据。

**Covers**: REQ-016 至 REQ-020, REQ-032 至 REQ-034, NFR-006, NFR-007

### 审批到 MR

1. 有权用户打开任务，API 返回调查证据和修复建议；界面展示当前项目和 Group。
2. 用户请求审批；服务端从 GitLab 实时检查 membership role。仅 Developer、Maintainer、Owner 单人可通过；保存 Approval 审计事件。
3. Repair Worker claim 已审批任务，重新验证当前角色/审批、申请带 fencing token 的 workspace 锁，并创建 repair branch。
4. Worker 调用受限修复能力修改 checkout；不向调查步骤开放写权限。执行项目自动化测试并保存 stdout/stderr 的脱敏摘要。
5. SLS Adapter 对原错误做有界复查。项目测试和 SLS 复查都成功时设置 RepairRun 双验证成功；任一失败则 task/RepairRun 进入 `FAILED`，不创建 MR。
6. MR 创建 worker 使用 GitLab API 幂等创建 MR，并将外部 ID、URL、branch、验证记录写回；成功后 task 转 `VERIFIED`。用户关闭任务时转 `CLOSED`。

**Covers**: REQ-021 至 REQ-026, REQ-034 至 REQ-036, CON-005, NFR-002, NFR-005

## Cross-Cutting Design

### Security and authorization

- GitLab OAuth state/PKCE 和 callback 必须一次性并有过期时间；PAT 在保存前验证 scope/身份，token 仅以 envelope encryption 密文存储。
- SLS AccessKey/STS token 使用与 GitLab token 相同的服务端密钥管理抽象，但不同 purpose/key version；数据库、备份和日志中均不得出现明文。
- Group role 快照只供 UI 展示；审批和 RepairRun 启动要求实时 GitLab 授权校验。GitLab 不可用时 fail closed，不允许以缓存角色批准或继续新的远程写入。
- HolmesGPT 内部接口使用服务到服务认证和网络隔离；调查调用不接收 GitLab 写权限；仓库修改仅由 Repair Worker 完成。
- Workspace path 由内部 ID 派生、规范化并校验在根目录内；拒绝符号链接逃逸。每项目互斥锁和 fencing token 防止过期 worker 写入。
- **Covers**: REQ-002 至 REQ-006, REQ-012, REQ-019, REQ-022 至 REQ-026, REQ-030, REQ-035, NFR-001, NFR-002, NFR-005

### Reliability and consistency

- SLS delivery 按至少一次处理设计；数据库来源位置唯一约束保证同一投递重放不重复建任务。数据库 commit 后才 ack SLS checkpoint；consumer 崩溃时允许重放。
- Transactional outbox 消除 task commit 与调查 enqueue 之间的双写丢失。worker claim 有租约、重试次数、退避和最终失败状态。
- ConsumerGroup 的分区 rebalance 必须先停止被撤销 shard 的写入，再释放 assignment；失去租约的 worker 使用 fencing token 不能提交新状态。
- 验证记录带配置版本/hash；修改 Endpoint、Project、Logstore 或凭据会使旧验证失效并暂停/阻止重新启用。
- MR 创建使用唯一 RepairRun idempotency key；网络超时后先查询既有 MR 再重试，避免多开 MR。
- **Covers**: REQ-013 至 REQ-016, REQ-018, REQ-025, REQ-026, REQ-032 至 REQ-036, NFR-003, NFR-005 至 NFR-007

### Observability

- 关联日志和 trace 使用 `projectId`, `dataSourceConnectionId`, `errorEventId`, `taskId`, `repairRunId`, `consumerGroup`, `shard`；不把凭据、原始 auth header 或完整敏感日志写入 telemetry。
- 暴露 consumer lag、最后成功 checkpoint、每 shard 状态、消费速率、错误分类计数、outbox 积压、调查时延、workspace lock wait、测试结果和 MR API 失败率。
- 健康状态区分 `connected`, `lagging`, `rebalance`, `retrying`, `failed`, `disabled`；没有数据不能等同 consumer 失败。
- **Covers**: REQ-008, REQ-013, REQ-015, REQ-016, REQ-018 至 REQ-026, REQ-032, NFR-003, NFR-006

## Risks & Trade-offs

| Risk | Impact | Mitigation |
|------|--------|------------|
| Alibaba SLS Node Consumer Group client capability or source-position fidelity is insufficient | Could violate real-time and one-log-one-task idempotency guarantees | Before implementation tasks, verify the official Consumer Group protocol and its TypeScript implementation path, including group membership, shard assignment, checkpoint/ack, retry/rebalance behavior, and stable per-record position. The currently reviewed official Node SDK does not expose these APIs, so do not add it as proof of Consumer Group support. Keep the adapter interface isolating the protocol implementation and block the implementation plan if no supported path can provide the required semantics. |
| HolmesGPT `/api/chat` has process-level toolset configuration rather than per-project SLS credentials | Investigation cannot autonomously run additional project-scoped SLS queries through the current global toolset | Preload bounded SLS and GitLab evidence in the TypeScript Investigation Adapter; define a task-scoped internal tool/MCP extension as a later design if more query autonomy is required. |
| One card per error log can create high database, queue, and UI volume | Consumer lag and investigation cost can grow rapidly | Use pagination, bounded evidence size, per-project concurrency limits, retention/archival policy, lag alarms, and backpressure. Do not silently merge events; any aggregation policy requires a new confirmed requirement. |
| GitLab role lookup is unavailable during approval | Approval could be granted to a revoked or unknown user | Fail closed for approvals and new repairs; display a retryable authorization service error. |
| Running project automated tests executes repository-controlled scripts | A malicious repository could access worker filesystem/network or exhaust resources | Run in a dedicated low-privilege worker identity with resource/time limits, restricted filesystem, no ambient secrets and controlled network. Container sandbox remains out of first-release product scope; exact isolation mechanism is an implementation security gate. |
| Persistent checkout can become stale or corrupted | Repair may use an outdated base or modify the wrong branch | Before repair, verify remote project identity, fetch the target ref, record base SHA, create an isolated repair branch and reject dirty/unexpected workspace state. |

## Requirements Coverage

| Spec Requirement | Design Coverage |
|------------------|-----------------|
| REQ-001 | TypeScript Web Client; TypeScript Control API |
| REQ-002 | Identity and GitLab Connector; API OAuth start/callback |
| REQ-003 | Identity and GitLab Connector; PAT API |
| REQ-004 | Identity and GitLab Connector; GitLabConnection model |
| REQ-005 | Identity and GitLab Connector; project listing API |
| REQ-006 | GitLab Connector; Project model; Project Workspace Manager |
| REQ-007 | Project Workspace Manager; ProjectWorkspace model |
| REQ-008 | Project Workspace Manager; workspace API; Observability |
| REQ-009 | Project Workspace Manager; fencing lock |
| REQ-010 | SLS Data Source Adapter; DataSourceConnection model |
| REQ-011 | SLS Data Source Adapter; SLS configuration API |
| REQ-012 | Decision 6; encrypted credential fields; Security |
| REQ-013 | SLS Data Source Adapter; DataSourceVerification; test APIs |
| REQ-014 | SLS enable gate; configuration sequence |
| REQ-015 | SLS Adapter result contract; standard errors; Observability |
| REQ-016 | SLS Consumer Service; Detection flow |
| REQ-017 | SLS Data Source Adapter; Detection Pipeline |
| REQ-018 | Detection Pipeline; ErrorEvent; InvestigationTask; Outbox |
| REQ-019 | Investigation Adapter and HolmesGPT Engine |
| REQ-020 | Investigation Adapter failure handling; Reliability |
| REQ-021 | Web Client task detail; InvestigationTask result |
| REQ-022 | Approval and Repair Worker; approval API |
| REQ-023 | Decision 7; server-side repair authorization |
| REQ-024 | Project Workspace Manager; RepairRun |
| REQ-025 | Repair Worker state gate; repair API |
| REQ-026 | GitLab Connector; MergeRequest idempotency |
| REQ-027 | TypeScript Web Client and Control API |
| REQ-028 | PostgreSQL/Prisma contract and architecture boundary |
| REQ-029 | TypeScript Web Client; UI reference constraint |
| REQ-030 | GitLabGroup model; Decision 5 |
| REQ-031 | PostgreSQL and Prisma Persistence; Decision 2 |
| REQ-032 | SLS Consumer Service; SLSConsumerState; NFR-006 |
| REQ-033 | Decision 4; ErrorEvent source-position unique key |
| REQ-034 | Task state model; fixed priority |
| REQ-035 | Identity and GitLab Connector; live role validation |
| REQ-036 | Repair Worker; dual verification gate |
| NFR-001 | Decision 6; Security and authorization |
| NFR-002 | relational audit links; role/approval/repair history |
| NFR-003 | Adapter result contract; worker failures; Observability |
| NFR-004 | DataSourceAdapter abstraction |
| NFR-005 | workspace fencing lock; transactional outbox |
| NFR-006 | SLS Consumer Service; Consumer Group recovery |
| NFR-007 | ErrorEvent source-position uniqueness; Decision 4 |

## Group Workspace 数据/API 调整（2026-11-23）

以 requirements.md 的 NEED-009、CON-006、DEC-014 及 spec.md 第 12 节为当前范围。旧设计中每项目 checkout 作为仓库执行单元保留；业务 Workspace 和 SLS 改为 Group 范围。

- 新增 GroupWorkspace（每 GitLabGroup 唯一）和 WorkspaceRepository（Workspace/Project 关联）；ProjectWorkspace 继续承载仓库 checkout、分支、互斥锁。已有 checkout 可复用。
- DataSourceConnection 新增可空 workspaceId，旧 projectId 改为可空；数据库约束要求两者恰有一个。保留旧配置，不擅自合并已在消费的数据源。
- InvestigationTask 新增 workspaceId 和 TaskRepository 目标关联；组级检测不预设 projectId，调查后校验所有目标均在 Workspace 内。RepairRun 通过 ProjectWorkspace 指向具体仓库。
- GET GitLab Group 项目支持 includeSubgroups 和分页；POST /api/workspaces 根据用户授权发现全部仓库并初始化/重试 checkout，GET /api/state 返回 Workspace 和逐仓状态。
- SLS 创建/测试改为接收 workspaceId，验证当前用户对 Workspace 的所有权。后台消费者仍针对每个数据源只消费一次；不会为每个仓库重复消费相同日志。
- Group Workspace 调查附带仓库清单/只读代码证据；审批绑定调查目标仓库，各仓库执行前重新验证 GitLab 权限和锁。
