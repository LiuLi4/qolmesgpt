# 已确认需求：Web 项目工作区与日志故障闭环

<!--
本文件是用户确认意图的权威记录。只有 Status: confirmed 的条目才可作为
后续规格、设计、计划和实现的输入；open 条目不得被推断为已确认需求。
-->

**Feature ID**: `2026-1119-14537g`
**Status**: Confirmed baseline
**Last Confirmed**: 2026-11-23 Asia/Shanghai

## Authority Rules

- Only entries with `Status: confirmed` are binding downstream inputs.
- `open` entries MUST NOT be converted into confirmed product requirements without user confirmation.
- Replaced entries remain in this file with `Status: superseded` and a link to the replacement.
- AI inferences must be labeled as assumptions and require user confirmation before becoming binding.

## Needs

### NEED-001: Web UI as the primary operating surface

- **Status**: confirmed
- **Statement**: Users must be able to operate the project, data source, detection, investigation, approval, and repair workflows through a Web UI without relying on YAML configuration.
- **Rationale**: The current YAML-based configuration is not sufficient for the intended end-to-end product workflow.
- **User Evidence**: “整个QolmesGPT的工作流程应该是通过web UI来操作。”
- **Confirmed At**: 2026-11-19 15:00 Asia/Shanghai

### NEED-002: User-authorized GitLab project selection

- **Status**: superseded
- **Replaced By**: NEED-009, CON-006, DEC-014（2026-11-23 Group Workspace 决策）
- **Statement**: A user must be able to connect GitLab and select a project that is visible within that user's GitLab permissions.
- **Rationale**: All later workspace, log source, investigation, and repair operations are scoped to a GitLab project.
- **User Evidence**: “选择gitlab中的项目，以这个项目建立独立的workspace。” The user selected user-level GitLab connections.
- **Confirmed At**: 2026-11-19 15:00 Asia/Shanghai

### NEED-003: Project-scoped checkout workspace

- **Status**: superseded
- **Replaced By**: NEED-009, CON-006, DEC-014（2026-11-23 Group Workspace 决策）
- **Statement**: Selecting a GitLab project must create or reuse a persistent, project-specific checkout directory that can be used by investigation, code modification, testing, and merge request operations.
- **Rationale**: Investigation and remediation need a stable code context and must not overwrite another project's files.
- **User Evidence**: The user selected “项目独立 checkout 目录” for the workspace.
- **Confirmed At**: 2026-11-19 15:00 Asia/Shanghai

### NEED-004: Alibaba Cloud SLS as the first Web-configured data source

- **Status**: confirmed
- **Statement**: The first Web UI data source implementation must support Alibaba Cloud SLS and must provide an extensible data source model for later HolmesGPT data sources.
- **Rationale**: SLS is already integrated into QolmesGPT through YAML and is the first source that must become Web-configurable.
- **User Evidence**: The user selected “只支持阿里云 SLS，保留通用扩展接口”。
- **Confirmed At**: 2026-11-19 15:00 Asia/Shanghai

### NEED-005: Configure and verify SLS per project

- **Status**: superseded
- **Replaced By**: NEED-009, CON-006, DEC-014（2026-11-23 Group Workspace 决策）
- **Statement**: After selecting a project, the user must be able to associate an SLS data source, configure its Project, Logstore, Endpoint, and access credentials in the Web UI, test connectivity, and verify that logs can be read before enabling detection.
- **Rationale**: A successful configuration must be observable before background detection starts.
- **User Evidence**: “关联选择项目对应的日志的来源……然后进行配置，配置成功后测试是否可以成功读取到日志信息。” The user selected Web UI configuration with encrypted credential storage.
- **Confirmed At**: 2026-11-19 15:00 Asia/Shanghai

### NEED-006: Continuous log detection and investigation task cards

- **Status**: confirmed
- **Statement**: Each enabled workspace data source must be monitored continuously, 24 hours per day and 7 days per week. When an error is detected, the system must create an investigation task card and invoke the HolmesGPT investigation execution engine.
- **Rationale**: The product must turn unhandled log errors into traceable investigations rather than requiring a user to start each investigation manually.
- **User Evidence**: “每个接入的data source进行7✖️24小时的日志检测，当发现报错，建立任务卡片 HolmesGPT 的调查执行引擎 开始查询报错原因。”
- **Confirmed At**: 2026-11-19 15:00 Asia/Shanghai

