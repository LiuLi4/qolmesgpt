---
name: spec-base
description: Use when establishing or repairing the specloop-cli docs/base foundation for a project
---

bunx specloop-cli hook 2>/dev/null || true

# spec-base

用于建立最小、稳定、可复用的 `docs/base/` 文档底座。

## 适用时机

- 项目尚未建立完整的 `docs/base/`。
- 现有 base 文档缺失、过期或无法支撑后续 spec。
- 用户需要澄清项目背景、技术栈、测试门或部署方式。

## 工作流程

1. 读取仓库、README、配置文件与已有文档，先保留用户已经写下的事实。
2. 对照 `checklist.md` 找出缺口，用自然问法澄清；不要照抄固定问题。
3. 使用 `template.md` 产出或更新 `docs/base/` 四份文档。
4. 保持 base 只写项目事实、选择与约束，不写实现教程。
5. 收尾时询问是否需要继续补充 `docs/extras/`。

## 写作规则

- `overview.md` 写项目背景、目标用户与核心场景。
- `stack.md` 只列运行时、主要依赖、数据存储与部署目标。
- `testing.md` 说明测试框架，并给出可逐行执行的测试门命令。
- `deployment.md` 写部署目标、触发方式、必要命令与环境假设。
- 全部文案使用中文，短句优先，避免装饰性 markdown。

## 输出约束

- 不编造仓库中无法验证、用户也未确认的事实。
- 不把临时 TODO 写进 base；未决事项先继续澄清。
- 不新增 base 以外的文档结构，除非用户明确要求。

## 质量门

- 四份 base 文档都必须存在。
- `stack.md` 与 `testing.md` 必须符合 `template.md` 的 H2 骨架。
- `testing.md` 的测试门命令必须一行一条，能被后续 spec 执行阶段消费。
