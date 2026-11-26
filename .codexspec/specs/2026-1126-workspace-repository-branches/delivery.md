# 交付：Workspace 仓库画布与调查分支

Status: Complete（2026-11-26 Asia/Shanghai）。开发分支 `dev`；实现提交 `b886b1d78b3da1bba628284fd4da3860307b9370`，已推送 `origin/dev`；master 未修改。

## 实现

- workspaces 菜单展开列表，顶部新建；所选 Workspace 右侧显示调查任务和仓库设计器。
- Group 节点可选择现有 GitLab 连接内有权限的跨 Group 仓库，逐仓配置一个调查分支；保存原子校验、版本冲突拒绝、同步不覆盖手动配置。
- 调查重新读取所选分支，在独立 bare Git 快照固定实际 SHA；结果逐仓记录分支、SHA、读取时间和状态。失败保留安全分类、无缓存或默认分支回退，并披露证据不完整和历史版本局限。
- 数据迁移兼容既有仓库；跨 Group 调查不扩展修复或审批权限。模型侧取证有界；凭据重定向、超时、同步租约、旧任务兼容和 SLS Trace 必需标识均有回归覆盖。

## 验证

- `pnpm build`、`pnpm lint`、`pnpm typecheck`、`pnpm test` 全部通过：108 项 Node 测试，0 失败、0 跳过；数据库场景使用独立 schema。
- `pnpm --filter @qolmesgpt/control-plane db:validate` 通过；新增迁移已在本机应用。
- `.venv/bin/python -m pytest tests/plugins/toolsets/test_aliyun_sls.py --no-cov -q`：7 项通过。
- 文档覆盖检查包含全部 13 条已确认需求。独立主审及高风险专家完成，最终完整门禁 PASS：45 项文件、20 个契约、19 个分区，0 遗留缺陷或维护待办。
- 门禁指纹：`sha256:802f872e8dbbbbdac3aeb8184b67fae08fb0f5f7c3b1954cae1cc872d6287881`。完整审查记录存于本机 CodexSpec 外部缓存；提交前另移除一个冗余 EOF 空行，并重跑 Web 构建、检查和 19 项界面回归，行为未变。

## 本机运行

入口：<http://127.0.0.1:5050/#projects>。Web 与数据库连接正常，HolmesGPT `5051/healthz` 返回 healthy；Web、SLS Worker、调查 Worker 和 HolmesGPT 使用主 checkout 的最新代码。

真实页面已验证既有仓库加载、分支配置保存与重载、另一个 Group 的目录读取以及取消修改；实际 GitLab 所选 dev 分支快照返回 READ 和完整 SHA。验证没有调用模型或写入调查任务。自动读取与 AI 分析保持原暂停状态；查看和编辑仓库配置不会恢复自动化。