### NEED-007: Explain errors and gate remediation behind human approval

- **Status**: confirmed
- **Statement**: An investigation must produce the likely error cause, relevant project code context, and a proposed repair. Code changes, tests, and merge request creation must not start until a human approves the repair.
- **Rationale**: Automated diagnosis is allowed, while code mutation and repository changes require explicit human control.
- **User Evidence**: “进行错误排查并给出修复方案最后经过人工审批开始修改代码并提交MR，验证bug修复。”
- **Confirmed At**: 2026-11-19 15:00 Asia/Shanghai

### NEED-008: TypeScript Web product with staged delivery

- **Status**: confirmed
- **Statement**: The future front end and back end for this workflow must be developed in TypeScript. Delivery must proceed in this order: database design, API design, then front-end pages. The Web UI layout and interaction may use the loopforge documentation site as a reference.
- **Rationale**: The user explicitly requires a TypeScript Web product and a data-first implementation sequence.
- **User Evidence**: “前后端的实现都是用typescript语言进行开发……先进行数据库设计，再进行接口设计，再开发前端页面。”
- **Confirmed At**: 2026-11-19 15:00 Asia/Shanghai

## Constraints

### CON-001: Support both GitLab OAuth 2.0 and PAT

- **Status**: confirmed
- **Statement**: The first release must support both GitLab OAuth 2.0 authorization and user-provided Personal Access Tokens.
- **User Evidence**: The user selected “OAuth 2.0 和 PAT 都支持”。

### CON-002: Protect credentials and sensitive repository data

- **Status**: confirmed
- **Statement**: SLS and GitLab credentials must be encrypted at rest, must be masked in API responses and logs, and must not be committed to the repository.
- **User Evidence**: The user selected Web UI configuration with encrypted credential storage. This security handling is required to make that choice implementable.

### CON-003: Isolate project workspaces and concurrent tasks

- **Status**: superseded
- **Replaced By**: NEED-009, CON-006, DEC-014（2026-11-23 Group Workspace 决策）
- **Statement**: A workspace must be scoped to one GitLab project and must provide state and locking controls so concurrent investigation, repair, and test tasks cannot overwrite one another.
- **User Evidence**: The user selected a project-specific checkout directory.

### CON-004: Verify a data source before enabling detection

- **Status**: confirmed
- **Statement**: A data source cannot be enabled for continuous detection until connectivity and a real log-read test have succeeded.
- **User Evidence**: The user required configuration success to be followed by a test that confirms logs can be read.

### CON-005: Human approval precedes repository mutation

- **Status**: confirmed
- **Statement**: Automated investigation may analyze logs and propose a repair, but modifying code, running the repair workflow, or creating an MR requires an explicit human approval event.
- **User Evidence**: “最后经过人工审批开始修改代码并提交MR”。

## Decisions

### DEC-001: User-level GitLab connections in the first release

- **Status**: confirmed
- **Decision**: Model GitLab connections per user and filter project selection by the connected user's GitLab permissions.
- **Alternatives Rejected**: A single administrator-owned GitLab connection for all users.
- **Reason**: The user selected user-level connections to preserve each user's GitLab project access boundary.
- **User Evidence**: “第一期实现用户级连接”。

### DEC-002: Both OAuth 2.0 and PAT authorization

- **Status**: confirmed
- **Decision**: Support OAuth 2.0 as the guided authorization flow and PAT as an alternate connection method.
- **Alternatives Rejected**: OAuth-only; PAT-only.
- **Reason**: The user selected support for both authorization methods.
- **User Evidence**: “OAuth 2.0 和 PAT 都支持”。

### DEC-003: SLS first, extensible data source abstraction

- **Status**: confirmed
- **Decision**: Implement the Web configuration and verification flow for Alibaba Cloud SLS first, while defining a data source abstraction that can support other HolmesGPT sources later.
- **Alternatives Rejected**: Implement all built-in data sources in the first release; implement all log sources in the first release.
- **Reason**: The user selected SLS-only first-release scope with extensibility.
- **User Evidence**: “只支持阿里云 SLS，保留通用扩展接口”。

