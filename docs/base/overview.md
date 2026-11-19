# QolmesGPT

QolmesGPT 是 HolmesGPT 的二次开发项目，用于连接 Kubernetes、指标、日志、链路、数据库和外部运维系统，帮助工程师定位线上问题并给出可验证的排查结论。当前项目正在接入阿里云 SLS staging 日志，后续目标是关联项目 GitLab 仓库，在人工审批后修改代码、提交 MR 并验证修复。

核心场景是：用户通过 CLI 或 HTTP 服务提出故障问题，HolmesGPT 调用已启用的 Toolset 查询证据，经过模型分析后返回诊断结果。外部系统写操作必须保持显式审批边界。
