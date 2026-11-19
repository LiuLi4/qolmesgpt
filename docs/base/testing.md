# 测试

项目使用 Pytest 编写单元测试和集成测试，并用项目脚本区分非 LLM 测试与 LLM 评测。新增 Toolset 应同时覆盖配置校验、健康检查、成功响应、空结果和外部 API 错误。

## 测试门命令

```bash
poetry run pytest tests -m "not llm"
```

```bash
poetry run pytest tests/plugins/toolsets/test_aliyun_sls.py -q --no-cov
```

```bash
poetry run ruff check <changed-files>
```

```bash
poetry run ruff format --check <changed-files>
```

```bash
poetry check --lock
```

```bash
make check
```