### DEC-004: Persistent project checkout workspace

- **Status**: superseded
- **Replaced By**: NEED-009, CON-006, DEC-014（2026-11-23 Group Workspace 决策）
- **Decision**: Maintain a persistent independent checkout directory for each project.
- **Alternatives Rejected**: Temporary clone on every task; project-per-container as the first implementation.
- **Reason**: This supports reuse across investigation, code changes, tests, and MR creation while keeping implementation complexity manageable for the first release.
- **User Evidence**: The user selected “项目独立 checkout 目录”。

### DEC-005: Web-configured SLS credentials with encrypted storage

- **Status**: confirmed
- **Decision**: Accept SLS connection configuration through the Web UI and encrypt credentials before persistence.
- **Alternatives Rejected**: Environment-only configuration; environment defaults with project-level overrides in the first release.
- **Reason**: Project-level Web configuration is required for the selected user-facing workflow.
- **User Evidence**: “Web UI 配置，凭据加密保存”。

### DEC-006: Adapter default error classification

- **Status**: confirmed
- **Decision**: Use default error classification rules in the SLS adapter for the first release, with an extension point for future project-level overrides.
- **Alternatives Rejected**: Fully configurable error rules in the first release; default rules plus configurable overrides in the first release.
- **Reason**: The user selected adapter default rules to keep the first release focused.
- **User Evidence**: “适配器默认规则”。

### DEC-007: GitLab Group as the permission boundary

- **Status**: confirmed
- **Decision**: Reuse the GitLab Group as the QolmesGPT project and membership boundary instead of adding a separate QolmesGPT organization or tenant layer in the first release.
- **Alternatives Rejected**: A separate single-organization role model; a multi-tenant model.
- **Reason**: The user selected GitLab Group as the existing project and member permission boundary.
- **User Evidence**: “复用 GitLab Group 作为权限边界”。

### DEC-008: PostgreSQL and Prisma deployment model

- **Status**: confirmed
- **Decision**: Use PostgreSQL with Prisma; use Docker PostgreSQL for development and a managed PostgreSQL service in production.
- **Alternatives Rejected**: Drizzle; self-managed PostgreSQL in every environment; SQLite with later migration.
- **Reason**: The user selected PostgreSQL + Prisma with managed production and Docker development environments.
- **User Evidence**: “PostgreSQL + Prisma；生产托管、开发 Docker”。

### DEC-009: SLS real-time consumption

- **Status**: confirmed
- **Decision**: Use Alibaba Cloud SLS real-time consumption for the first release, targeting second-level error discovery.
- **Alternatives Rejected**: One-minute polling; five-minute polling.
- **Reason**: The user selected real-time consumption for the 7×24 detection requirement.
- **User Evidence**: “SLS 实时消费，目标秒级发现”。

### DEC-010: Request aggregation and repeated-error grouping (updated 2026-11-24)

- **Status**: confirmed; supersedes the initial one-card-per-error decision.
- **Decision**: Preserve every source-position-deduplicated ErrorEvent; aggregate matching requests within the Workspace using traceId then service/requestId. Group normalized fingerprints across requests for as long as the task remains unresolved; preserve counts, first/last timestamps and evidence versions.
- **Implementation defaults**: Request span 60 minutes; unresolved fingerprint span is unbounded; initial collection delay 10 seconds capped at 60 seconds. Missing request IDs remain individually counted.
- **Reason**: The latest user request explicitly asks to complete deduplication/request aggregation and invoke HolmesGPT for root-cause investigation.
- **User Evidence**: “按照错误日志去重、聚合属于一次请求的错误日志信息，调用 HolmesGPT 定位具体错误原因” followed by “补齐”。
- **Limits**: Approved/repairing/failed/closed tasks do not accept new evidence. Real model output requires working provider credentials. Private repository source contents remain outside model prompts; bounded file/line references are permitted.

### DEC-011: Basic task card flow

- **Status**: confirmed
- **Decision**: Use the states `待调查 → 调查中 → 待审批 → 修复中 → 已验证 / 失败 / 已关闭`; assign fixed high priority; do not assign owners or integrate external notifications in the first release.
- **Alternatives Rejected**: Owner and in-product notification support; external Feishu/Slack/Webhook notifications.
- **Reason**: The user selected the basic task flow.
- **User Evidence**: “基础任务流，固定高优先级，暂不分配负责人和外部通知”。

