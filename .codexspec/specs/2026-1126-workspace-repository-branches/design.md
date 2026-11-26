# 设计：Workspace 仓库配置与调查快照

权威：[spec.md](spec.md)、[requirements.md](requirements.md)。

## 数据模型（先于 API）

D1（Covers: REQ-001, REQ-002, REQ-008, NFR-002）：WorkspaceRepository 添加 investigationBranch、repositoryGroupId；新增 WorkspaceRepositoryGroup 保存 workspaceId、GitLab 外部 Group ID、名称、画布位置。GroupWorkspace 添加 repositoryConfigVersion（乐观锁）与 repositoryConfigManaged（手动配置后禁止自动同步覆盖）。迁移为既有 Workspace 创建唯一根 Group 节点，并将其原有自动纳入的直属及子 Group 仓库都关联该根节点、回填 Project.defaultBranch（不是按项目 namespace 拆节点）。迁移在人工新增跨 Group 配置前执行，无多节点歧义。，不改日志或任务。

## 组件与接口

D2（Covers: REQ-001, REQ-002, REQ-008, REQ-009, NFR-001）：WorkspaceRepositoryService 按用户与 ACTIVE 连接授权。GET /api/workspaces/:id/repository-groups 返回节点、已选仓库、分支与版本；PUT 同路径接收完整节点列表和 expectedVersion，先逐 Group/仓库/分支校验，事务 CAS 后更新链接。无删除仓库实体，只将未选链接 inactive；历史任务保留。目录 API /api/workspaces/:id/repository-catalog?groupId=&page= 返回允许的 Group 项目；/api/workspaces/:id/repository-branches?projectId=&page= 返回分支。均分页且不泄露 token。

D3（Covers: REQ-003, REQ-004, REQ-005, NFR-001, NFR-002）：调查准备读取 claim 时选定的逐仓分支配置，API 再验证项目/分支当前访问，使用参数化 git fetch --depth=1 将准确分支拉到每次调查独立 bare repo。rev-parse FETCH_HEAD 得到实际 SHA，git grep SHA 按该不可变提交搜索。禁止默认分支/缓存回退；失败产生错误状态，无 SHA。目录不含 token；禁用跨主机重定向、全局 URL 重写与 Git hooks。私有源码正文仍不进入模型。单仓超时和仓库数预算明确记录失败；失败降级继续日志调查。

D4（Covers: REQ-003, REQ-004, REQ-005, REQ-010）：服务端把 repositoryVersions、versionNotice、codeEvidenceIncomplete 注入模型输入和保存结果 evidence，前端展示；影响仓库只允许本次成功读取且仍 active 的仓库。跨 Group 仓库修复资格受原 Group 边界约束，审批明确拒绝越界仓库；未增加权限。

D5（Covers: REQ-006, REQ-007, REQ-008, REQ-009）：沿用页面 DOM，新增菜单旁 workspace-rail、详情中的调查任务/仓库设计器页签；原监控和任务卡片保留。点阵画布按持久化位置放节点，支持拖动；添加按钮创建 Group 节点草稿，点击在右侧面板编辑。脏草稿与请求序号阻止轮询/异步切换覆盖。移动端堆叠，无强制流程执行含义。

## 设计决策

- K1（Covers: REQ-003, NFR-002）：每次调查独立 bare Git 快照，避免并发 checkout 污染或覆盖修复。以实际 fetch 得到的 SHA 为准，报告记录每仓读取时刻，无全仓同时提交假设。
- K2（Covers: REQ-008, REQ-009）：DOM/SVG 专用仓库配置画布，无第三方运行时依赖；参考 xyflow/xyflow（MIT，活跃）、retejs/rete（MIT，活跃）、jagenjo/litegraph.js（MIT，维护较少）。前两者迁移成本较高，LiteGraph 完整图执行与本期不符。未复制外部代码。
- K3（Covers: REQ-010）：配置调查权限与修复权限分离；不变更原人工审批角色，跨 Group 仓库不可直接进入修复。

## 覆盖

REQ-001/002 → D1,D2；REQ-003/004/005 → D3,D4；REQ-006/007 → D5；REQ-008/009 → D1,D2,D5；REQ-010 → D4；NFR-001 → D2,D3；NFR-002 → D1,D3。
