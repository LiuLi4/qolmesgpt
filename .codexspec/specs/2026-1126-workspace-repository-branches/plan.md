# 实现计划

权威：[design.md](design.md)、[spec.md](spec.md)。开发 dev，按数据库 → API → Web 实现。

1. P1 数据模型与迁移（Covers: REQ-001, REQ-002, REQ-008, NFR-002; Design: D1）：Prisma schema/migration，生成 client，迁移兼容既有 Group 及分支。
2. P2 仓库 API（Covers: REQ-001, REQ-002, REQ-008, REQ-009, NFR-001; Design: D2）：GitBeaker 项目/分支能力、配置服务与路由；授权、分页、乐观锁、跨节点重复校验、手动配置防同步覆盖。
3. P3 调查快照（Covers: REQ-003, REQ-004, REQ-005, REQ-010, NFR-001, NFR-002; Design: D3,D4）：独立 bare 快照、固定 SHA 搜索、版本 metadata 输入/结果/显示；审批边界检查。
4. P4 页面（Covers: REQ-006, REQ-007, REQ-008, REQ-009; Design: D5）：workspaces 列表、节点画布、编辑面板、分支选择与保存反馈；保留监控任务、暂停状态。
5. P5 集成与交付（Covers: REQ-001 至 REQ-010, NFR-001,NFR-002; Design: D1至D5）：数据库/真实 Git HTTP fixture/DOM 自动化/浏览器验证；build lint typecheck tests，独立审查，提交推送，启动本地服务。

## 顺序与验证

P1 → P2 → P3 → P4 → P5。使用既有 pnpm/Node 测试及 isolated PostgreSQL schema。测试应先展示缺失行为再实现。API 明确覆盖外部用户、错误连接来源、无访问项目、重复仓库、失效分支、配置版本冲突，逐项断言拒绝后旧配置不变。真实服务验证只读取目录与保存已授权配置，不恢复自动消费或触发模型调查。无需新增依赖。全仓失败时日志降级、分支移动后本次快照不变、同仓跨 Workspace 分支隔离为重点验证。
