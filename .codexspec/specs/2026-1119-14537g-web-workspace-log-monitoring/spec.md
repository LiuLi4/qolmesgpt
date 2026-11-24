# 功能规格：Web 项目工作区与日志故障闭环

**Feature Branch**: `2026-1119-14537g-web-workspace-log-monitoring`
**Created**: 2026-11-19
**Status**: Draft
**Input**: 已确认需求文件 `.codexspec/specs/2026-1119-14537g-web-workspace-log-monitoring/requirements.md`

## 1. 上下文与目标

QolmesGPT 当前可以通过 YAML 配置数据源，但用户希望通过 Web UI 完成从代码项目选择、日志接入、持续检测、错误调查到人工审批修复的完整流程。本功能把已存在的 HolmesGPT 调查执行引擎和阿里云 SLS 日志接入能力组织成一个按项目运行的 Web 工作流。

第一期只实现阿里云 SLS 的 Web 配置和验证，数据源接口必须能够在后续接入其他 HolmesGPT data source。代码仓库来自用户授权的 GitLab 项目；每个项目有独立的持久化 checkout workspace。系统自动调查和提出修复方案，但任何代码修改、测试执行和 MR 创建都必须在人工审批之后发生。

本规格定义用户可观察的行为、边界和验收条件。数据库技术已确定为 PostgreSQL + Prisma；检测传输已确定为 SLS 实时消费；审批权限已确定为 GitLab Group 角色规则。API 框架、前端组件库、消费组具体部署细节和任务执行器实现仍属于设计阶段决策。

## 2. 用户场景与验收

### 用户故事 1：连接 GitLab 并建立项目 workspace（优先级：P1）

用户通过 OAuth 2.0 或 PAT 连接自己的 GitLab，浏览自己有权限访问的项目并选择一个项目。系统为该项目创建或复用独立 checkout workspace，并显示 workspace 状态。

**优先级原因**：所有后续日志配置、调查和代码修复都必须绑定到一个明确的 GitLab 项目。

**独立测试**：使用一个有效 GitLab OAuth 连接或 PAT，选择一个可访问项目，验证项目列表权限过滤、workspace 创建和重复进入时的复用行为。

**验收场景**：

1. **给定**用户尚未连接 GitLab，**当**用户选择 OAuth 2.0 并完成 GitLab 授权，**则**系统创建用户级 GitLab connection，并且不向前端返回访问令牌明文。
2. **给定**用户选择 PAT 连接方式，**当**提交有效 PAT，**则**系统验证凭据并创建用户级 GitLab connection；无效 PAT 不得创建可用连接。
3. **给定**用户已连接 GitLab，**当**打开项目选择页面，**则**列表只包含该 GitLab connection 当前可访问的项目。
4. **给定**用户选择一个项目，**当**项目尚无 workspace，**则**系统创建该项目独立 checkout workspace，并显示初始化状态和失败原因。
5. **给定**项目已有可用 workspace，**当**用户再次进入项目，**则**系统复用该 workspace，而不是创建第二个同项目 checkout。

### 用户故事 2：配置并验证阿里云 SLS（优先级：P1）

用户在已选择的项目中选择阿里云 SLS，填写 Project、Logstore、Endpoint 和访问凭据。系统保存加密后的配置，执行连接测试和真实日志读取测试；两项测试成功后，用户才可以启用该数据源。

**优先级原因**：没有经过真实读取验证的数据源不能安全地进入 7×24 检测。

**独立测试**：使用有效和无效的 SLS 配置分别执行连接测试与日志读取测试，验证启用前置条件、错误提示和凭据脱敏。

**验收场景**：

1. **给定**用户在项目中新增 SLS data source，**当**填写完整配置并保存，**则**系统将配置关联到该项目，并把敏感凭据加密保存。
2. **给定**SLS Endpoint、Project、Logstore 或凭据无效，**当**用户执行连接测试，**则**测试失败并返回可定位的错误信息，数据源保持未验证状态。
3. **给定**连接测试成功但日志读取测试失败，**当**用户尝试启用检测，**则**系统拒绝启用并说明日志读取失败。
4. **给定**连接测试和日志读取测试均成功，**当**用户启用数据源，**则**系统记录可审计的验证结果并允许进入检测状态。
5. **给定**任何 API、UI、任务或日志输出涉及 SLS 凭据，**则**不得输出访问密钥、Secret 或 PAT 明文。

