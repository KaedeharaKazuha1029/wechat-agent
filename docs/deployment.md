# 部署与注册

## 桥接服务

安装 Node.js 24 或更新版本，再运行 `npm ci`。启动时桥接服务管理面板仅监听 `127.0.0.1`。Linux 示例可以按以下步骤使用，也可通过自己的服务管理器注入同样的环境变量。

1. 创建独立系统用户和组 `weixin-bridge`，将代码放在 `/opt/weixin-bridge`。如果安装在其他位置，修改 systemd 的 `WorkingDirectory`，并保证服务可以从 `PATH` 找到 Node.js 24；也可覆盖 `ExecStart` 指向自己的 Node 解释器。
2. 把 `deploy/weixin-bridge.service` 安装到 systemd 单元目录。把 `deploy/bridge.env.example` 复制为 `/etc/weixin-bridge/bridge.env`，用你的公开 HTTPS 域名替换示例值。运行 `systemctl daemon-reload` 和 `systemctl enable --now weixin-bridge.service`。该单元示例的管理端口为 `17875`；直接 `npm start` 的默认端口是 `17865`。
3. 从部署者机器通过 SSH 把管理端口转发到本机同号端口，例如 `ssh -N -L 127.0.0.1:17875:127.0.0.1:17875 wechat-bridge-server`。打开面板，从微信扫码授权 ClawBot。
4. 若配 ChatGPT 插件，用反代或隧道把 `WEIXIN_BRIDGE_DOT_PUBLIC_ORIGIN` 对应的 HTTPS 域名转发到服务器的 `127.0.0.1:17866`，不要直接暴露本机管理端口。可选 `WEIXIN_BRIDGE_PUBLIC_ADMIN=1` 开启经过认证的 `/admin`，其密码由部署者在本机管理面板设置。Cloudflare Tunnel 可参考 `deploy/weixin-bridge-cloudflared.service`，使用[官方 cloudflared](https://developers.cloudflare.com/tunnel/downloads/)并在单元中指向其路径。创建自己的隧道，将其令牌存入 `/etc/weixin-bridge/cloudflare.token` 后启用该服务。

面板配置目标：`dot` 选 ChatGPT Dot，`chat` 选 ChatGPT Chat；如需 `/cloud`，再建 `cloud`，类型为「网页 Work」，关联 `chat`。`/cloud` 与 `/chat` 共享 `/mcp/chat` 的 OAuth 连接。目标和微信授权都保存在服务数据目录中。对于 `codex-local`、`claude`、`deepseek`，先在执行主机安装并登录各自的 CLI，再登记工作目录或选择 Windows Runner。

## ChatGPT 插件和 MCP

`plugins/dot` 和 `plugins/chat` 分别提供 Agent Plugins 清单及 MCP 配置。示例域名保留在源码中，可生成部署专用文件：

```sh
npm run plugin:configure -- https://bridge.example.com
```

默认输出到 `.runtime/plugins/`。发布前请使用自己实际部署的域名。也可以直接在 ChatGPT 的 Plugins 中添加自定义 MCP 服务器：

- Dot 使用 `https://bridge.example.com/mcp/dot`，普通 Chat／Work 使用 `https://bridge.example.com/mcp/chat`。
- 认证选择 OAuth（CIMD）。授权页面提示配对时，在桥接管理面板为对应目标生成一次性配对码。旧部署的 OAuth 凭据和 ChatGPT 注册 ID 不需要复制。
- 在 Dot 里订阅「微信收到任务」，或在网页 Work 对话中订阅「微信收到 Work 任务」，用事件的 `job_id` 读取和答复。网页 Work 需要工作区支持 MCP Events；普通 Chat 由用户调用待办工具领取。变更工具后在 ChatGPT 刷新插件。

参考 [官方插件打包说明](https://developers.openai.com/plugins/build/plugins)、[自定义 MCP 连接](https://developers.openai.com/plugins/deploy/connect-chatgpt)和 [MCP Events](https://developers.openai.com/plugins/build/mcp-events)。自定义服务器是私人连接，和提交到 ChatGPT 公共插件目录是不同流程。

## Windows Runner 和本地转发

1. 复制 `runner.example.json` 到 `.local/runner.json`，设置本机工作目录、令牌文件和 OpenSSH 主机别名。相对文件路径从仓库根目录解析。SSH 主机的公钥应已通过可信渠道验证，登录凭据留在 OpenSSH 配置中。
2. 自行生成 32 字节随机数并以小写十六进制保存在本机 `tokenFile`，把同一令牌安全放到 ECS 的 `/etc/weixin-bridge/runner.token`，权限 `0600`。服务端只在需要 Runner 时安装 `deploy/weixin-bridge-runner.conf` 到 `weixin-bridge.service.d/`。端口需和 JSON 设置一致。
3. 双击 `Start-WeixinBridgeRunner.cmd`。入口会启动本机回环 Runner，并用 SSH 反向转发供服务调用，同时连接管理面板。Runner 会验证令牌、运行类型和明确登记的根目录。仅使用云端 ChatGPT 的部署可省去该 Runner。

默认公共部署不配置代理。如果 Dot 签名回调需要专用出口，可用 `tools/render-xray-config.mjs` 从自己已有的 Xray 配置提取一个出站，落盘为私有文件 `/etc/weixin-bridge/dot-xray.json`。创建 `weixin-dot-xray` 系统用户及 `weixin-dot-egress` 独立组，安装[官方 Xray-core](https://github.com/XTLS/Xray-core/releases)和 `deploy/weixin-dot-xray.service`，在单元中设置自己的 Xray 可执行路径，再将 `deploy/weixin-dot-egress-xray.conf` 安装为桥接的可选 drop-in。该配置通过权限受限的 Unix socket 转发到官方 Dot 回调域。

如果需要经 Windows 上的现有 HTTP 代理，作为另一种可选部署，先在 Linux 准备同样的独立组和 `deploy/weixin-dot-egress.conf` 所示的 socket 目录。用 `deploy/weixin-dot-egress.service.conf` 代替 Xray drop-in。再配置 `.local/runner.json` 的 `dotEgress*` 字段，双击 `Start-WeixinBridgeDotProxy.cmd`。该入口通过 SSH 转发专用代理，不修改系统全局代理；不需要它时使用服务器自己的独立出口即可。