### DEC-012: Single approval by eligible GitLab Group roles

- **Status**: confirmed
- **Decision**: A user with the GitLab Group `Developer`, `Maintainer`, or `Owner` role may provide the single approval required for code modification and MR creation.
- **Alternatives Rejected**: Maintainer/Owner only; two-person approval; delegating all conditions to GitLab Approval Rules.
- **Reason**: The user selected Developer, Maintainer, or Owner with one approval.
- **User Evidence**: “Group Developer、Maintainer 或 Owner，单人审批即可”。

### DEC-013: Dual repair verification

- **Status**: confirmed
- **Decision**: A repair is successful only when both the project's automated tests and an SLS re-query confirming the original error is gone have passed.
- **Alternatives Rejected**: Project tests only; SLS re-query only; project-specific verification strategies in the first release.
- **Reason**: The user selected both automated project tests and SLS error recheck.
- **User Evidence**: “项目自动化测试和 SLS 错误复查都必须通过”。

## Out of Scope

### OUT-001: Complete Web configuration for non-SLS data sources

- **Status**: confirmed
- **Statement**: The first release does not include complete Web configuration pages and verification flows for all other HolmesGPT data sources.
- **Reason**: The confirmed first-release scope is Alibaba Cloud SLS with an extensible abstraction.
- **User Evidence**: “只支持阿里云 SLS，保留通用扩展接口”。

### OUT-002: Container sandbox as the first workspace implementation

- **Status**: confirmed
- **Statement**: The first release does not require each project workspace to run inside a dedicated container or sandbox.
- **Reason**: The confirmed first-release workspace is a persistent independent checkout directory.
- **User Evidence**: The user selected “项目独立 checkout 目录”。

## Open Questions

### OPEN-001: Detection transport, interval, and latency

- **Status**: resolved
- **Resolution**: Replaced by DEC-009.
- **Why It Matters**: Determines scheduler/consumer architecture, SLS query windows, cost, and the meaning of 7×24 detection.
- **Owner**: User / Team

### OPEN-002: Error deduplication and aggregation

- **Status**: resolved
- **Resolution**: Replaced by DEC-010.
- **Why It Matters**: Determines whether repeated errors create one task or many tasks and defines the error fingerprint and task cardinality.
- **Owner**: User / Team

### OPEN-003: Task card state, priority, ownership, and notifications

- **Status**: resolved
- **Resolution**: Replaced by DEC-011.
- **Why It Matters**: Determines the task-card schema, UI workflow, and notification integrations.
- **Owner**: User / Team

### OPEN-004: Approval roles and quorum

- **Status**: resolved
- **Resolution**: Replaced by DEC-012.
- **Why It Matters**: Determines authorization checks and whether one or multiple approvals are required before code mutation and MR creation.
- **Owner**: User / Team

### OPEN-005: Bug-fix verification contract

- **Status**: resolved
- **Resolution**: Replaced by DEC-013.
- **Why It Matters**: Determines whether verification requires project tests, a new SLS query showing the error is gone, or both.
- **Owner**: User / Team

### OPEN-006: QolmesGPT user, organization, and role model

- **Status**: resolved
- **Resolution**: Replaced by DEC-007.
- **Why It Matters**: User-level GitLab connections and approvals require a product-level identity and authorization model.
- **Owner**: User / Team

### OPEN-007: Database technology and deployment model

- **Status**: resolved
- **Resolution**: Replaced by DEC-008.
- **Why It Matters**: The requested implementation starts with database design, but the persistence technology and hosting model are not yet selected.
- **Owner**: Team / Research

## Superseded Entries

<!-- Keep replaced entries with Status: superseded. -->

## Confirmation Log

### Session 2026-11-19 15:00 Asia/Shanghai