### 用户故事 3：持续检测、建卡并调查错误（优先级：P1）

用户启用已验证的 SLS data source 后，系统通过 SLS 实时消费持续检测日志。发现符合 SLS 适配器默认错误规则的日志时，系统为每条错误日志创建一个独立的可追踪调查任务卡片，保留源日志证据并调用 HolmesGPT 调查执行引擎。

**优先级原因**：这是从被动查询转向自动发现和调查的核心价值。

**独立测试**：向已验证的 SLS data source 写入多条符合默认错误规则的测试日志，验证实时消费、每条日志一张任务卡片、源日志证据和 HolmesGPT 调查调用之间的关联。

**验收场景**：

1. **给定**数据源已验证且处于启用状态，**当**实时消费者读取到符合 SLS 适配器默认错误规则的日志，**则**系统为该日志创建一张独立调查任务卡片并记录项目、data source、日志时间和可用于检索的错误证据。
2. **给定**检测到的日志不符合默认错误规则，**当**检测器处理该日志，**则**系统不得将其作为错误调查任务创建。
3. **给定**连续收到两条符合错误规则的日志，**当**实时消费者处理它们，**则**系统保留两条独立 ErrorEvent；同请求按 traceId/requestId 归并，相同错误指纹在 15 分钟跨度内归并任务，保留次数与证据。
4. **给定**调查任务卡片已创建，**当**HolmesGPT 调查执行引擎开始运行，**则**任务卡片显示调查状态，并能关联调查输出。
5. **给定**SLS 消费连接断开、消费组发生重平衡或出现积压，**当**检测器恢复运行，**则**系统从持久化消费位置继续处理，并避免因重复投递造成无法追踪的重复处理。
6. **给定**SLS 暂时不可用或消费失败，**当**检测器处理错误，**则**系统保留失败状态和可诊断错误信息，不得将消费失败伪装成“没有错误”。

### 用户故事 4：审查修复方案并创建 MR（优先级：P2）

用户查看调查结论、错误原因、代码上下文和修复方案。用户明确审批后，系统才可以在项目 checkout workspace 中修改代码、执行验证并创建 GitLab MR。

**优先级原因**：自动修复具有更高影响，必须在人工控制下执行；但它依赖前面三个 P1 场景已经形成可用的调查上下文。

**独立测试**：对一个已有调查结果分别执行无权限用户、拒绝和批准路径，验证未审批或无权限时不会改代码，批准后可以生成可审查的代码变更、双重验证结果和 MR 结果。

**验收场景**：

1. **给定**调查已产生修复方案，**当**用户查看任务卡片，**则**界面同时展示错误证据、调查结论、代码关联和修复方案。
2. **给定**修复方案尚未审批或审批被拒绝，**当**任何自动任务尝试修改代码或创建 MR，**则**系统拒绝执行并保持 workspace 和远程仓库不变。
3. **给定**审批人属于项目 GitLab Group 且角色为 Developer、Maintainer 或 Owner，**当**其提交单人审批，**则**系统记录有效审批并允许进入修复流程。
4. **给定**审批人不属于项目 GitLab Group 或角色不满足要求，**当**其提交审批，**则**系统拒绝审批且不允许进入修复流程。
5. **给定**修复方案已获得有效人工审批，**当**系统开始修复流程，**则**系统记录审批事件、占用 workspace、执行代码变更和验证步骤。
6. **给定**代码修改、项目自动化测试或 SLS 错误复查任一失败，**当**修复流程结束，**则**任务显示失败原因；系统不得创建声称已验证的 MR。
7. **给定**代码修改、项目自动化测试和 SLS 错误复查均成功，**当**系统创建 MR，**则**任务卡片关联 MR 地址、源任务、审批记录和两类验证结果。

## 3. 边界情况与错误行为

