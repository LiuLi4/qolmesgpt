# GitLab OAuth 配置

OAuth 连接前，需要在目标 GitLab 实例注册 QolmesGPT 应用。Application ID
由 GitLab 生成，不能使用自定义占位值（如 `local-web-client`）。PAT 连接不需要
OAuth 应用配置。

## 注册 GitLab 应用

1. 登录目标 GitLab，例如 `http://git.quantgroup.cn`。
2. 打开头像 → 用户设置 → 应用（Applications）。不同 GitLab 版本中页面名称
   可能是 Preferences 或 Edit profile → Applications。
3. 创建应用，名称为 `QolmesGPT Local`。
4. Redirect URI 填写 `http://127.0.0.1:5050/api/gitlab/oauth/callback`。
   如果改变服务地址或端口，也要同步设置服务端的 `GITLAB_OAUTH_REDIRECT_URI`。
5. 勾选 `api` 和 `read_user` scope。保持 Confidential（机密应用）选项时，
   需要将生成的 Secret 配置到服务端；选择非机密应用时，当前代码支持 PKCE，
   不需要 Client Secret。
6. 保存 GitLab 生成的 Application ID；机密应用还需要保存 Secret。

创建应用会为 QolmesGPT 建立 OAuth 客户端。用户仍需在授权页面同意授权；
仓库权限受该 GitLab 用户本身的权限限制。

## 本地服务配置

把配置保存在本机仓库外的私有文件中（例如 `~/.qolmesgpt/gitlab-oauth.env`），
限制文件权限为 `600`。不要把 Secret 发到聊天中或提交进仓库。

```bash
GITLAB_OAUTH_CLIENT_ID=GitLab生成的ApplicationID
GITLAB_OAUTH_CLIENT_SECRET=GitLab生成的Secret
GITLAB_OAUTH_REDIRECT_URI=http://127.0.0.1:5050/api/gitlab/oauth/callback
```

非机密应用省略 `GITLAB_OAUTH_CLIENT_SECRET`。文件使用 Node 的 env 文件格式，
无需 `export`。在项目 worktree 中构建后，用该文件重启 Web 服务：

```bash
pnpm build
export DATABASE_URL='postgresql://qolmesgpt:qolmesgpt-dev-only@127.0.0.1:5433/qolmesgpt'
pnpm --filter @qolmesgpt/web exec node --env-file="$HOME/.qolmesgpt/gitlab-oauth.env" dist/index.js
```

本地开发继续复用 `~/.qolmesgpt/credential-key-v1`。生产环境需配置
`QOLMESGPT_CREDENTIAL_KEY_BASE64`。修改环境文件后需要重启进程。

重新打开 `http://127.0.0.1:5050/#projects`，选择目标实例并点击“使用 OAuth 连接”。
OAuth 成功回调后，页面会加载已连接用户的 Group 和项目。

## 报错排查

- `GITLAB_OAUTH_NOT_CONFIGURED`：服务端未设置 Application ID，请完成以上配置。
- `unknown client`：Application ID 不属于当前 GitLab 实例，或该应用已被删除。
- 回调地址错误：GitLab 应用中的 Redirect URI 必须与服务端设置完全一致；
  `localhost` 与 `127.0.0.1` 也视为不同地址。
- Token exchange failed：检查机密应用的 Secret，以及 GitLab 的 PKCE 支持。

HTTP GitLab 实例会明文传输授权码、Token 和代码，应在已确认的可信网络中使用。

## Group Workspace

在 Web UI 选择 GitLab Group 后，QolmesGPT 会通过 Group Projects API 分页同步该 Group 及子 Group 中当前账号可访问的仓库，并把共享 SLS 数据源绑定到 Group Workspace。每个仓库仍保留独立 checkout、状态和锁，供只读调查及审批后的逐仓修复使用。

调查结果必须列出受影响仓库 ID；无法定位仓库时任务可以继续保留证据，但审批按钮保持禁用。审批后只对调查列出的仓库执行代码修改、项目测试和 MR 创建。
