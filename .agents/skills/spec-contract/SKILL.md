---
name: spec-contract
description: Use when turning base docs, the bundled Harness baseline, and project code into medium-grain architecture and taste invariants for later AI code generation without repeating base docs
---

bunx specloop-cli hook 2>/dev/null || true

# spec-contract

研究成可被 AI 稳定应用的 `docs/contracts/*`，让后续 spec 和实现知道这个项目的架构不变量、品味不变量、本地自由区和校验入口。

## 适用时机

- `docs/base/stack.md` 已存在。
- 用户准备进入 spec 切片或实现前，需要先沉淀项目的架构与品味规范。
- 项目需要让后续 AI 代码生成贴合技术栈、现有目录和可验证边界。
- 用户希望把原则写清楚，把可检查部分交给测试、类型、lint、结构测试或 CI。

## 工作流程

1. 先读 `references/harness-architecture.md`，把它当作 AI 写代码前的通用品味底座。
2. 再读取 `docs/base/`、相关 `extras/`、现有 `docs/contracts/`、项目目录结构和关键实现。
3. 摘出 base 已经说明的事实；不要把运行时、依赖版本、测试命令和部署目标复述进 contract。
4. 根据技术栈与代码事实，推导后续代码生成应遵守的中等颗粒度架构与品味不变量。
5. 生成少量可复用指南，而不是为每个细节拆一份规则文件。
6. 对照 `checklist.md` 补齐缺口；不足时先澄清，不硬编。
7. 产出或更新 `docs/contracts/*.md`，并区分架构不变量、品味不变量、本地自由和机械校验。
8. 完成后运行 `bunx specloop-cli hook` 重建 `docs/contracts/INDEX.md`。

## 研究原则

- 写从 base 和代码事实推导出的设计后果，不复述 base。
- 按技术栈选择表达方式；不要把通用 Harness 分层硬套到所有项目。
- 只描述架构不变量、品味不变量和贡献边界，不微观规定每个实现细节。
- 规范保持中等约束：用“应当、不应、允许例外但必须写明触发条件与校验方式”表达。
- 禁止用偏好词替代边界；例外必须写清触发条件和校验方式。
- 校验保持强约束：能交给类型、测试、lint、结构测试或 CI 的就交给工具。
- 不指定具体库，除非 base 或现有代码已经把它定为项目事实。
- 代码生成需要可操作，所以每条规范都要能影响文件组织、依赖方向、抽象选择、错误处理或测试写法。
- 审查意见、重构和用户可见 bug 应当反馈为文档更新，反复出现的漂移应当转成工具校验。
- 文档颗粒度保持中等；宁可少量完整指南，也不要大量碎片条款。

## 适合产出的指南类型

- 架构与品味规范
- 代码风格贡献指南
- 测试与校验指南
- 模块组织与依赖方向指南
- 错误处理与用户反馈指南
- 反馈闭环与漂移治理指南

## 输出约束

- 文件名使用 kebab-case，主题必须自解释。
- 文案统一中文，使用短句。
- 每份 contract 覆盖一个可被后续实现反复消费的架构或品味主题。
- 如果 base 已经写明，则只写它对代码风格和架构选择的影响。
- 如建议新增工具，必须说明它校验什么漂移，而不只是列命令。
- 不输出僵硬的打分表、禁止清单或与项目无关的通用教程。

## 质量门

- contract 之间不能互相重复同一条原则。
- contract 必须能被后续 spec 和代码生成直接消费。
- 每份 contract 都要区分“不变量”“本地自由”和“校验入口”。
- 读完后应更容易写出符合项目气质的代码，而不是只得到抽象口号。