- GitLab OAuth 被用户拒绝、回调参数无效、PAT 过期或权限不足时，系统显示授权失败原因，并保持原有连接状态不被破坏。
- GitLab 项目已经被其他用户或旧配置绑定时，系统不得创建未定义的重复 workspace；应显示冲突状态，等待后续产品规则处理。
- workspace 初始化、同步、锁定或 checkout 失败时，项目仍可被查看，但不得进入需要可用 workspace 的修复步骤；错误必须包含项目和 workspace 上下文。
- 多个任务同时操作同一项目时，系统必须通过 workspace 状态或锁阻止相互覆盖，并给出“正在被其他任务占用”的可观察状态。
- SLS 凭据错误、Endpoint 不可达、Project/Logstore 不存在或查询语法/参数错误时，连接测试或读取测试失败；未通过验证的数据源不能启用检测。
- SLS 查询成功但没有匹配日志时，系统应将结果标记为“本次没有匹配日志”，不得把它与 API 查询失败混淆。
- 实时消费连接断开、消费组重平衡、游标无效或消费积压时，系统必须记录消费状态并执行重连、恢复或告警策略；不得丢弃已确认接收但尚未处理的日志。
- HolmesGPT 调查失败、超时或返回不完整结果时，任务卡片保留原始错误证据并显示调查失败状态；不得生成看似确定的修复结论。
- 修复审批超时、被撤回或审批信息无效时，系统不得开始代码修改、测试或 MR 创建。
- 审批人不是项目 GitLab Group 的 Developer、Maintainer 或 Owner 时，审批无效。
- 项目自动化测试通过但 SLS 错误复查仍能发现原错误时，修复结果必须失败，不得创建已验证 MR。
- MR 创建失败时，系统保留已审批的修复和验证结果，但必须明确标识 MR 尚未创建，避免重复执行造成多个 MR。
- 任何前端响应、普通日志、任务详情或错误报告中出现敏感凭据时，必须进行脱敏。

## 4. 功能需求

### 4.1 用户、GitLab 和项目范围

- **REQ-001**：系统 MUST 提供 Web UI 作为项目、data source、检测、调查、审批和修复流程的操作入口，不要求用户直接编辑 YAML。
  - Sources: NEED-001
- **REQ-002**：系统 MUST 为用户提供 GitLab OAuth 2.0 连接流程。
  - Sources: NEED-009, CON-001, DEC-001, DEC-002
- **REQ-003**：系统 MUST 为用户提供 PAT 连接流程，并在保存前验证 PAT 的有效性和项目访问能力。
  - Sources: NEED-009, CON-001, DEC-002
- **REQ-004**：系统 MUST 按用户保存 GitLab connection，并使用该 connection 的权限获取项目列表。
  - Sources: NEED-009, DEC-001
- **REQ-005**：系统 MUST 只向用户展示其当前 GitLab connection 有权访问的项目。
  - Sources: NEED-009, DEC-001
- **REQ-006**：系统 MUST 将选中的 GitLab Group 作为 Workspace、data source 和调查范围，递归纳入子 Group 中所有可访问项目；修复定位到调查识别的具体仓库。
  - Sources: NEED-009, NEED-009, CON-006, DEC-001

### 4.2 项目 workspace

- **REQ-007**：系统 MUST 为每个选定 GitLab Group 创建或复用持久化 Group Workspace，并为其中每个项目维护独立 checkout。
  - Sources: NEED-009, CON-006, DEC-014
- **REQ-008**：系统 MUST 记录 Workspace 的 Group 关联、递归项目清单及逐仓路径、Git 状态和可用性；仓库新增、移除和初始化失败必须可见。
  - Sources: NEED-009, CON-006, DEC-014
- **REQ-009**：系统 MUST 防止并发调查、修复和测试任务覆盖同一项目 checkout 中的文件。
  - Sources: NEED-009, CON-006, DEC-014

### 4.3 SLS data source 配置与验证

- **REQ-010**：系统 MUST 将 data source 建模为可扩展的类型和配置接口，并在第一期实现 Alibaba Cloud SLS 类型。
  - Sources: NEED-004, DEC-003
- **REQ-011**：系统 MUST 允许用户将 SLS data source 关联到一个 Group Workspace，并配置 SLS Project、Logstore、Endpoint 和访问凭据。
  - Sources: NEED-009, DEC-003, DEC-005
- **REQ-012**：系统 MUST 在持久化前加密 SLS 访问凭据，并在读取、API 响应、任务详情和日志中进行脱敏。
  - Sources: CON-002, DEC-005
- **REQ-013**：系统 MUST 提供独立的 SLS 连接测试和真实日志读取测试，并保存每次测试的结果、时间和错误信息。
  - Sources: NEED-009, CON-004, DEC-005
- **REQ-014**：系统 MUST 只有在连接测试和日志读取测试均成功后才允许启用 SLS data source 的持续检测。
  - Sources: NEED-009, CON-004
