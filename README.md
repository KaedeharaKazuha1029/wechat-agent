# WeChat Agent

自托管的个人微信桥接。它把一个已授权的微信 ClawBot 私聊接到 ChatGPT Dot、ChatGPT Chat／Work，以及可选的本机 Codex、Claude Code 和 DeepSeek Harness。它使用腾讯 iLink 通信协议，无需运行 OpenClaw。

| 微信指令 | 去向 |
| --- | --- |
| `/dot 消息` | 触发 Dot 订阅的 MCP 任务并回微信。Dot 可主动发给绑定用户，并将多条内容分别发送。 |
| `/chat 消息` | 放入普通 Chat 的私有收件箱，等待主动领取。`/chat new` 开一个新的桥接收件箱。 |
| `/cloud 消息` | 触发网页 ChatGPT Work 订阅。与普通 Chat 复用同一个 OAuth 插件，无需 OpenAI API 密钥。 |
| `/codex`、`/cc`、`/dsh` | 按目标配置切换到 Codex Local、Claude Code 或 DeepSeek Harness。 |
| `/agents`、`/status` | 列出目标、查看最新任务。`/to 别名 消息` 仅指定本条消息的去向。 |

普通 Chat 需要在会话中调用 MCP 才会处理待办。Dot 和 Work 使用 MCP Events，由 ChatGPT 运行订阅的任务。`/cloud` 不操作 Codex Cloud 网页任务。微信主动消息依赖服务端仍认可绑定会话的回复上下文。

## 本地演示

需要 Node.js 24 或更新版本。演示使用模拟微信和模拟 Agent，无需账号。

```sh
npm ci
npm run demo
```

打开 [本机演示面板](http://127.0.0.1:17865/)。正式部署、绑定微信、注册 ChatGPT 插件和启动 Windows Runner 见 [部署与注册](docs/deployment.md)。

```sh
npm test
```

测试覆盖微信模拟协议、OAuth、事件订阅与回复、队列隔离、本机 Runner 适配以及管理后台。仓库提供独立的 Dot、Chat／Work 插件模板。ChatGPT 中登记的连接、OAuth、微信状态、部署节点和用户数据由部署者管理。

本项目使用 [MIT 许可证](LICENSE)。微信通信实现参考腾讯的 [OpenClaw 微信插件及协议文档](https://github.com/Tencent/openclaw-weixin)，没有捆绑腾讯插件、代理软件或第三方二进制。
