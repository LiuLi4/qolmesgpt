# 实施计划：Web 项目工作区与日志故障闭环

**Related Design**: `.codexspec/specs/2026-1119-14537g-web-workspace-log-monitoring/design.md`
**Confirmed Requirements**: `.codexspec/specs/2026-1119-14537g-web-workspace-log-monitoring/requirements.md`
**Design Review**: `.codexspec/specs/2026-1119-14537g-web-workspace-log-monitoring/review-design.md`
**Status**: Draft

## Context, Goals and Non-goals

本计划实现已审查通过的设计：用户通过 TypeScript Web 控制面连接 GitLab、选择项目、获得持久化独立 checkout，配置并验证阿里云 SLS，持续消费错误日志，调用现有 Python HolmesGPT 调查引擎，并在 GitLab Group 权限成员人工审批后执行修复、双重验证和 MR 创建。

目标是按已确认顺序交付数据库、接口、前端，再接入后台消费和修复 worker，保持项目、data source、任务、审批和审计记录的项目边界。

第一期不实现除 Alibaba Cloud SLS 外其他 data source 的完整页面，不建立额外 QolmesGPT 组织/租户层，不把项目凭据写入 HolmesGPT 全局 YAML，也不要求 workspace 运行在独立容器中。

## Existing Repository Constraints

- HolmesGPT 当前以 Python/FastAPI 提供 `/api/chat` 调查入口；现有 SLS toolset 是进程级配置的只读查询能力。
- `experimental/ag-ui/front-end` 是演示 UI，README 标明不适用于生产；它可用于交互参考，不作为产品后端或生产 UI 基座。
- 仓库目前没有正式 TypeScript 控制面、Prisma schema 或生产 Web UI；第一期需新增 TypeScript 应用边界，并保持 Python 引擎独立。
- 项目规定使用 PostgreSQL + Prisma，开发提供 Docker PostgreSQL，生产支持托管 PostgreSQL。
- 所有新增功能必须有单元/集成验证；提交前运行适用的检查，提交使用 DCO sign-off。

## Implementation Approach

建议建立以下 TypeScript 目录边界，作为计划中的实现落点；实际框架配置在第一阶段确认并记录：

- `apps/control-plane`: REST/JSON API、Prisma、认证/授权、GitLab/SLS adapter 编排。
- `apps/web`: Web UI，按项目向导、data source 验证、任务卡片、审批和修复结果页面组织。
- `apps/workers`: SLS consumer、outbox/investigation worker、repair worker。
- `packages/contracts`: API DTO、领域枚举、错误码和 adapter 接口。
- `packages/security`: envelope encryption、脱敏和服务到服务认证边界。

HolmesGPT Python 服务继续由现有仓库入口运行；TypeScript Investigation Adapter 通过内部认证调用 `/api/chat`，并在请求中发送有界日志和代码证据。

## Plan-Level Decisions

### PLD-001：新增独立 TypeScript 应用边界

- **Decision**：不把产品流程塞进 `experimental/ag-ui` 或 Python CLI；新增 `apps/control-plane`、`apps/web`、`apps/workers` 和共享契约包。
- **Evidence**：仓库只有演示性质的 TypeScript UI，现有 HolmesGPT 核心是 Python/FastAPI；需求明确要求前后端使用 TypeScript。
- **Alternative**：扩展演示 UI 或重写 Python HolmesGPT。两者会把演示代码或成熟调查引擎当作错误的产品边界。
- **Trade-off**：增加多应用构建和服务间契约，但保留调查引擎并支持项目级凭据隔离。

### PLD-002：先建立契约和持久化门禁，再并行开发 UI/worker

- **Decision**：先落 Prisma schema、迁移、领域状态机、DTO 和错误码；API 契约稳定后再实现 UI；SLS consumer 和 repair worker 以契约为依赖并行推进。
- **Evidence**：REQ-028 明确交付顺序为数据库、接口、前端；设计使用 outbox 和服务端状态门禁。
- **Trade-off**：早期页面不能快速展示完整流程，但减少前后端字段漂移和状态越权。

### PLD-003：SLS Consumer Group 能力是实现前置门禁