- **REQ-015**：系统 MUST 在 SLS API 返回错误、无权限、配置不存在、读取失败或无匹配日志时，区分失败状态与成功但无数据状态。
  - Sources: NEED-009, CON-004

### 4.4 持续检测与 HolmesGPT 调查

- **REQ-016**：系统 MUST 对每个已验证且已启用的 data source 执行持续的 7×24 日志检测。
  - Sources: NEED-006, CON-004
- **REQ-017**：SLS 适配器 MUST 使用当前适配器的默认错误判定规则识别错误日志：`level >= 50`、`status >= 500`，或 `msg`/`content` 中包含 `error`、`exception`、`failed`、`timeout`、`panic` 等常见错误词；规则必须为后续项目级覆盖保留扩展接口。
  - Sources: NEED-006, DEC-006
- **REQ-018**：系统 MUST 为检测到的错误创建可追踪的调查任务卡片，并关联 Group Workspace、受影响仓库（定位后）、data source、原始日志证据和当前检测状态。
  - Sources: NEED-006
- **REQ-019**：系统 MUST 将调查任务提交给 HolmesGPT 调查执行引擎，并将调查状态、结论、错误原因和关联代码上下文回写任务卡片。
  - Sources: NEED-006, NEED-007
- **REQ-020**：系统 MUST 在调查失败、超时、查询失败或结果不完整时保留失败原因和原始错误证据，不得生成未经证实的确定性结论。
  - Sources: NEED-006, NEED-007

### 4.5 人工审批、修复、MR 和验证

- **REQ-021**：系统 MUST 在任务卡片中展示错误证据、调查结论、关联代码和修复方案，供用户审阅。
  - Sources: NEED-007
- **REQ-022**：系统 MUST 在代码修改、修复测试和 MR 创建之前检查有效的人工审批记录。
  - Sources: NEED-007, CON-005
- **REQ-023**：系统 MUST 拒绝任何未审批、被拒绝或已撤回审批的代码修改、测试和 MR 创建请求。
  - Sources: NEED-007, CON-005
- **REQ-024**：系统 MUST 在审批通过后使用该项目的独立 checkout workspace 执行代码修改和验证，并记录执行状态及输出。
  - Sources: NEED-009, NEED-007, CON-006, CON-005
- **REQ-025**：系统 MUST 在代码修改或验证失败时阻止创建声称已验证的 MR，并在任务卡片中显示失败原因。
  - Sources: NEED-007
- **REQ-026**：系统 MUST 在代码修改和验证成功后创建 GitLab MR，并将 MR 地址、审批记录、修复变更和验证结果关联到调查任务。
  - Sources: NEED-007, NEED-009

### 4.6 实现边界与交付顺序

- **REQ-027**：后续 Web 工作流的前端和后端 MUST 使用 TypeScript 实现。
  - Sources: NEED-008
- **REQ-028**：后续实现 MUST 按数据库设计、接口设计、前端页面的顺序推进；前一阶段的契约未确定前，不得以页面实现替代数据或 API 设计。
  - Sources: NEED-008
- **REQ-029**：Web UI 的布局和交互设计 MAY 参考 loopforge 文档站点，但不得改变本规格中已确认的权限、审批和数据源验证行为。
  - Sources: NEED-008, DEC-003
- **REQ-030**：系统 MUST 使用 GitLab Group 作为第一期项目和成员权限边界，不得要求额外的 QolmesGPT 组织/租户层才能完成项目选择和审批。
  - Sources: DEC-007
- **REQ-031**：系统 MUST 使用 PostgreSQL 作为持久化数据库，并使用 Prisma 管理数据模型和迁移；开发环境 MUST 提供 Docker PostgreSQL，生产环境 MUST 支持托管 PostgreSQL。
  - Sources: DEC-008
- **REQ-032**：系统 MUST 使用 Alibaba Cloud SLS 实时消费执行第一期 7×24 检测，目标是秒级发现错误，并持久化消费组、分区/游标、连接状态和恢复所需信息。
  - Sources: NEED-006, DEC-009
- **REQ-033**：系统 MUST 按源位置去重 ErrorEvent；同 Workspace 优先按 traceId、其次 service/requestId 归并请求（跨度最多 60 分钟），再按规范化 fingerprint 在 15 分钟跨度内归并任务，记录日志条数、请求数、首次/最近时间。已审批、修复中、失败或关闭任务不得接收新证据。
  - Sources: NEED-006, DEC-010
