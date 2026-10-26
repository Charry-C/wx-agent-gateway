# wx-agent-gateway

把微信、飞书连接到本机的 Coding Agent，在聊天窗口里操作项目、延续上下文，并接收执行结果。

网关直接调用电脑上已经安装的 Agent CLI，提供本地 Web 控制台和无界面的命令行模式。Agent 的登录、模型和计费沿用各自的配置。

```text
微信 ⇄ iLink ─────────┐
                     ├─ 本地网关 ⇄ Agent CLI ⇄ 项目文件
飞书 ⇄ WebSocket ────┘      ↑
                      Web 控制台
                   127.0.0.1:4619
```

## 功能

- **渠道接入**：微信扫码绑定；飞书扫码创建应用或手动绑定已有应用，无需部署公网回调。
- **Agent 自动发现**：识别已适配 CLI 的安装路径和版本，支持设置默认 Agent、为机器人换绑 Agent，以及在会话中切换。
- **会话管理**：保留各 Agent 的上下文，同一会话串行执行、后续消息排队，可随时停止任务或重置上下文。
- **本地控制台**：查看渠道状态、会话和运行日志，修改工作目录、任务超时、白名单等设置。
- **微信附件**：接收图片和文件，下载到本机供 Agent 读取；回复中引用的本机图片可回传至微信。
- **访问控制**：默认由首个私聊发送者绑定为所有者，也可配置发送者白名单。

## 支持的 Agent

| Agent | CLI 命令 | 会话续接 |
|---|---|---|
| Grok Build | `grok` | 支持 |
| Codex CLI | `codex` | 支持 |
| AgY | `agy` | 支持 |
| Claude Code | `claude` | 支持 |
| OpenCode | `opencode` | 支持 |
| Pi Coding Agent | `pi` | 支持 |

自动发现覆盖以上六种已适配 CLI。安装其他 Agent 后，需要先增加对应适配器才能使用。检测到可执行文件会显示「已安装」，这不代表已完成登录或模型配置。

## 环境要求

- macOS 或 Linux；当前路径发现与启动方式面向这两个平台。
- Node.js `20.19.x` 及以上的 20.x，或 `22.12.0` 及以上版本，以满足前端构建工具要求。
- npm，以及至少一个已经安装、完成登录并可在终端正常使用的 Agent CLI。
- 能访问所用渠道和模型服务的网络。

## 快速开始

下载源码后，在项目根目录执行：

```bash
npm ci
npm run build:web
npm run web
```

