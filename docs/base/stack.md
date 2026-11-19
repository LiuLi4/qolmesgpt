# 技术栈

## 运行时与语言

- Python 3.10–3.13。
- Typer CLI。
- FastAPI 与 Uvicorn HTTP 服务。
- Jinja2 提示词模板。

## 主要依赖与版本

- Poetry 1.8.5 维护锁文件。
- Pydantic 2、Requests、Tenacity。
- LiteLLM 负责多模型调用。
- `aliyun-log-python-sdk==0.9.53` 负责阿里云 SLS 只读查询。
- Pytest、Ruff、mypy 负责测试与静态检查。

## 数据存储

- Holmes 配置默认位于 `~/.holmes/config.yaml`。
- 工具集配置由 YAML 加载。
- 可选 Supabase 用于项目已有的状态与技能数据能力。
- SLS、GitLab、Kubernetes 等业务数据保留在各自外部系统中。

## 部署目标

- 本机 CLI 与 FastAPI 服务。
- Docker Compose。
- Kubernetes/Helm 部署。
- 外部凭据通过环境变量、Secret 或运行环境注入，不提交到 Git。
