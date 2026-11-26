# Workspace 仓库画布与调查版本

本功能在菜单 **workspaces** 中管理 Workspace；左侧列表顶部可新建，选中后右侧提供调查任务和仓库设计器。

## 配置仓库

1. 进入仓库设计器，点击 **＋ Group 仓库**。
2. 点击节点，在右侧选择当前 GitLab 连接中可访问的 Group。
3. 勾选需要调查的仓库，为每个仓库选择调查分支。多个 Group 使用多个节点；同一仓库在一个 Workspace 中只配置一次。
4. 点击 **保存配置**。服务端验证 Group、仓库、分支及访问权限；失败保留草稿。页面未完成配置加载前不能保存；保存期间编辑控件锁定。

既有 Workspace 迁移为一个根 Group 节点（含既有子 Group 仓库），调查分支初始为项目默认分支。保存手动配置后，Group 自动同步不会覆盖仓库范围和调查分支。节点可拖动，位置随配置保存。取消修改重新读取服务端配置。

## 调查代码版本

每次调查从所选分支重新 fetch，并在独立 bare Git 目录固定实际 commit SHA。代码检索直接指向该 SHA，不修改原 checkout 或修复目录。单仓权限查询到代码检索共享 20 秒预算，GitLab 查询单独限制为 10 秒，SDK 重试等待也受此限制。调查后清理临时快照；调查结果记录逐仓分支、完整 SHA、读取时间和状态。分支变化仅影响下一次调查。完整逐仓版本记录保存在任务证据；模型输入仅取前 30 条且最多 20,000 字符，并明确省略数量，避免大量失败仓库挤占日志分析预算。

无法读取分支的仓库标记 FAILED、SHA 为空；其他可用仓库继续调查，结果显示“证据不完整”。不得静默切换默认分支或使用旧缓存。历史事故提示“当前按所选分支分析”，不能据此声称已还原事故部署版本。旧调查未记录 SHA 的，显示缺少版本记录，不伪造补填。

本期仅扩展只读调查，不增加跨 Group 的修复、审批或 MR 权限。原暂停开关保持原值。

## 本机运行与验证

先配置本机环境变量 DATABASE_URL 及现有凭据存储，执行：

```bash
pnpm install --frozen-lockfile
pnpm --filter @qolmesgpt/control-plane db:generate
pnpm --filter @qolmesgpt/control-plane exec prisma migrate deploy
pnpm build
pnpm --filter @qolmesgpt/web start
```

调查服务使用同一 checkout 根目录，按 `docs/development/request-aggregation.md` 启动；无需为查看设计器开启自动日志读取。验证入口为 `http://127.0.0.1:5050/#projects`。

质量检查：`pnpm build`、`pnpm lint`、`pnpm typecheck`、`pnpm test`。数据库回归在独立 schema 中运行，Git HTTP fixture 验证最新 SHA、分支隔离、不可变取证和原 checkout 保留。