- **REQ-034**：调查任务 MUST 使用 `待调查`、`调查中`、`待审批`、`修复中`、`已验证`、`失败` 和 `已关闭` 状态，并固定为高优先级；第一期不要求负责人和外部通知字段生效。
  - Sources: DEC-011
- **REQ-035**：系统 MUST 只接受项目所属 GitLab Group 中角色为 Developer、Maintainer 或 Owner 的用户提交的单人审批。
  - Sources: CON-005, DEC-007, DEC-012
- **REQ-036**：系统 MUST 将项目自动化测试和 SLS 错误复查都通过作为修复成功条件；任一验证失败都 MUST 阻止创建已验证 MR。
  - Sources: NEED-007, DEC-013

## 5. 非功能需求

- **NFR-001**：凭据和敏感仓库信息 MUST 采用加密存储和最小化返回策略；敏感值不得进入提交内容、普通日志或错误报告。
  - Sources: CON-002, DEC-005
- **NFR-002**：项目 workspace、任务和审批状态 MUST 能被审计地关联到用户、GitLab 项目和时间点。
  - Sources: NEED-009, NEED-009, NEED-007, CON-006, CON-005
- **NFR-003**：检测、连接测试、调查和修复流程 MUST 对失败状态提供可定位的错误信息，不得将失败显示为成功或无数据。
  - Sources: NEED-009, NEED-006, NEED-007
- **NFR-004**：data source 接口 MUST 允许在不改变项目、workspace、任务和审批核心流程的情况下添加新的 HolmesGPT data source。
  - Sources: NEED-004, DEC-003
- **NFR-005**：workspace 操作 MUST 具有并发控制，避免同一项目的多个任务产生不可审查的文件覆盖或远程变更。
  - Sources: NEED-009, CON-006, DEC-014
- **NFR-006**：SLS 实时消费 MUST 支持断线重连、消费组重平衡、游标恢复和幂等处理，以避免 7×24 检测因短暂故障停止或丢失已接收日志。
  - Sources: NEED-006, DEC-009
- **NFR-007**：任务创建 MUST 保留每条错误日志的独立证据和任务关联，不能因任务量增长而隐式改变一条日志对应一张任务卡片的规则。
  - Sources: DEC-010

## 6. 概念实体

以下实体用于后续数据库设计，表示业务关系，不锁定具体表名或数据库产品：

- **User**：使用 QolmesGPT 的用户，拥有 GitLab connections、项目访问上下文和审批行为。
- **GitLabConnection**：用户通过 OAuth 2.0 或 PAT 建立的 GitLab 授权连接，包含实例信息、授权类型、加密凭据和状态。
- **GitLabProject**：Workspace 中当前连接可访问的独立 Git 仓库，作为代码修改、测试、锁和 MR 的执行范围。
- **ProjectWorkspace**：一个 GitLab 项目的持久化独立 checkout，包含路径、Git 状态、占用状态和同步结果。
- **DataSourceConnection**：Group Workspace 关联的数据源配置；第一期具体类型为 Alibaba Cloud SLS。
- **DataSourceVerification**：连接测试和真实日志读取测试的结果记录。
- **DetectionJob**：针对已验证、已启用 data source 的持续检测执行上下文。
- **ErrorEvent**：检测到的、符合适配器默认错误规则的日志证据及其项目范围。
- **InvestigationTask**：围绕 ErrorEvent 创建的任务卡片，承载 HolmesGPT 调查状态、结论和修复方案。
- **Approval**：针对修复方案的人工审批记录，作为代码修改、测试和 MR 创建的前置条件。
- **RepairRun**：审批后在 ProjectWorkspace 中执行的代码修改与验证过程。
- **MergeRequest**：由成功 RepairRun 创建的 GitLab MR 及其关联结果。
- **GitLabGroupMembership**：用户在项目所属 GitLab Group 中的角色，用于判断项目访问和人工审批权限。
- **SLSConsumerCheckpoint**：SLS 实时消费组、分区/游标、连接状态和恢复信息。

## 7. 成功标准

### 可度量结果

