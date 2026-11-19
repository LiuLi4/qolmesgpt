---
name: spec-execute
description: Use when launching specloop execute and reporting the observability URL and bounded CLI status
---

bunx specloop-cli hook 2>/dev/null || true

# spec-execute

用于把 `docs/specs/NNNN-*.md` 中尚未归档的 spec 交给 `specloop-cli execute` 在同一进程内持续执行，并向用户报告 observability URL、当前状态与最终结果。

## 适用时机

- `docs/base/` 已存在，尤其是 `docs/base/testing.md` 写明测试门命令。
- `docs/specs/` 下存在待执行 spec。
- 用户希望启动 execute，并获得 URL、阶段状态、失败修复提示或中断恢复指引。

## 工作流程

1. 直接启动 `bunx specloop-cli execute`，按需要传入 `--max-specs N` 或 `--max-cycles N`。
2. 等待 execute 输出本地 observability URL，并把 URL 返回给用户。
3. 继续让 CLI 在当前进程中收敛到成功、空状态、失败或中断结果；不要描述成后台 handoff。

## 使用规则

- 默认 agent 后端是 `codex`，可显式传 `--agent codex`。
- `--max-cycles` 默认 10，表示每个 spec 独立最多 10 轮 implementation/test/`codex review`；`--max-specs` 只限制本次 execute 最多完成多少个 specs，不改变每个 spec 的 cycle budget。
- 某个 spec 达到自己的 `--max-cycles` 上限仍失败时保留工作树改动，不归档、不写 memory、不提交，不回滚此前已完成 spec。
- CLI 永不 push；push、PR 与部署交给用户或其他流程。
- URL ready 前如果 execute 启动失败，不要宣称 URL 已可用；直接报告修复提示。
- TTY 中 stderr 会显示有界状态与 URL，stdout 保留最终结果；非 TTY 或 stdout 被管道消费时，stdout 的 URL 行也可直接转述。
- CLI 与 HTML 会显示 SQLite store path `.specloop/execute.sqlite` 和本次 run id；当前运行的完整 lifecycle event 保存在该 SQLite store 中，历史 run 默认按最近 25 次和 64 MiB event JSON 预算裁剪。
- 无待处理 spec 时命令成功退出。

## 输出约束

- 不绕过 execute CLI 手动归档 spec。
- 不把完整日志、测试输出、secrets 或临时失败噪音写入 memory。
- 不打开、追踪或关闭外部浏览器窗口。
- 不打印完整 prompt、response、测试输出或 agent chunk。
