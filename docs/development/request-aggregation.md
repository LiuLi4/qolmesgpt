# SLS 请求归并与真实调查

检测链路：SLS 消费 → 日志位置去重 → 请求/指纹归并 → PostgreSQL Outbox → 调查 Worker → SLS 上下文与 checkout 代码取证 → HolmesGPT `/api/chat` → 任务结果 → 人工审批。

## 归并规则

- `(dataSourceConnectionId, sourcePositionKey)` 唯一，消费重放不会增加证据或任务。
- 同一 Workspace 的多个数据源共同参与归并；优先 traceId，其次 service + requestId，最大请求跨度 60 分钟。
- 不同请求使用规范化错误指纹（服务、组件、异常类型、状态、方法、路由、错误消息）归并；只要任务仍未审批、修复或关闭，同类指纹持续归入同一任务，不再受时间窗限制。动态数字、UUID、长十六进制标识被替换。
- 卡片显示错误日志条数、请求数、首次和最近时间。缺少关联 ID 的日志各计一次请求，无法断言属于同一次请求。
- 已审批、修复中、失败或关闭的任务不接收新证据。调查期间证据版本变化会重新排队，防止旧结果进入审批。
- 初始等待 10 秒收集证据，最多延后到任务建立后 60 秒。日志保留，不删除原始事件。没有请求 ID 时不能凭时间邻近推断请求归属。

## 调查取证范围

选最近最多 3 个请求，每个 Workspace 最多 10 个已启用 SLS 数据源，按 ID 查询前后各 5 分钟、每次最多 100 条，并再次精确过滤 ID。日志取证预算约 20 秒，包含非 error 的同请求日志；读取失败/无数据会标明。代码只用参数化 `git grep` 检索该 Workspace checkout 中受 Git 管理的源码，限制时间和大小，排除配置、secret、lock 和测试文件。总取证预算约 35 秒。按项目约束，模型只收到匹配文件的位置与行号，私有源码正文不进入提示词。

HolmesGPT 输入是有界证据快照，不执行日志或模型提供的命令。默认启动脚本禁用全部模型工具，模型依据预取证据分析。代码搜索是关键词取证，不能保证定位到实际根因；证据不足应明确说明、降低置信度并留空受影响仓库。调查成功只进入待审批，不修改代码或创建 MR。

## 本机启动

先配置 PostgreSQL、SLS 数据源和项目 checkout，再执行：

```bash
pnpm --filter @qolmesgpt/control-plane db:generate
pnpm --filter @qolmesgpt/control-plane exec prisma migrate deploy
pnpm build
# DATABASE_URL、有效模型凭据在本机环境变量中配置，不写入仓库。
# 公司源曦网关：复制模板，在本机文件中填写 Key 和模型广场的完整模型 ID。
mkdir -p ~/.config/qolmesgpt/holmes-investigation
cp -n scripts/yuanxi.env.example ~/.config/qolmesgpt/holmes-investigation/yuanxi.env
chmod 600 ~/.config/qolmesgpt/holmes-investigation/yuanxi.env
# 若当前 checkout 没有 .venv，设置 HOLMES_PYTHON 指向已安装 Holmes 依赖的 Python。
./scripts/run-local-investigations.sh
```

公司 API 文档：<https://yuanxi.xrtan.cn/user/docs?doc=api>。Base URL 为 `https://yuanxi.xrtan.cn/yuanxi/v1`，请求地址为其后的 `/chat/completions`，不重复拼接 `/v1`。源曦 Key 在公司平台的 Key 管理页面创建，模型 ID 从模型广场复制；选用支持 OpenAI Chat Completions 和严格 JSON Schema 输出的模型。配置文件包含 `YUANXI_BASE_URL`、`YUANXI_API_KEY` 和 `YUANXI_MODEL`，其中模型 ID 保留平台的完整原值，启动脚本自动添加 LiteLLM 路由所需的 `openai/` 前缀。

启动先执行公司 `/key-check`，鉴权失败即退出，避免无效 Key 继续领取调查任务。公司配置优先于继承的 `OPENROUTER_API_KEY` 等变量，三项必须同时提供；不会自动回退到其他服务。可用 `QOLMESGPT_MODEL_ENV_FILE` 指定另一份本机可信 shell 配置文件。配置修改后需重启调查脚本，再在任务详情点击“重新调查”；原 SLS 消费和 Web 服务可保持运行。

其他服务可通过 `MODEL`、`API_BASE`、`API_KEY` 显式配置；也支持 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`，以及 `MODEL=openrouter/...` 配合 `OPENROUTER_API_KEY`。使用其他服务时，将 `QOLMESGPT_MODEL_ENV_FILE` 指向对应环境文件，避免加载默认公司配置。显式 Key 不再被继承的 OpenRouter Key 覆盖。已有 OpenRouter-only 环境且没有自定义 `API_BASE` 时仍兼容原配置。

可设置 `HOLMESGPT_URL`、`HOLMESGPT_API_KEY` 连接已有 Holmes 服务；它必须限制在受信任的只读工具和当前 Workspace 的权限范围内。`QOLMESGPT_WORKSPACE_ROOT` 指向 Web 服务使用的同一个 checkout 根目录。生产必须设置相同的 `QOLMESGPT_CREDENTIAL_KEY_BASE64` 和密钥版本，不能生成另一套密钥。

Web、SLS 消费 Worker、调查 Worker 和 Holmes 服务需要分别长期运行；本机脚本随终端退出而停止，生产应交给进程管理器或容器编排。

## 验证与排错

- `pnpm lint && pnpm typecheck && pnpm test`；数据库测试使用 DATABASE_URL 创建并清理独立 schema。
- 页面选择 Workspace，卡片显示归并计数，详情显示根因、建议、引用和请求上下文；每 5 秒刷新。
- 401 通常是 Holmes 服务认证或模型凭据无效，503 是服务不可达。修正凭据并重启 Holmes 服务后，点击详情中的“重新调查”。
- 老版本未归并的待调查任务可通过 `PrismaSlsDetectionStore.reconcilePending(true)` 一次性合并。保留历史卡片 ID 和全部证据，旧卡片标记 CLOSED + mergedIntoTaskId，主列表隐藏。参数 true 纳入历史待审批任务，运行中、已审批、修复、失败或已关闭任务不改写；单次最多处理 10,000 个任务；大批历史数据应分批运行。

## Workspace 自动化开关

顶部“AI 自动读取日志”开关控制当前 Workspace 全部数据源的自动读取与 AI 调查。状态持久化在 `GroupWorkspace.automationEnabled`，通过 `POST /api/workspaces/:id/automation` 更新。暂停撤销 SLS 消费租约和调查 claim，停止新任务领取并中断进行中的模型请求；历史证据、结果、审批、来源启用时间和消费 checkpoint 保留。恢复使用原 Consumer Group 继续消费。

调查详情头部展示完整任务 ID；左栏是错误日志与同请求上下文，右栏是调查结论。暂停期间仍可查看历史数据，页面每 5 秒刷新；不会触发自动 SLS 读取或模型分析。