- **SC-001**：用户可以只通过 Web UI 完成 GitLab 连接、项目选择、workspace 创建和状态查看，不需要编辑 YAML。
- **SC-002**：项目选择结果不包含当前 GitLab connection 无权访问的项目；无效 OAuth/PAT 不会生成可用连接。
- **SC-003**：未同时通过 SLS 连接测试和真实日志读取测试的数据源无法进入启用检测状态。
- **SC-004**：每个符合默认错误规则的测试日志都能关联到一个包含项目、data source、源日志证据和 HolmesGPT 调查状态的任务卡片。
- **SC-005**：对未审批的修复流程执行代码变更、测试或 MR 请求时，代码 checkout 和远程 GitLab 项目均不发生变更。
- **SC-006**：审批通过且修复验证成功的任务能够关联一个 GitLab MR、审批记录和验证结果；任一步骤失败时任务显示明确失败状态。
- **SC-007**：通过 API、UI、任务卡片和普通日志检查不到 SLS Secret、AccessKey Secret 或 GitLab PAT 明文。
- **SC-008**：SLS 实时消费断线恢复后，系统能够从持久化消费位置继续处理，不丢失符合规则的事件，按 REQ-033 归并任务。
- **SC-009**：GitLab Group 中 Developer、Maintainer 或 Owner 的单人审批可以进入修复流程，其他角色的审批不能解除审批门禁。
- **SC-010**：项目自动化测试或 SLS 错误复查任一失败时不创建已验证 MR；两者都成功时才允许关联已验证 MR。

## 8. 已确认约束与决策

- 第一阶段只提供 Alibaba Cloud SLS 的完整 Web 配置、验证和检测能力；其他 data source 的完整页面不在范围内。
- GitLab 连接按用户管理，同时支持 OAuth 2.0 和 PAT。
- workspace 采用项目独立 checkout 目录；容器/沙箱不是第一期必需条件。
- SLS 配置通过 Web UI 提交并加密保存凭据。
- 第一阶段采用 SLS 适配器默认错误判定规则，并保留后续扩展点。
- 前后端使用 TypeScript，交付顺序为数据库设计、接口设计、前端页面。
- GitLab Group 是第一期项目和成员权限边界。
- 第一阶段使用 SLS 实时消费，目标秒级发现；每条错误日志创建独立调查任务。
- 第一阶段任务采用基础状态流和固定高优先级，不启用负责人和外部通知。
- Developer、Maintainer 或 Owner 可以单人审批。
- 修复必须同时通过项目自动化测试和 SLS 错误复查。
- 持久化使用 PostgreSQL + Prisma，开发使用 Docker PostgreSQL，生产使用托管 PostgreSQL。

## 9. 已解决的设计前置问题

以下问题已在需求澄清阶段确认，并已编译为本规格中的行为要求：

- **DEC-007**：GitLab Group 权限边界。
- **DEC-008**：PostgreSQL + Prisma 部署模型。
- **DEC-009**：SLS 实时消费。
- **DEC-010**：请求聚合与错误指纹归并。
- **DEC-011**：基础任务状态流。
- **DEC-012**：GitLab Group 角色单人审批。
- **DEC-013**：项目测试和 SLS 复查双重验证。

## 10. Out of Scope

- **OUT-001**：第一期不实现除 Alibaba Cloud SLS 之外其他 HolmesGPT data source 的完整 Web 配置和验证页面。
- **OUT-002**：第一期不要求每个项目 workspace 运行在独立容器或沙箱中。

## 11. 需求追踪矩阵