- **Summary Presented**: Web UI-driven GitLab project workspaces, user-level GitLab OAuth/PAT connections, SLS-first data source configuration and verification, persistent project checkout, 7×24 detection, HolmesGPT investigation cards, human approval before code changes and MR creation, and TypeScript staged delivery.
- **User Confirmation**: “确认，写入 requirements.md”。
- **Entries Confirmed**: NEED-001, NEED-002, NEED-003, NEED-004, NEED-005, NEED-006, NEED-007, NEED-008, CON-001, CON-002, CON-003, CON-004, CON-005, DEC-001, DEC-002, DEC-003, DEC-004, DEC-005, DEC-006, OUT-001, OUT-002

### Session 2026-11-19 16:10 Asia/Shanghai

- **Summary Presented**: GitLab Group permission boundary, PostgreSQL + Prisma deployment, SLS real-time consumption, one task per error log, basic high-priority task flow, Developer/Maintainer/Owner single approval, and dual repair verification with project tests plus SLS re-query.
- **User Confirmation**: “确认，将这 7 项写入 requirements.md 和 spec.md”。
- **Entries Confirmed**: DEC-007, DEC-008, DEC-009, DEC-010, DEC-011, DEC-012, DEC-013

## 已确认的 Group Workspace 范围（2026-11-23）

### NEED-009: Group Workspace 与统一日志来源

- **Status**: confirmed
- **Statement**: 用户选择 GitLab Group 建立一个持久化 Workspace，递归纳入该 Group 及子 Group 中当前连接有权访问的全部项目。SLS 数据源绑定 Workspace，覆盖这些仓库的日志；逐条错误任务归属 Workspace，调查可关联一个或多个仓库。
- **User Evidence**: “一个日志收集器记录的是group下所有项目的日志信息，workspace最终不应该定位到一个项目 而是应该定位到group下的所有项目”；“确认，包含子 Group，按上述范围实现”。
- **Confirmed At**: 2026-11-23 Asia/Shanghai

### CON-006: 组范围调查和仓库范围修改

- **Status**: confirmed
- **Statement**: Workspace 是日志和调查的业务范围；仓库各有独立 checkout、分支、锁、测试和 MR。调查结果明确受影响仓库后，经人工审批才可逐仓修复、验证和创建 MR。无法定位仓库的错误保留任务并明确显示未定位，不得自动选首个仓库修改。
- **User Evidence**: 用户确认 Group Workspace、跨仓调查和各仓独立修改、测试及 MR 的范围。

### DEC-014: Group Workspace 和独立仓库 checkout

- **Status**: confirmed
- **Decision**: 以 GitLab Group 创建/复用 Workspace，递归分页获取全部可访问项目（不包含仅分享给 Group 的外部项目）。维护 Workspace 与项目的关联；SLS 配置只关联 Workspace。保留仓库级 checkout 供只读调查和审批后修复。
- **Alternatives Rejected**: 日志源绑定单个项目；仅包含直属项目；将多个仓库合并为一个 Git 仓库。
- **Reason**: 一个 SLS 日志收集器覆盖整个 Group 的项目，单项目模型不能准确表达调查范围。
- **User Evidence**: “确认，包含子 Group，按上述范围实现”。

### Confirmation 2026-11-23 Asia/Shanghai

- **Summary Presented**: 一个 Group 建立 Workspace，包含子 Group 中可访问的全部项目；SLS 绑定 Workspace；调查可跨仓，人工审批后对涉及仓库分别修改、测试并提交 MR。
- **User Response**: “确认，包含子 Group，按上述范围实现”。
- **Result**: NEED-009、CON-006、DEC-014 confirmed；原单项目范围 superseded。

### NEED-010: Workspace 自动读取与调查开关（2026-11-24）

- **Status**: confirmed
- **Statement**: 顶部状态替换为“AI 自动读取日志”开关，控制当前 Workspace 全部数据源的自动读取和 AI 调查；先暂停现有 Workspace，保留历史日志证据与消费进度。
- **User Evidence**: “改成AI自动读取日志开关，并先暂停日志自动读取并调用分析”。

### 调查详情与重复任务修正（2026-11-24）

- **Status**: confirmed
- **Statement**: 同一未审批错误指纹不因时间间隔重复建立任务；保留全部证据与历史任务 ID。详情头部展示完整任务 ID，左侧日志、右侧调查结论。
- **User Evidence**: “这个和任务351c324a是重复的为什么没有识别出来”；“头部要展示任务ID”；“左边显示具体错误日志，右边显示调查结论，改成左右两栏布局”。
