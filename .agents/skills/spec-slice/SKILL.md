---
name: spec-slice
description: Use when clarifying a user requirement and turning it into a reviewed executable specloop-cli spec
---

bunx specloop-cli hook 2>/dev/null || true

# spec-slice

用于通过问询、研究、确认与 review，把用户需求切成可执行、可测试、可归档的 spec。

## 适用时机

- `docs/base/` 已存在。
- 相关 `docs/contracts/` 与 `docs/memory/` 可以按需加载。
- 用户提出了需要澄清、研究并落成 spec 的需求。

## 工作流程

1. 先通过问询理解用户需求；需求不足以研究时继续追问，不急着写 spec。
2. 读取 `docs/base/` 四份文档与 `docs/extras/INDEX.md`、`docs/contracts/INDEX.md`、`docs/memory/INDEX.md`。
3. 按当前任务只读取必要的 contract、memory、extras，并研究代码规范、现状代码与相关实现路径。
4. 形成事实证据包：列出已读 base、contract、memory、extras、相关源码、测试与发布/打包文件；证据包用于草案确认，不写入最终 spec。
5. 围绕 `checklist.md` 澄清行为边界、失败场景、测试方式，思考最佳实践,思考我们更改后可能带来的影响,思考用户可能漏掉的细节,形成设计草案。
6. 若依赖已有 `docs/specs/` 中的前置行为，在草案与最终 `背景与目标` 中明确依赖关系。
7. 通过问答向用户确认设计；未确认前不写入 `docs/specs/`。
8. 用户确认后，开一个干净 subagent 做 spec review；只给它需求、已读事实与草案，不泄露期望结论。
9. review 无阻塞问题后，选择下一个 `NNNN-<kebab-case>` 文件名，写入 `docs/specs/NNNN-<kebab-case>.md`。
10. 每份 spec 只锁定一个稳定行为；需求较大时拆成多份 spec。

## spec 骨架

每份 spec 只包含四个 H2：

- `## 背景与目标`
- `## BDD 场景`
- `## 测试剧本`
- `## task 规划`

## 输出约束

- `背景与目标` 只写一段话，说明背景、目标与用户可观察结果。
- 若依赖已有 spec，`背景与目标` 首句说明前置 spec 或已确认行为。
- `BDD 场景` 使用 Given / When / Then 三行，场景间空行分隔。
- `测试剧本` 每条 bullet 描述一个测试点，并能对应项目测试门。
- `task 规划` 使用 GitHub checkbox，任务顺序应可执行、可中断。
- 不把实现细节扩散到无关模块。

## 质量门

- spec 文件名必须使用四位左补零的递增编号与 kebab-case 主题。
- 四个 H2 缺一不可，不能额外新增 H2。
- 行为边界、失败场景与测试方式不清楚时，先澄清再写入。
- 涉及 CLI、发布、打包、文档、持久化或外部副作用时，草案必须显式覆盖对应影响面。
- review 发现行为或测试设计问题时，修正草案；若语义变化明显，重新让用户确认。