| 已确认条目 | 规格覆盖 | 说明 |
|---|---|---|
| NEED-001 | REQ-001, SC-001 | Web UI 主流程 |
| NEED-009 | REQ-002 至 REQ-006, SC-002 | 用户级 GitLab 项目访问 |
| NEED-009 | REQ-007 至 REQ-009, REQ-024, SC-005 | 项目独立 checkout |
| NEED-004 | REQ-010, NFR-004, OUT-001 | SLS-first 与可扩展数据源 |
| NEED-009 | REQ-011 至 REQ-015, SC-003 | SLS 配置和读取验证 |
| NEED-006 | REQ-016 至 REQ-020, REQ-032 至 REQ-034, NFR-006 至 NFR-007, SC-004, SC-008 | 实时检测与逐条调查任务 |
| NEED-007 | REQ-019, REQ-021 至 REQ-026, REQ-035 至 REQ-036, SC-005 至 SC-006, SC-009 至 SC-010 | 调查、审批、修复和 MR |
| NEED-008 | REQ-027 至 REQ-029 | TypeScript、交付顺序和 UI 参考 |
| CON-001 | REQ-002, REQ-003, DEC-002 | OAuth 与 PAT |
| CON-002 | REQ-012, NFR-001, SC-007 | 凭据保护 |
| CON-006 | REQ-006, REQ-008, REQ-009, NFR-002, NFR-005 | 项目边界和并发控制 |
| CON-004 | REQ-013 至 REQ-015, REQ-016, SC-003 | 验证后启用检测 |
| CON-005 | REQ-022, REQ-023, NFR-002, SC-005 | 人工审批门禁 |
| DEC-001 | REQ-004 至 REQ-006 | 用户级 GitLab connection |
| DEC-002 | REQ-002, REQ-003 | OAuth 2.0 和 PAT |
| DEC-003 | REQ-010, REQ-011, REQ-017, NFR-004, OUT-001 | SLS-first |
| DEC-014 | REQ-007 至 REQ-009, NFR-005, OUT-002 | 持久化 checkout |
| DEC-005 | REQ-011 至 REQ-014, NFR-001 | Web 配置和加密保存 |
| DEC-006 | REQ-017 | 默认错误判定规则 |
| DEC-007 | REQ-030, REQ-035, GitLabGroupMembership | GitLab Group 权限边界 |
| DEC-008 | REQ-031 | PostgreSQL + Prisma |
| DEC-009 | REQ-032, NFR-006, SLSConsumerCheckpoint | 实时消费 |
| DEC-010 | REQ-033, NFR-007, SC-008 | 请求聚合与错误指纹归并 |
| DEC-011 | REQ-034 | 基础任务状态流 |
| DEC-012 | REQ-035, SC-009 | 单人审批角色 |
| DEC-013 | REQ-036, SC-010 | 双重修复验证 |
| OUT-001 | 第 10 节 | 非 SLS Web 配置不在范围内 |
| OUT-002 | 第 10 节 | 容器/沙箱不在第一期范围内 |

## 12. Group Workspace 补充验收（2026-11-23）

Sources: NEED-009, CON-006, DEC-014。此节取代先前场景中的单项目 Workspace/数据源绑定表述。

- 选择 Group 后展示其全部可访问项目（递归子 Group，完整分页），无需先选单个项目。
- 一个 Group 对应一个 Workspace，一个 Workspace 关联该组的仓库清单及共享 SLS；重复同步幂等，不复制数据源或仓库记录。
- 新增/移除仓库通过同步更新清单；移除不删除代码或历史记录，失败仓库显示具体状态，不得伪报全部就绪。
- 每条错误创建一张 Workspace 任务，HolmesGPT 获取组内仓库清单和只读证据；输出受影响项目 ID，拒绝 Workspace 外的仓库 ID。
- 未定位到仓库的调查明确显示未定位并阻止批准修复。跨仓修复按审批中列出的仓库分别获取锁、修改、测试和关联 MR；不能将组范围审批用于未列入的仓库。
- 仓库同步只允许所选 Group/子 Group 中当前连接有权访问的仓库；API、日志、checkout Git remote 中不得保存明文 Token。
- 旧单项目数据、任务及审批保留并可查看；新入口以 Group Workspace 为业务范围。

| Confirmed Entry | Spec Requirements | Coverage |
|---|---|---|
| NEED-009 | REQ-006, REQ-007, REQ-008, REQ-011, REQ-018, 本节 | Group 和子 Group、共享日志、跨仓调查 |
| CON-006 | REQ-009, REQ-022 至 REQ-026, REQ-035, 本节 | 独立 checkout、锁、审批、逐仓测试和 MR |
| DEC-014 | REQ-006 至 REQ-009, REQ-011, 本节 | Group Workspace 与仓库关联 |


### 2026-11-24 调查链路验收补充

- 调查前补查相同 trace/request ID 的有界 SLS 上下文，并检索 Workspace 仓库的文件/行号；查询失败与缺失证据必须明确记录。
- 调查期间增加证据时，旧 evidenceVersion 的结果不得进入审批，应重新调查。
- UI 显示日志条数/请求数和首次/最近时间；详情显示根因、建议、引用、上下文和错误状态，并提供未审批任务的重新调查入口。
- 无效模型凭据必须显示失败，不能以模拟结果通过真实调查验收。
