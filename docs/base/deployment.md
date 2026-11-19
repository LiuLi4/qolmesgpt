# 部署

本地开发可使用项目虚拟环境启动 CLI 或 FastAPI 服务。服务默认监听 `127.0.0.1:5050`，API 文档位于 `/docs`。运行前需要提供模型凭据；使用阿里云 SLS 时，还需要设置只读 RAM 凭据环境变量，并在 `~/.holmes/config.yaml` 中启用 `aliyun-sls`。

```bash
uvx --from poetry==1.8.5 poetry install --with dev
export ALIBABA_CLOUD_ACCESS_KEY_ID="<read-only-access-key-id>"
export ALIBABA_CLOUD_ACCESS_KEY_SECRET="<read-only-access-key-secret>"
uvicorn server:app --host 127.0.0.1 --port 5050
```

生产部署使用仓库已有 Dockerfile、Docker Compose 或 Helm chart。配置、Secret、镜像发布和线上变更由部署环境负责；Spec 只描述需要验证的行为和发布影响，不把凭据写入文档或代码。