- **Decision**：第一阶段先完成官方协议/客户端能力验证和小型集成探针，再锁定消费实现。当前审查过的官方 Node SDK 只有普通日志 API，不能直接作为 Consumer Group 实现。
- **Evidence**：设计审查中的风险 advisory；REQ-032/NFR-006 要求实时消费、重平衡、checkpoint 恢复和幂等。
- **Stop condition**：若无法获得能提供 group membership、shard assignment、checkpoint/ack、rebalance 和稳定 source position 的受支持实现，停止 consumer 实现并回到设计阶段，不以周期查询冒充实时消费。

### PLD-004：测试先采用真实协议边界的 mock，再安排 staging SLS 验证

- **Decision**：单元测试使用 responses/HTTP mock 或协议 fixture；集成测试覆盖本地 PostgreSQL 和模拟 SLS consumer；在 staging 凭据可用时追加真实 `pyxis-telemetry-log/pyxis-trace-staging` 读取验证。
- **Trade-off**：mock 提供确定性，真实 staging 测试验证协议和权限，但依赖外部环境且不得写入凭据。

## Implementation Phases

### Phase 1 — TypeScript foundation and database contract

1. 初始化 TypeScript workspace、构建/测试脚本和共享 lint/typecheck 约定。
2. 建立 Prisma schema、迁移和 Docker PostgreSQL；实现 User、GitLabConnection、GitLabGroup、Project、ProjectWorkspace、DataSourceConnection、Verification、ConsumerState、ErrorEvent、InvestigationTask、Approval、RepairRun、MergeRequest、OutboxMessage 模型及唯一约束。
3. 实现领域状态机、任务优先级固定规则、来源位置幂等键和脱敏序列化。
4. 实现 envelope encryption 接口、密钥版本字段和本地开发密钥注入方式；禁止 secrets 进入 DTO、日志和 outbox payload。

**Covers**: REQ-006–REQ-012, REQ-018, REQ-022–REQ-026, REQ-030–REQ-036, NFR-001–NFR-002, NFR-005, NFR-007; **Design**: PostgreSQL and Prisma Persistence, Data Models, Decision 2, Decision 4, Decision 6.

**Verification**:

- Prisma migration 在 Docker PostgreSQL 上可重复执行；唯一约束和状态转换测试通过。
- 序列化测试证明 GitLab/SLS credentials、绝对 workspace 路径和敏感日志字段不会出现在响应或 outbox。
- 事务测试证明 ErrorEvent、InvestigationTask 和 outbox 同时提交或同时回滚。

### Phase 2 — GitLab connector and workspace manager

1. 实现 OAuth 2.0 state/PKCE、callback、PAT 验证和加密 token refresh 接口。
2. 实现 Group/project 分页查询和实时 Group membership role 查询；缓存只用于展示。
3. 实现项目绑定、持久化 checkout 初始化/同步、项目路径 containment、dirty-state 检查、租约锁和 fencing token。
4. 实现 branch/push/MR API 的最小 GitLab connector，并加入幂等查询。

**Covers**: REQ-002–REQ-009, REQ-024, REQ-026, REQ-030, REQ-035, NFR-002, NFR-005; **Design**: Identity and GitLab Connector, Project Workspace Manager, Decision 5.

**Verification**:

- OAuth/PAT mock 覆盖拒绝、过期、无权限和重复 callback；token 不进入响应。
- workspace 测试覆盖路径逃逸、并发锁、过期 fencing token、脏 checkout 和错误项目远程地址。
- GitLab connector 集成测试覆盖可见项目过滤、角色门禁、branch/MR 幂等。

### Phase 3 — Data source API and SLS adapter

1. 实现通用 `DataSourceAdapter`、`aliyun-sls` 配置校验、endpoint/project/logstore 规范化和结构化错误码。
2. 使用官方普通 SLS Node SDK/API 完成连接测试和有界真实读取测试；保存成功、失败和成功但无数据的验证记录。
3. 实现默认错误规则：`level >= 50`、`status >= 500` 或错误关键词；保留项目级规则扩展接口。
4. 完成 staging SLS 真实验证：`cn-shanghai` endpoint、Project `pyxis-telemetry-log`、Logstore `pyxis-trace-staging` 只通过 Web/API 的加密连接配置进入系统。

**Covers**: REQ-010–REQ-017, REQ-032, NFR-003–NFR-004; **Design**: SLS Data Source Adapter, API contracts, Decision 6.

**Verification**:

- 使用 mock 响应覆盖无权限、项目/Logstore 不存在、查询失败、空结果和有结果。
- 用示例结构化日志验证 error 规则分类和敏感字段脱敏。
- staging 读取测试只输出安全摘要和 request ID，不输出 AccessKey/PAT；无凭据时跳过真实测试并保持失败状态。

### Phase 4 — Consumer Group probe and detection pipeline

1. 研究并实现 SLS Consumer Group 协议探针，确认 group membership、shard assignment、checkpoint/ack、rebalance、retry 和稳定 source position。
2. 仅在 Phase 4 门禁通过后实现独立 consumer worker、health/lag 状态、断线重连和消费恢复。
3. 将记录交给 Detection Pipeline；在一个数据库事务内写 ErrorEvent、InvestigationTask 和 outbox，成功后才提交 checkpoint。
4. 用 `(connectionId, sourcePositionKey)` 幂等，保留各日志为独立证据，按请求与指纹窗口归并任务。

**Covers**: REQ-016–REQ-018, REQ-032–REQ-034, NFR-003, NFR-006–NFR-007; **Design**: SLS Consumer Service, Detection Pipeline and Task Service, Decision 3, Decision 4.

**Verification**:

- 协议 fixture/集成探针验证断线、重复投递、rebalance、checkpoint 恢复和无稳定位置时的明确失败。
- 检查“数据库提交失败不 ack、重复投递不重复建卡、不同 source position 保留证据且满足窗口时归并任务”。
- 以 staging 测试日志验证秒级检测目标和逐条任务创建；测量 consumer lag 与任务创建延迟。

### Phase 5 — Investigation adapter and task APIs

1. 实现 outbox worker、租约 claim、退避/重试和最终失败状态。
2. 从项目 checkout/ref 读取有界代码上下文和 GitLab 元数据，合并 SLS 错误证据，调用内部 HolmesGPT `/api/chat`。
3. 保存调查状态、结论、原因、代码引用和修复建议；不完整/超时/查询失败只能进入失败状态并保留源证据。
4. 实现项目任务列表和详情 API，严格检查 project scope 和脱敏响应。

**Covers**: REQ-018–REQ-021, REQ-034, NFR-002–NFR-003, NFR-005; **Design**: Investigation Adapter and HolmesGPT Engine, Detection Pipeline, API contracts, Decision 6.

**Verification**:

- HolmesGPT mock 覆盖成功、超时、HTTP 错误和不完整结构化结果。
- outbox worker 崩溃重启后只重试未完成消息；重复消息不产生第二个任务。
- API 测试覆盖跨 project 访问、凭据泄露和失败原因可定位性。

### Phase 6 — Approval, repair worker, verification and MR

1. 实现 approval API：实时读取 Group role，只接受 Developer/Maintainer/Owner 的单人审批；拒绝/撤回不解除门禁。
2. 实现 Repair Worker：校验 approval/version、获取 workspace fencing lock、创建 repair branch、执行受限修复能力。
3. 记录项目自动化测试和 SLS 原错误复查结果；任一失败进入 FAILED，不允许创建已验证 MR。
4. 双验证成功后通过 GitLab connector 幂等创建 MR，保存 MR URL/ID、审批和验证审计关联。

**Covers**: REQ-021–REQ-026, REQ-034–REQ-036, NFR-001–NFR-002, NFR-005; **Design**: Approval and Repair Worker, Project Workspace Manager, Decision 5, Decision 7.

**Verification**:

- 端到端测试覆盖无权限、拒绝、批准、审批过期、GitLab 不可用和重复 repair 请求。
- 测试失败或 SLS 复查仍命中原错误时证明不会创建 MR；两者通过时证明只创建一个 MR。
- worker 使用低权限身份、资源/时间限制和无 ambient secrets；记录脱敏 stdout/stderr。

### Phase 7 — Web UI and operational hardening

1. 实现 GitLab 连接/项目选择/workspace 页面。
2. 实现 SLS 配置向导、连接测试、读取测试、启用/暂停和 consumer 状态页面。
3. 实现任务列表、详情、调查证据、审批、修复进度、验证结果和 MR 关联页面；交互参考 loopforge 文档站点的层级和反馈方式。
4. 接入健康指标、consumer lag、outbox backlog、调查时延、锁等待、验证失败和 MR API 错误率；完善审计检索、分页和错误状态。
5. 运行完整非 LLM 测试、TypeScript lint/typecheck/build、Prisma migration check 和 staging smoke test。

