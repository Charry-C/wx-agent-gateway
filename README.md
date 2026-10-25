# wx-agent-gateway

本地 coding agent 的 IM 接入管理台：把微信、飞书消息路由给你电脑上的终端 Agent（Grok Build / Codex CLI / AgY / Claude Code / OpenCode / Pi），回复发回 IM。支持 headless CLI 与 Web 控制台两种运行方式。微信收发协议与飞书扫码建应用流程参考自 [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0）。

```
微信 ⇄ iLink 平台 ⇄ ─┐
                      ├─ 本网关 ⇄ 本机 Agent CLI ⇄ 你的项目代码
飞书 ⇄ 长连接(WebSocket)┘        ↑
                        Web 控制台（127.0.0.1）
```

## 快速开始

```bash
cd wx-agent-gateway
npm install
npm run build:web   # 首次运行先构建 Web 控制台

# 方式一：Web 控制台（推荐）—— 网关 + 浏览器面板一体
npm run web          # http://127.0.0.1:4619 ，在页面上扫码绑定微信

# 方式二：headless CLI
npm run login        # 终端扫码绑定
npm run start        # 前台运行网关，Ctrl+C 停止
```

首次发消息的人自动绑定为**所有者**，其他账号会被拒绝。想换人：编辑 `data/config.json` 的 `allowedUsers` 或 `npm run clear` 重置。

需要 Node.js 20.19+ 或 22.12+，以及至少一个已安装并完成登录的 Agent CLI。当前面向 macOS / Linux 本地运行；每位使用者的 Agent、渠道绑定和运行数据分别在自己的电脑上生成。

## 本地配置与源码分享

首次启动会自动生成 `data/`。此目录包含机器人凭据、所有者信息、会话、个人工作目录、日志和收到的图片，只在本机使用，已排除在 Git、Git 源码归档和 npm 打包之外。请勿直接压缩整个工作目录分享。

不含个人信息的配置模板见 [`examples/config.example.json`](examples/config.example.json)。通常无需复制；若要使用模板，请先替换 `defaultCwd` 为自己的项目绝对路径，再保存为 `data/config.json`。模板没有指定默认 Agent，首次创建配置时会自动选择本机已安装的 Agent。

开发会话目录、编辑器配置、`.env`、本机 npm 配置、私钥、日志、依赖及构建产物也已加入排除规则。npm 包采用源码白名单；源码归档可在 Git 提交后通过 `git archive` 生成。当前本地运行数据不会随源码分发，其他使用者需要自行扫码绑定渠道。

## Web 控制台

- **渠道**：
  - 微信：扫码绑定 / 解绑（二维码过期自动刷新），单 bot（平台限制），会话内 `/agent` 命令切换 agent
  - 飞书：**扫码一键创建自建应用**（免开放平台手动配置）+ WebSocket 长连接收发（无需公网）；可添加多个 bot，**一 bot 绑一 agent**，随时换绑；也支持手动粘贴 App ID/Secret 绑定已有应用
- **会话**：实时会话列表（执行中任务、排队、上下文）、停止任务、运行日志
- **Agent**：自动识别本机已安装的 Grok Build、Codex CLI、AgY、Claude Code、OpenCode、Pi（路径 + 版本），一键切换默认 agent；页面每 30 秒自动更新，切回窗口或点击「重新检测」也会扫描。未安装项折叠展示，渠道与设置只提供本机已安装的选项
- **设置**：默认 agent、工作目录、超时、codex 沙箱、白名单、回复分片等

开发模式（前端热更新）：`npm run dev`（Vite 5173 起，/api 与 /ws 自动代理到本地后端）。

## Agent 自动发现

无需手动添加 Agent。检测范围包括当前 `PATH`、运行 Node 的目录、`~/.local/bin`、`~/.opencode/bin`、Homebrew、Bun、npm、pnpm、NVM、FNM、Volta、asdf 和 mise 的常见安装位置。检测和执行使用同一个绝对路径，已有 `PATH` 顺序优先。

自定义安装位置可在启动网关前设置环境变量，例如 `WX_AGENT_CLAUDE_PATH=/absolute/path/claude`、`WX_AGENT_PI_PATH=/absolute/path/pi`（其余 Agent 同理）。指定无效路径时会显示未安装，不会静默切换到其他版本。

「已安装」表示检测到可执行文件；版本探测失败会单独提示。请先在对应 CLI 完成登录和模型配置。Claude Code 保留自身权限策略，非交互运行时需要审批的工具可能被拒绝。OpenCode、Pi 同样沿用自身配置。识别仅覆盖上面列出的六种已适配 CLI；新增其他 Agent 需要增加对应协议适配器。

验证：`npm test`（隔离的模拟 CLI，不调用模型）、`npm run check`、`npm run build:web`。

## 微信里的命令

| 命令 | 作用 |
|---|---|
| 直接发文字 | 与当前 agent 对话（带上下文） |
| `/agent <name>`（如 `claude` / `opencode` / `pi`） | 切换 agent |
| `/new` | 重置上下文（换话题时用） |
| `/cwd /abs/path` | 设置工作目录（重置会话） |
| `/status` | 查看状态 |
| `/stop` | 终止正在执行的任务并清空排队 |
| `/help` | 命令列表 |

## 本地测试（不经微信）

```bash
node src/cli.js agents            # 自动检测本机 Agent、安装路径与版本
node src/cli.js agent-test grok "看一下这个项目的目录结构，一句话总结"
node src/cli.js agent-test codex "只回复:OK" --cwd "$PWD"
node src/cli.js login --probe   # 只验证 iLink 二维码接口可达
node src/cli.js status          # 查看配置与绑定状态
```

## 架构

```
src/
├── cli.js               # headless 入口：login / start / status / clear
├── server/              # Web 控制台：HTTP + WS API + 静态前端（main.js 为入口）
├── core/
│   ├── router.js        # 消息管线（渠道无关）：鉴权/命令/会话队列/agent 执行
│   └── hub.js           # bot 实例注册表：加载 bots.json、启停、状态上报
├── channels/
│   ├── weixin.js        # 微信 provider：扫码登录状态机 + iLink 长轮询 bot 实例
│   ├── feishu.js        # 飞书 provider：扫码一键建应用（device-code）+ WS 长连接 bot 实例
│   ├── ilink.js         # iLink API client
│   └── login-session.js # 渠道扫码登录会话公共基座
├── agent-discovery.js   # 检测与执行共用的本机 CLI 路径解析
└── agents.js            # agent 适配器（grok / codex / agy / claude / opencode / pi）
web/                     # 前端（Vite + React + TS + Tailwind + shadcn 风格组件）
data/                    # bots.json / config.json / state.json / gateway.log
```

- **渠道插件化**：每个渠道一个 provider（登录流程 + bot 实例）。微信为单例（平台限制）；飞书为多实例——一个自建应用一个 bot。新增渠道（如 Telegram）只需新增 `channels/xxx.js` 并在 hub 注册。
- **一 bot 一 agent**：`data/bots.json` 是 bot 实例注册表，每条 `{ id, provider, agent, credentials }`；微信单条，飞书可多条（飞书 bot 的 id 即应用 appId）。
- **飞书接入要点**：扫码建应用走 `accounts.feishu.cn` device-code 流程（PersonalAgent 模板），长连接用官方 SDK `WSClient`（启动后自动重连），发消息走 REST（tenant_access_token 鉴权，reply 接口挂原消息）。手动绑定兜底要求应用开启机器人能力、事件订阅选「长连接接收」并开通 IM 消息权限。
- **实时事件**：日志 / bot 状态 / 登录进度 / 消息收发通过 WS 推送到面板。

## 配置（data/config.json，首次自动生成）

| 字段 | 默认 | 说明 |
|---|---|---|
| `defaultAgent` | 自动检测 | 首次创建配置时选择已安装的 Agent（按 grok / codex / agy / claude / opencode / pi 顺序）；已有配置保持不变，无已安装项时保留 grok 占位 |
| `defaultCwd` | 启动时的工作目录 | 默认 Agent 工作目录，可在设置页改为任意项目绝对路径 |
| `agentTimeoutMs` | 900000 | 单次任务超时（15 分钟） |
| `codexSandbox` | `workspace-write` | codex 沙箱：`read-only` / `workspace-write` / `full` |
| `allowedUsers` | `[]` | 白名单；空 = 首个发消息者绑定为所有者 |
| `replyChunkLength` | 2000 | 长回复分片长度 |
| `webPort` | 4619 | Web 控制台端口（仅监听 127.0.0.1） |

## 安全须知（务必读）

- 网关把**在你电脑上执行任意命令的能力**暴露给了 IM 对话。务必：
  - 保持所有者绑定 / 白名单开启，不要把 `allowedUsers` 设为对陌生人开放；
  - codex 默认 `workspace-write` 沙箱（可写工作目录、限制网络外传）；grok 使用 `--always-approve`（无沙箱，能力等同你本人），敏感项目建议用 codex + `read-only`；
  - 机器人会话中的截图/记录可能包含代码内容。
- Web 控制台只监听 `127.0.0.1`：校验 Host/Origin，且写操作要求 `X-Requested-With` 自定义头（防止浏览器里其他网页跨站调用本地接口）。请勿做端口转发暴露到外网。
- `data/` 下的 `bots.json`（含 bot 凭据）等文件勿提交 git、勿分享。
- iLink 平台为无文档接口，字段变更时网关会报错而不是静默丢消息；如长期不可用考虑迁移到企业微信回调方案。

## v1 已知限制

- 微信仅支持私聊；飞书/微信的群消息均忽略（日志可见）。飞书群聊 @ 触发在规划中。
- 微信支持收发图片（CDN + AES-128-ECB，协议逆向自 openclaw-weixin）：收到的图保存到 `data/media/` 并以路径并入 prompt（codex 走 `-i` 原生图片入参）；agent 回复中引用的本机图片文件会以图片消息回传。文件/视频/语音附件仍不支持。飞书图片支持规划中。
- 同一会话串行执行：任务未结束时的新消息进入排队，`/stop` 可中断。
- 无流式进度（微信有"正在输入"，飞书暂无）；长任务请耐心等最终回复。
- 所有者全局唯一：首个向任一 bot 发消息的人绑定为所有者，跨渠道生效。

## 致谢

- 微信 iLink 收发逻辑改写自 [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0）`packages/services/src/bots/providers/weixin*`；飞书扫码建应用流程参考其 `feishuAppRegistration.ts` —— 建议给它一个 star。
