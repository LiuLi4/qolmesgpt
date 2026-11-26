# 已确认需求：Workspace 多仓库调查分支与代码版本追溯

**Feature ID**: `2026-1126-workspace-repository-branches`
**Status**: Confirmed
**Last Confirmed**: 2026-11-26 Asia/Shanghai
**开发分支**: `dev`，完成后推送至 `origin/dev`。

## 权威与历史衔接

- 只有 `Status: confirmed` 条目是后续规格、设计和实现的绑定输入；待定项不得隐式升级为已确认需求。
- 本需求扩展现有 Group Workspace 的调查仓库范围，关联既有 [Workspace 需求](../2026-1119-14537g-web-workspace-log-monitoring/requirements.md) 的 NEED-009、CON-006 和 DEC-014。
- 原先仓库仅限 Workspace 所属 Group 及子 Group 的范围限制由 NEED-001 替代；不取消既有 Workspace、日志数据源绑定、仓库独立性、人工审批或访问控制约束。
- 本需求仅确认调查使用的仓库、分支和代码版本，不隐含改变既有 Group 自动纳入仓库的行为，也不把跨 Group 调查权限解释为跨 Group 修复权限。

## 需求

### NEED-001：Workspace 添加多个跨 Group 仓库

- **Status**: confirmed
- **Statement**: 用户可通过 Web UI 为 Workspace 添加多个 GitLab 仓库，包含同一现有 GitLab 连接内、当前用户有访问权限的跨 Group 仓库；不再仅限 Workspace 原所属 Group 及其子 Group。
- **User Evidence**: “Workspace 可添加多个 GitLab 仓库”；仓库范围选择“允许添加当前用户有权限的跨 Group 仓库”。
- **Confirmed At**: 2026-11-26 Asia/Shanghai

### NEED-002：每仓独立指定调查分支

- **Status**: confirmed
- **Statement**: 每个 Workspace 仓库可独立指定和修改用于调查的分支。同一仓库在同一 Workspace 中只配置一个调查分支。
- **User Evidence**: “每个仓库指定用于调查的分支”；确认“每仓单分支”边界。
- **Confirmed At**: 2026-11-26 Asia/Shanghai

### NEED-003：调查读取最新提交并逐仓记录实际版本

- **Status**: confirmed
- **Statement**: 每次调查读取各仓库所选分支当时的最新提交；在该次调查中固定使用已读取的提交，避免分析过程中混用分支后续变化。调查结论逐仓记录分支、实际读取的完整 commit SHA 和读取状态，能够追溯结论实际依据的代码版本。重新调查时再次读取所选分支最新提交，并记录该次实际读取的 SHA。
- **User Evidence**: “调查时读取该分支最新代码，并在结论中记录实际读取的 commit SHA”；已确认汇总“该次调查固定使用这份代码，结论逐仓记录分支、实际读取的完整 commit SHA 和读取状态”。
- **Confirmed At**: 2026-11-26 Asia/Shanghai

## 约束

### CON-001：部分读取失败时披露证据缺口

- **Status**: confirmed
- **Statement**: 仓库访问权限失效、所选分支删除或 GitLab 不可达等情况导致读取失败时，继续分析可用仓库；结论明确列出读取失败的仓库，并标记“证据不完整”。不得静默切换默认分支或使用旧缓存冒充最新代码，不得为读取失败项填入虚构的 commit SHA。
- **User Evidence**: 选择“继续分析可用仓库，明确列出读取失败的仓库，并将结论标记为证据不完整”；确认两种方案均不静默回退。
- **Confirmed At**: 2026-11-26 Asia/Shanghai

### CON-002：历史事故的版本局限必须可见

- **Status**: confirmed
- **Statement**: 历史事故对应其他代码版本，或无法确认事故代码与本次实际读取版本一致时，结论提示“当前按所选分支分析”，并列出实际读取的分支和 commit SHA。不得暗示已还原事故发生时的代码，也不得把当前分支分析结果冒充对事故版本的确定性结论。
- **User Evidence**: “历史事故若对应其他代码版本，应提示‘当前按所选分支分析’，不能假装还原了当时版本”；已确认汇总中的无法确认版本一致时提示规则。
- **Confirmed At**: 2026-11-26 Asia/Shanghai

### CON-003：复用现有 GitLab 连接及访问权限

- **Status**: confirmed
- **Statement**: 本期跨 Group 添加限定在现有 GitLab 连接内；仓库添加和读取须遵守当前用户访问权限，不能因同属 Workspace 而扩大 GitLab 授权。调查只读，现有凭据保护规则继续适用。
- **User Evidence**: 已确认“现有 GitLab 连接”边界及“当前用户有权限”的仓库范围。
- **Confirmed At**: 2026-11-26 Asia/Shanghai

## 不在本期范围

### OUT-001：按事故时间自动还原部署版本

- **Status**: confirmed
- **Statement**: 不实现根据事故时间自动推断或还原当时部署的代码版本；本期分析版本由用户选择的调查分支及该次调查实际读取的 commit SHA 确定。
- **User Evidence**: 已确认汇总“不实现根据事故时间自动还原部署版本”。
- **Confirmed At**: 2026-11-26 Asia/Shanghai

### OUT-002：扩展代码修改、MR 创建或审批权限

- **Status**: confirmed
- **Statement**: 本期不扩展代码修改、MR 创建或审批权限；添加跨 Group 仓库用于调查，不自动授予修改、推送、创建 MR 或审批跨 Group 仓库的能力。
- **User Evidence**: 已确认“本期不扩展修复审批权限”以及汇总中“不扩展代码修改、MR 创建或审批权限”的边界。
- **Confirmed At**: 2026-11-26 Asia/Shanghai

## 开放问题

无阻塞规格生成的开放问题。Web UI 入口布局、Git 同步及快照隔离方式、持久化结构、全部仓库均无法读取时的状态表达留待规格与设计细化；不得将其解释为允许缓存回退、虚构代码依据或扩展权限。涉及新的产品取舍时应单独澄清。

## 确认记录

### 2026-11-26 Asia/Shanghai

- **提出的汇总**: 跨 Group 多仓库、每仓独立调查分支、每次读取最新提交并固定调查版本、逐仓记录分支/SHA/读取状态、部分失败继续并披露缺口、历史版本局限提示；每仓单分支、现有 GitLab 连接、本期不扩展修复审批权限；不自动还原事故部署版本。
- **用户确认**: “确认上述需求及三项边界，写入 requirements.md”。
- **已确认条目**: NEED-001、NEED-002、NEED-003、CON-001、CON-002、CON-003、OUT-001、OUT-002。
- **阶段边界**: 仅生成 requirements.md；不生成 spec.md，不实现功能，不开启暂停中的自动日志读取或 AI 调查。