打开 [本地控制台](http://127.0.0.1:4619)，依次完成：

1. 在 **Agent** 页面确认本机 CLI 已识别，选择默认 Agent。
2. 在 **设置** 页面把工作目录设为希望操作的项目绝对路径。
3. 在 **渠道** 页面绑定微信或飞书。
4. 私聊机器人发送 `/status`，确认当前 Agent 和工作目录，再发送任务。

首次运行会自动创建 `data/` 和配置文件。未指定默认 Agent 时，网关按上表顺序选择第一个已安装的 Agent；未检测到任何 Agent 时保留 `grok` 占位，需要安装 CLI 后再选择。默认工作目录是启动网关时的目录。

按 `Ctrl+C` 停止服务。同一份 `data/` 同时只运行一个网关实例，避免重复处理消息。

### 微信

在控制台点击「扫码绑定」，使用微信扫码并确认授权。二维码过期后会自动刷新。

微信渠道仅绑定一个机器人。绑定后私聊机器人即可使用，会话内通过 `/agent <name>` 切换 Agent。

微信消息轮询失败时会自动重连，连续失败按 5、10、20、30 秒退避，之后最多每 30 秒重试。控制台显示「连接中」及重试信息，成功后自动恢复「在线」并清除错误；游标和 Agent 会话保留。长轮询有 90 秒请求超时，正常等待超时会继续轮询；停止服务或解绑会立即取消请求或重连等待。

### 飞书

在控制台选择「扫码添加 bot」，按页面提示创建并绑定自建应用。每个应用对应一个机器人，可添加多个机器人并分别绑定 Agent。

也可以选择「手动绑定」，填写已有应用的 App ID 和 App Secret。应用需要开启机器人能力、配置长连接事件订阅，并具备收发消息所需权限。网关通过 WebSocket 接收消息，无需公网地址。

### 命令行模式

不需要 Web 控制台时，可在终端绑定微信并启动网关：

```bash
npm run login
npm run start
```

此模式的登录命令只负责微信；启动后也会加载已经保存在 `data/bots.json` 中的渠道。与 Web 模式共用配置和会话数据。

## Agent 自动发现

检测顺序优先保留当前 `PATH`，随后补充运行 Node 的目录及常见安装位置，包括：

- `~/.local/bin`、`~/.opencode/bin`、Homebrew。
- npm、pnpm、Bun 的常见安装目录。
- NVM、FNM、Volta、asdf、mise 的常见目录或 shim。

检测和实际执行共用路径解析逻辑。Agent 页面每 30 秒更新一次，切回窗口或点击「重新检测」也会触发扫描。渠道与设置的选择列表只提供已检测到的 Agent；已有配置引用的未安装项会保留提示。

自定义安装位置可以通过环境变量指定。例如：

```bash
WX_AGENT_CLAUDE_PATH=/absolute/path/to/claude npm run web
```

| CLI | 路径覆盖变量 |
|---|---|
| `grok` | `WX_AGENT_GROK_PATH` |
| `codex` | `WX_AGENT_CODEX_PATH` |
| `agy` | `WX_AGENT_AGY_PATH` |
| `claude` | `WX_AGENT_CLAUDE_PATH` |
| `opencode` | `WX_AGENT_OPENCODE_PATH` |
| `pi` | `WX_AGENT_PI_PATH` |

变量值必须是可执行文件的绝对路径。显式指定的路径无效时，会显示未安装，不会自动换用其他版本。新增或修改启动环境变量后，需要重启网关。

也可以在终端检查发现结果：

```bash
node src/cli.js agents
```

## 聊天命令

以下命令可在微信或飞书私聊中使用：

| 命令 | 作用 |
|---|---|
| 直接发文字 | 发送任务，延续当前 Agent 的上下文 |
| `/agent claude` | 切换当前会话的 Agent，名称见支持列表 |
| `/new` | 清空当前会话保存的 Agent 上下文，下一条消息重新开始 |
| `/cwd /absolute/path/to/project` | 修改会话工作目录并重置上下文 |
| `/status` | 查看当前 Agent、工作目录、会话及任务状态 |
| `/stop` | 停止当前任务，并清空待执行消息 |
| `/help` | 查看命令帮助 |

各 Agent 的上下文分别保存，切回之前使用过的 Agent 可以继续其会话。若需要从头开始，先发送 `/new`。

Agent 的选择优先级为：**会话内选择 → 机器人绑定 → 网关默认值**。修改网关默认值不会覆盖已经绑定的机器人或已有的会话选择。

微信收到的图片和文件会保存到 `data/media/`，路径会加入任务内容。Codex 额外使用原生图片参数传入图片，其他适配器通过任务中的路径读取。Agent 回复中引用的本机图片可回传；普通文件暂不支持以附件形式回传。

## 配置

配置文件位于 `data/config.json`，首次启动自动生成。通常直接使用控制台设置即可；手动编辑文件后需要重启服务。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `defaultAgent` | 自动检测 | 选择第一个已安装的 Agent，保留已有的显式配置 |
| `defaultCwd` | 启动时的工作目录 | Agent 的默认工作目录，应指向要操作的项目 |
| `agentTimeoutMs` | `900000` | 单次任务超时，单位毫秒，默认 15 分钟 |
| `codexSandbox` | `workspace-write` | Codex 执行模式：`read-only`、`workspace-write`、`full` |
| `allowedUsers` | `[]` | 发送者 ID 白名单；为空时只允许首次绑定的所有者 |
| `replyChunkLength` | `2000` | 长文本回复的分片长度 |
| `webPort` | `4619` | 本机 Web 控制台端口，修改后需重启 |

控制台保存的配置对后续任务生效；端口修改需要重启。修改默认工作目录不会覆盖会话里通过 `/cwd` 设置的目录。

通用配置模板见 [examples/config.example.json](examples/config.example.json)。如需使用模板，先将 `defaultCwd` 替换为自己的项目绝对路径，再保存到 `data/config.json`；模板不指定 `defaultAgent`，加载时会自动检测。

### 所有者与白名单

白名单为空时，第一个私聊发送者会绑定为所有者，其他发送者被拒绝。白名单非空时，仅放行列表中的发送者 ID。该策略对网关内的所有渠道生效。

需要彻底重置时，先停止网关，再执行：

```bash
node src/cli.js clear
```

此命令会删除整个 `data/`，包括渠道绑定、配置、所有者、会话、日志和收到的附件，之后需要重新扫码绑定。

## 本地数据与源码分享

运行数据只在使用者自己的电脑上生成：

| 路径 | 内容 |
|---|---|
| `data/config.json` | 默认 Agent、个人工作目录、白名单等配置 |
| `data/bots.json` | 渠道绑定及机器人凭据 |
| `data/state.json` | 所有者、Agent 会话与消息游标 |
| `data/media/` | 接收到的图片和文件 |
| `data/gateway.log` | 网关运行日志 |

`data/`、本地开发会话、编辑器配置、`.env`、本机 npm 配置、私钥、日志、依赖和构建产物已设置相应的 Git 或归档排除规则。npm 打包采用源码白名单。

分享源码时请使用干净的源码归档，避免直接压缩整个工作目录。对于已经提交到 Git 的项目，可以从仓库根目录生成归档：

```bash
mkdir -p release
git archive --format=zip --prefix=wx-agent-gateway/ \
  --output=release/wx-agent-gateway-source.zip HEAD
```

此命令归档的是已提交的 `HEAD`，未提交的修改不会包含在内；`.gitattributes` 中的 `export-ignore` 会排除运行数据和本地文件。其他使用者需要自行安装 Agent、完成登录并绑定渠道。

## 开发与验证

```bash
npm ci
npm run dev
```

开发模式启动 Node 后端和 Vite 前端。前端默认位于 [localhost:5173](http://localhost:5173)，`/api` 和 `/ws` 代理到 `127.0.0.1:4619`。使用开发模式前，先停止正在运行的 Web 网关；若修改了后端端口，也需同步调整 `vite.config.ts` 的代理目标。

```bash
npm test             # Agent 与微信重连测试，不请求模型或微信
npm run check        # 前端 TypeScript 检查
npm run build:web    # 生成 web/dist，供 Web 网关托管
```

不经过聊天渠道，直接验证一个已登录的 Agent：

```bash
node src/cli.js agent-test claude "只回复 OK，不调用工具" --cwd "$PWD"
```

`agent-test` 会实际调用所选 CLI 和模型，可能产生相应费用。查看网关状态或仅检查微信二维码接口可达性：

```bash
npm run status
node src/cli.js login --probe
```

状态和日志可能包含本机路径、账号标识或任务内容，分享排查信息前请先脱敏。

## 项目结构

```text
src/
├── cli.js                 # 命令行入口
├── agents.js              # Agent 执行与会话续接适配器
├── agent-discovery.js     # CLI 路径发现与版本检测
├── store.js               # 配置及运行状态存储
├── core/
│   ├── router.js          # 鉴权、聊天命令、任务队列和消息路由
│   └── hub.js             # 渠道机器人实例管理
├── channels/              # 微信、飞书和登录会话实现
└── server/                # HTTP API、WebSocket 和静态页面服务
web/src/                   # React 控制台
examples/                  # 不含个人信息的配置模板
scripts/                   # 开发启动脚本
tests/                     # 自动化测试
data/                      # 本机运行数据，不分发
```

新增 Agent 时，在 `src/agents.js` 实现执行与会话协议并注册适配器；发现和选择列表会随注册表更新。新增渠道时，实现对应 provider，并在入口中注册，复用现有路由和实例管理。

## 常见问题

**安装了 CLI，但页面没有识别到。**

先运行 `node src/cli.js agents` 检查。确认 CLI 文件可执行，且位于 `PATH` 或受支持的安装位置；自定义路径使用 `WX_AGENT_<NAME>_PATH`。安装后点击「重新检测」即可，无需重新绑定机器人。

**显示已安装，但任务执行失败。**

先在终端确认该 CLI 能正常使用，再检查登录、模型配置、工作目录和权限策略。版本探测失败会单独提示；CLI 已安装并不保证模型服务可用。Claude Code 保留自身权限策略，非交互调用中需要审批的工具可能被拒绝。

**微信显示 `fetch failed` 或一直「连接中」。**

网关会自动重试消息轮询，恢复后清除错误并显示「在线」，无需因一次网络波动重新扫码。连续失败时，查看 `data/gateway.log` 中的重试记录和底层错误码（例如 `ECONNRESET`、`ENETUNREACH`、`ETIMEDOUT`），排查本机网络、DNS 或代理配置。自动重连会保留消息游标和 Agent 会话；如果渠道凭据已经失效，仍需重新绑定。

**控制台提示页面未构建。**

运行 `npm run build:web` 后刷新。源码分发不包含 `web/dist/`，首次使用需要构建。

**端口 4619 已被占用。**

检查是否已有网关或开发服务在运行，停止旧实例后再启动。不要同时运行 `npm run web`、`npm run start` 和 `npm run dev` 来处理同一份数据。

**更新代码后如何生效。**

后端变更需要重启服务；前端变更运行 `npm run build:web` 后刷新页面。依赖变化时先执行 `npm ci`。

## 使用边界

- 当前只处理私聊，微信和飞书群消息均忽略。
- 微信支持接收图片、文件及回传图片；飞书目前处理文字，视频和语音尚不支持。
- 同一会话按队列执行，回复在任务结束后发送，暂不提供流式进度；微信有「正在输入」提示。
- 首次绑定的所有者保存在网关全局状态中；未配置白名单时，各渠道都按这个发送者 ID 校验。
- 微信 iLink 和飞书扫码建应用流程依赖平台接口，接口变化可能影响登录或收发。

## 安全说明

网关会把聊天任务交给能够读取文件、修改项目和运行命令的本机 Agent。首次绑定应由预期使用者完成，并保持所有者校验或白名单开启。

Web 控制台只监听 `127.0.0.1`，校验 Host 和 Origin，写操作要求自定义客户端头。请勿通过端口转发把它暴露到公网。

Codex 默认使用 `workspace-write`，也可选择 `read-only`；`full` 会绕过其审批与沙箱。Grok 使用 `--always-approve`，AgY 使用 `--dangerously-skip-permissions`。Claude Code、OpenCode、Pi 的能力和限制还取决于各自的本机配置。

机器人凭据、个人路径、聊天内容和附件均可能包含敏感信息。不要提交或分享 `data/`，也不要将控制台截图和运行日志直接作为公开示例。

## 致谢

微信 iLink 收发逻辑和飞书扫码建应用流程参考并改写自 [zai-org/ZCode](https://github.com/zai-org/ZCode)（Apache-2.0），相关实现包括 `weixinRegistration.ts`、`weixinProvider.ts` 和 `feishuAppRegistration.ts`。微信图片收发实现也参考了 `openclaw-weixin` 的协议处理方式。
