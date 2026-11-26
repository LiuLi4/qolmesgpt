# 任务：Workspace 仓库画布与调查分支

- [x] T1 数据迁移与兼容。Covers: REQ-001,REQ-002,REQ-008,NFR-002; Plan: P1。修改现有 apps/control-plane/prisma/schema.prisma，新增 apps/control-plane/prisma/migrations/0009_workspace_repository_groups/migration.sql（本功能新增迁移；本机已应用，不修改历史迁移）。验证迁移和生成 client。
  - S1 既有链接回填根节点、调查分支等于 Project.defaultBranch，消费开关和错误事件不变。
- [x] T2 目录与配置服务/API。Covers: REQ-001,REQ-002,REQ-008,REQ-009,NFR-001; Plan: P2；依赖 T1。修改 apps/control-plane/src/integrations/gitlab/ 下接口，新增 apps/control-plane/src/workspace/repositories.ts，修改 apps/web/src/index.ts。
  - S2 跨 Group 添加两个节点，多仓分支保存/重载；修改分支成功。
  - S3 外部用户、非当前连接/不允许项目、分支不存在、重复节点或仓库、过期配置版本拒绝，原配置不变。
  - S4 自动同步不能覆盖手动仓库列表或调查分支，目录分页完整。
- [x] T3 调查不可变代码版本。Covers: REQ-003,REQ-004,REQ-005,NFR-001,NFR-002; Plan: P3；依赖 T2。新增 apps/control-plane/src/investigation/repositories.ts；修改 apps/control-plane/src/investigation/context.ts、prisma.ts、runtime.ts 和 apps/workers/src/investigation/client.ts。
  - S5 fetch 最新 SHA，分支新增提交后重新调查看到新 SHA，本次旧快照仍读取旧 SHA；同仓不同分支隔离。
  - S6 缺失分支/权限/API失败/无 checkout 不回退，部分和全失败披露，分支/SHA 服务端 metadata 入模与保存一致；历史版本提示；无 token 泄漏。
  - S7 路径越界、符号链接、无效 ref、错误仓库来源拒绝；不改原 checkout 的未提交文件。
- [x] T4 审批边界。Covers: REQ-010; Plan: P3；依赖 T2。修改 apps/control-plane/src/approvals/prisma.ts。
  - S8 跨 Group 调查仓库不因关联 Workspace 获得修复审批资格；原 Group 权限路径继续可用。
- [x] T5 workspaces 页面与画布。Covers: REQ-006,REQ-007,REQ-008,REQ-009; Plan: P4；依赖 T2。修改 apps/web/src/ui.ts，新增 apps/web/src/workspace-designer.ts 与相应 test 文件。
  - S9 菜单名称、展开列表顶部新建、选择显示详情/切换隔离、空列表与失败状态。
  - S10 添加/编辑多个 Group 节点，逐仓分支保存并重载、失败不丢草稿、取消/关闭、异步切换防串写；脏表单轮询保留。
  - S11 浏览器真实目录/已有仓库、画布与编辑面板可操作，暂停开关不被恢复；旧调查不伪造 SHA，已有日志/卡片仍可访问。
- [ ] T6 验证审查提交与运行。Covers: REQ-001至REQ-010,NFR-001,NFR-002; Plan: P5；依赖 T1至T5。pnpm build/lint/typecheck/test、Python SLS regression、文档覆盖检查、独立 review-code、真实浏览器，签名提交并推送 origin/dev。

## 覆盖

P1→T1；P2→T2；P3→T3,T4；P4→T5；P5→T6。S1→T1，S2-S4→T2，S5-S7→T3，S8→T4，S9-S11→T5。实现后补充真实测试位置与运行证据，不以模拟成功替代真实运行。

## 场景验证映射

| 场景 | 测试或验证 |
|---|---|
| S1 | apps/control-plane/test/repository-migration.test.ts |
| S2,S3 | apps/control-plane/test/repository-config.test.ts；apps/web/test/repository-api.test.mjs |
| S4 | repository-config.test.ts 的手动配置保留/目录分页/101仓库；group-workspace.test.ts 的并发 claim |
| S5,S7 | apps/control-plane/test/repository-snapshot.test.ts 真实 Git HTTP fixture |
| S6 | aggregation.test.ts 的部分读取失败；apps/workers/test/investigation.test.ts 版本元数据与失败仓库过滤 |
| S8 | repository-config.test.ts 的跨 Group 审批拒绝 |
| S9,S10 | apps/web/test/designer.test.mjs；workspace-flow.test.mjs；repository-api.test.mjs |
| S11 | 本机 5050 浏览器验证与 API/数据库状态检查；最终结果记录在交付说明 |

旧结果不补填 SHA；自动读取开关不恢复。功能检查需在最终审查通过后才将 T6 标记完成。