**Covers**: REQ-001, REQ-008, REQ-011, REQ-013–REQ-016, REQ-018, REQ-021–REQ-029, REQ-032–REQ-036, NFR-001–NFR-007; **Design**: TypeScript Web Client, TypeScript Control API, Cross-Cutting Security/Observability.

**Verification**:

- 浏览器验收覆盖完整用户路径，不要求编辑 YAML。
- 检查所有错误、空数据、权限、消费中断和修复失败状态的可见反馈。
- 安全扫描确认 token、SLS credentials、绝对路径和敏感仓库内容不出现在 UI、日志、telemetry 或提交内容。

## Verification Strategy

- **Unit**：领域状态机、默认错误规则、source-position key、脱敏、加密、DTO 和错误码。
- **Integration**：PostgreSQL/Prisma、GitLab connector mock、SLS API mock、Consumer Group 协议 fixture、outbox worker 和 HolmesGPT `/api/chat` mock。
- **Staging smoke**：使用用户提供的 staging SLS Project `pyxis-telemetry-log` / Logstore `pyxis-trace-staging`，只执行连接和有界读取；凭据从本机环境或 Web 加密配置注入，不提交任何 secret。
- **End-to-end**：从项目选择到 MR 的批准路径，以及未批准/验证失败的拒绝路径。
- **Required checks**：项目已有非 LLM pytest；新增 TypeScript 应用必须提供 package scripts 运行 lint、typecheck、unit/integration tests 和 build。仅在用户明确要求时运行全仓库 pre-commit/ruff/mypy；本计划阶段至少运行文档校验、git diff --check 和新增 TypeScript/Prisma 相关检查。

## Risks and Delivery Gates

| Gate | Evidence required | If not met |
|---|---|---|
| SLS Consumer Group | Supported protocol/client with assignment, checkpoint/ack, rebalance and stable source position | Stop Phase 4; return to design review |
| Credential protection | Encryption/decryption tests and redaction tests | Do not enable SLS or GitLab writes |
| Workspace safety | Containment, lock/fencing and restricted test execution tests | Do not enable repair worker |
| HolmesGPT contract | Authenticated `/api/chat` integration and bounded evidence schema | Keep investigation tasks failed/paused |
| Dual verification | Project test + SLS recheck both recorded as pass | Do not create MR |

## Requirements Coverage

| Requirement | Plan Phase | Design Component |
|---|---|---|
| REQ-001 | Phase 7 | TypeScript Web Client |
| REQ-002–REQ-006 | Phase 2 | Identity and GitLab Connector |
| REQ-007–REQ-009 | Phase 2 | Project Workspace Manager |
| REQ-010–REQ-017 | Phase 3 | SLS Data Source Adapter |
| REQ-016–REQ-018, REQ-032–REQ-034 | Phase 4 | SLS Consumer Service; Detection Pipeline |
| REQ-018–REQ-021 | Phase 5 | Investigation Adapter and HolmesGPT Engine |
| REQ-021–REQ-026, REQ-035–REQ-036 | Phase 6 | Approval and Repair Worker |
| REQ-027–REQ-029 | Phase 7 | TypeScript Web Client and Control API |
| REQ-030 | Phase 2 | GitLab Group authorization boundary |
| REQ-031 | Phase 1 | PostgreSQL and Prisma Persistence |
| NFR-001–NFR-002 | Phases 1, 2, 6, 7 | Security and audit design |
| NFR-003–NFR-004 | Phases 3, 5, 7 | Adapter/result contracts and observability |
| NFR-005 | Phases 1, 2, 4, 6 | Outbox and workspace fencing |
| NFR-006 | Phase 4 | SLS Consumer Service recovery |
| NFR-007 | Phases 1 and 4 | ErrorEvent identity and independent tasks |

## Unresolved Items

- The exact SLS Consumer Group protocol/client implementation is intentionally unresolved until the Phase 4 probe. This is an implementation gate already identified by the design review; it must not be replaced by polling.
- The concrete TypeScript web framework and authentication provider are not fixed by the confirmed requirements. Phase 1 must choose them without changing the API, security, or Group permission behavior.
- The concrete restricted execution mechanism for repository-controlled tests is not fixed by the first-release scope. Phase 6 must verify it before enabling repair.
