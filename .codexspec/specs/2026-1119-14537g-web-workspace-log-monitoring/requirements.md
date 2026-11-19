# 已确认需求：Web 项目工作区与日志故障闭环

<!--
本文件是用户确认意图的权威记录。只有 Status: confirmed 的条目才可作为
后续规格、设计、计划和实现的输入；open 条目不得被推断为已确认需求。
-->

**Feature ID**: `2026-1119-14537g`
**Status**: Confirmed baseline with open design questions
**Last Confirmed**: 2026-11-19 15:00 Asia/Shanghai

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

- **Status**: confirmed
- **Statement**: A user must be able to connect GitLab and select a project that is visible within that user's GitLab permissions.
- **Rationale**: All later workspace, log source, investigation, and repair operations are scoped to a GitLab project.
- **User Evidence**: “选择gitlab中的项目，以这个项目建立独立的workspace。” The user selected user-level GitLab connections.
- **Confirmed At**: 2026-11-19 15:00 Asia/Shanghai

### NEED-003: Project-scoped checkout workspace

- **Status**: confirmed
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

- **Status**: confirmed
- **Statement**: After selecting a project, the user must be able to associate an SLS data source, configure its Project, Logstore, Endpoint, and access credentials in the Web UI, test connectivity, and verify that logs can be read before enabling detection.
- **Rationale**: A successful configuration must be observable before background detection starts.
- **User Evidence**: “关联选择项目对应的日志的来源……然后进行配置，配置成功后测试是否可以成功读取到日志信息。” The user selected Web UI configuration with encrypted credential storage.
- **Confirmed At**: 2026-11-19 15:00 Asia/Shanghai

### NEED-006: Continuous log detection and investigation task cards

- **Status**: confirmed
- **Statement**: Each enabled project data source must be monitored continuously, 24 hours per day and 7 days per week. When an error is detected, the system must create an investigation task card and invoke the HolmesGPT investigation execution engine.
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

- **Status**: confirmed
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

- **Status**: confirmed
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

- **Status**: open
- **Why It Matters**: Determines scheduler/consumer architecture, SLS query windows, cost, and the meaning of 7×24 detection.
- **Owner**: User / Team

### OPEN-002: Error deduplication and aggregation

- **Status**: open
- **Why It Matters**: Determines whether repeated errors create one task or many tasks and defines the error fingerprint and task cardinality.
- **Owner**: User / Team

### OPEN-003: Task card state, priority, ownership, and notifications

- **Status**: open
- **Why It Matters**: Determines the task-card schema, UI workflow, and notification integrations.
- **Owner**: User / Team

### OPEN-004: Approval roles and quorum

- **Status**: open
- **Why It Matters**: Determines authorization checks and whether one or multiple approvals are required before code mutation and MR creation.
- **Owner**: User / Team

### OPEN-005: Bug-fix verification contract

- **Status**: open
- **Why It Matters**: Determines whether verification requires project tests, a new SLS query showing the error is gone, or both.
- **Owner**: User / Team

### OPEN-006: QolmesGPT user, organization, and role model

- **Status**: open
- **Why It Matters**: User-level GitLab connections and approvals require a product-level identity and authorization model.
- **Owner**: User / Team

### OPEN-007: Database technology and deployment model

- **Status**: open
- **Why It Matters**: The requested implementation starts with database design, but the persistence technology and hosting model are not yet selected.
- **Owner**: Team / Research

## Superseded Entries

<!-- Keep replaced entries with Status: superseded. -->

## Confirmation Log

### Session 2026-11-19 15:00 Asia/Shanghai

- **Summary Presented**: Web UI-driven GitLab project workspaces, user-level GitLab OAuth/PAT connections, SLS-first data source configuration and verification, persistent project checkout, 7×24 detection, HolmesGPT investigation cards, human approval before code changes and MR creation, and TypeScript staged delivery.
- **User Confirmation**: “确认，写入 requirements.md”。
- **Entries Confirmed**: NEED-001, NEED-002, NEED-003, NEED-004, NEED-005, NEED-006, NEED-007, NEED-008, CON-001, CON-002, CON-003, CON-004, CON-005, DEC-001, DEC-002, DEC-003, DEC-004, DEC-005, DEC-006, OUT-001, OUT-002
