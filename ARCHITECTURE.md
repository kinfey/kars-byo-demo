# KARS BYO Agent Studio 架构 / Architecture

本文使用 **Markdown + 纯文本框图**，无需图表插件或渲染服务。
描述的是当前已实现的 **local-direct 本地 Docker 架构**，不是完整 KARS Kubernetes 平台。

## 1. 总体架构 / System overview

```text
                     +----------------------------------------+
                     | Browser: Agent Studio                  |
                     | React UI / Chinese + English           |
                     | Agent editor / MCP / Skills / Chat     |
                     +-------------------+--------------------+
                                         |
                          HTTP JSON / streaming NDJSON
                          Accept-Language: zh-CN | en
                                         |
                                         v
                     +----------------------------------------+
                     | Local Node.js control plane            |
                     | http://127.0.0.1:4310                   |
                     |                                        |
                     | Static UI + REST API                   |
                     | Agent CRUD + lifecycle + chat routing  |
                     | Secret handling + localized feedback   |
                     +--------+-------------+-----------------+
                              |             |
                 config / chat|             |docker CLI
                              v             v
                +-------------------+  +-----------------------+
                | Local file store  |  | Docker Engine         |
                | .data/agents/     |  | Build / Run / Stop / Rm|
                +-------------------+  +-----------------------+

                     Node control plane
                              |
               Authenticated HTTP to each runtime
               127.0.0.1:<random-port> -> container:8080
                              |
             +----------------+----------------+
             |                |                |
             v                v                v
    +----------------+ +----------------+ +----------------+
    | Agent A        | | Agent B        | | Agent C        |
    | Claude image   | | Copilot image  | | Codex image    |
    | Runtime wrapper| | Runtime wrapper| | Runtime wrapper|
    | Claude Code CLI| | Copilot CLI    | | Codex CLI      |
    +-------+--------+ +-------+--------+ +-------+--------+
            |                  |                  |
            v                  v                  v
    +----------------+ +----------------+ +----------------+
    | Anthropic-     | | GitHub Copilot | | OpenAI-        |
    | compatible API | | service        | | compatible API |
    | Messages API   | | gpt-6-astra    | | Responses API  |
    +----------------+ +----------------+ +----------------+
```

图中的 A / B / C 是三种运行时实例示意，不是只能创建三个 Agent。
**镜像按运行时复用，容器和工作区按 Agent 隔离**；同一运行时可以创建多个 Agent。
Node 控制平面运行在宿主机上；macOS 下，Docker 容器由 Docker Desktop 的 Linux VM 承载。
Docker Engine 管理这些容器，不承担模型推理或 Chat 协议转换。

| 层级 | 职责 | 对应实现 |
|---|---|---|
| Web UI | 中英文切换、编辑配置、容器操作、Chat | `web/src/main.jsx` |
| Portal 风格 | Segoe UI 优先字体、顶部栏、导航、命令栏、响应式布局 | `web/src/portal.css` |
| UI 国际化 | 文案目录、语言偏好、页面语言和时间格式 | `web/src/i18n.js`、`web/src/i18n.jsx` |
| 控制平面 | REST API、并发操作限制、会话转发、持久化 | `server/index.mjs` |
| Docker 编排 | 构建镜像、创建和停止容器、健康检查 | `server/docker.mjs` |
| 配置与数据 | 输入校验、Agent 配置、Chat 历史 | `server/config.mjs`、`server/store.mjs` |
| API 国际化 | `Accept-Language`、应用错误和状态文案 | `server/i18n.mjs` |
| 运行时适配 | HTTP 鉴权、CLI 子进程、流式事件归一化 | `runtime/server.mjs`、`runtime/adapters.mjs` |
| MCP 示例 | 工作区目录列表、受路径限制的文件读取 | `runtime/mcp-workspace.mjs` |
| 容器镜像 | 按运行时安装 CLI，设置用户和目录 | `containers/Dockerfile` |

## 2. 单个 Agent 容器 / Inside one Agent

```text
  Host configuration                         Docker persistent volume
  .data/agents/<agent-id>/                    kars-byo-workspace-<agent-id>
  runtime-config.json                                      |
            |                                              |
            | read-only bind mount                         | read/write
            v                                              v
  +------------------------------------------------------------------+
  | Agent container                                                  |
  | UID 1000 / read-only rootfs / no Docker socket                    |
  |                                                                  |
  | /run/agent/config.json                   /sandbox                 |
  |   runtime + model + endpoint              +-- home/               |
  |   provider credential + runtimeToken      |   native CLI config   |
  |   instructions + tools + MCP + Skills     |   native Skills       |
  |                 |                        +-- agent/              |
  |                 v                            workspace files     |
  |   +----------------------------+             CLAUDE.md / AGENTS.md|
  |   | HTTP runtime wrapper :8080 |                      ^          |
  |   | GET /healthz               |                      |          |
  |   | POST /chat + Bearer token  |                      |          |
  |   +-------------+--------------+                      |          |
  |                 | spawn(argv, env, stdin)             |          |
  |                 v                                     |          |
  |   +----------------------------+                      |          |
  |   | Selected CLI agent loop    |<---------------------+          |
  |   | Claude / Copilot / Codex    |                                 |
  |   +-----+---------------+------+                                 |
  |         |               |                                        |
  |         | tools enabled | stdio MCP                              |
  |         v               v                                        |
  |   +-------------+ +----------------------+                       |
  |   | Native tools| | Local MCP subprocess |                       |
  |   | Files/Shell | | workspace_list / read|                       |
  |   +-------------+ +----------------------+                       |
  |                                                                  |
  | Writable scratch: /tmp (tmpfs)                                    |
  +------------------------------------------------------------------+
            |                                  |
            | model API                        | Streamable HTTP MCP
            v                                  v
   +--------------------+             +------------------------+
   | Configured provider|             | External MCP server    |
   +--------------------+             +------------------------+
```

模型 API 和远程 MCP 由 CLI 发起请求，**不会经过 Node 控制平面代理推理**。
“启用工具”允许 CLI 在容器内自主使用配置的工具；关闭时使用对应 CLI 的受限配置，
并且不加载配置的 MCP 服务。

Skills 是写入原生目录的 `SKILL.md` 指令文件，不是独立的网络服务，也不会自动授予工具权限。
需要读取文件或执行流程的 Skill，仍受 CLI 的工具能力限制。

| 运行时 | 模型认证 | 原生 MCP 配置 | Skill 路径 |
|---|---|---|---|
| Claude Code | `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` | `/sandbox/home/.claude/mcp.json` | `/sandbox/home/.claude/skills/` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN`，固定模型 `gpt-6-astra` | `/sandbox/home/.copilot/mcp-config.json` | `/sandbox/agent/.github/skills/` |
| Codex | `OPENAI_API_KEY` + 自定义 Responses provider | `/sandbox/home/.codex/config.toml` | `/sandbox/home/.agents/skills/` |

## 3. 创建、编辑和启动 / Configuration lifecycle

```text
  Choose runtime + configure Agent
                  |
                  v
  POST /api/agents  or  PUT /api/agents/<id>
                  |
                  v
  Validate configuration ----------------------> Return field error
                  |
                  v
  Save local configuration
  [Updating an Agent removes its old container]
                  |
                  +-------------------------------+
                  |                               |
                  v                               v
  Runtime image already available?      Missing provider credential?
       |                     |                    |
      yes                    no                   v
       |                     |             Draft / Chat disabled
       |                     v             Add credentials and save
       |     POST /api/images/<runtime>/build
       |                     |
       |              Docker build
       |              NDJSON build logs -> UI
       |                     |
       +---------------------+
                  |
                  v
  POST /api/agents/<id>/start
                  |
                  v
  Mount config + attach workspace volume
                  |
                  v
  Start wrapper -> generate native CLI config / instructions / Skills
                  |
                  v
  GET /healthz -> container ready
                  |
                  v
  Chat requires BOTH running container AND configured credentials
```

未填写凭据也可保存草稿和启动容器进行健康检查，但不能发送真实 Chat 请求。
配置了凭据也不代表凭据有效或账户有模型权限，最终结果由提供方返回。
更新配置后需重新启动容器；运行时类型固定，切换运行时应创建新 Agent。

## 4. 对话数据流 / Chat data flow

```text
  Browser               Control plane              Runtime wrapper         CLI
     |                        |                           |                  |
     | POST /agents/<id>/chat |                           |                  |
     | { prompt }             |                           |                  |
     +----------------------->|                           |                  |
     |                        | Validate ready / not busy |                  |
     |                        | Load history; save prompt |                  |
     |                        |                           |                  |
     |                        | POST /chat + runtimeToken |                  |
     |                        | { prompt, history }       |                  |
     |                        +-------------------------->|                  |
     |                        |                           | Auth / busy gate |
     |                        |                           | Native config    |
     |                        |                           | Spawn CLI        |
     |                        |                           +----------------->|
     |                        |                           |                  |
     |                        |                           |    Model API     |
     |                        |                           |    Tools / MCP   |
     |                        |                           |    Skills/files  |
     |                        |                           |                  |
     |                        |                           |<-----------------+
     |                        |                           | Native JSONL     |
     |                        |<--------------------------+                  |
     |                        | NDJSON: status/text/error |                  |
     |<-----------------------+                           |                  |
     | Render incremental UI  |                           |                  |
     |                        | Save answer / error       |                  |
     |<-----------------------+                           |                  |
     | done                   |                           |                  |
```

浏览器的实际 Chat 路径包含 `/api` 前缀：`/api/agents/<id>/chat`。
运行时将不同 CLI 的输出转换成统一的 `status`、`text`、`error`、`done` 事件。
Claude / Copilot 可输出文本增量；Codex `exec --json` 主要是消息与工具事件粒度。
发生错误时显示错误，不把失败包装成成功回复。

```text
  Cancel generation
       |
       v
  POST /api/agents/<id>/cancel
       |
       v
  Control plane aborts runtime HTTP request
       |
       v
  Runtime detects disconnect
       |
       v
  Terminate CLI process group, including MCP descendants
       |
       v
  Save partial answer / cancellation status; keep workspace
```

每轮对话重放已保存的 user / assistant 历史，而不是跨 CLI 共用原生 session ID。
同一个 Agent 同时只执行一轮对话；不同 Agent 使用各自的容器和工作区。
历史超过上限会明确报错，不会静默截断。

## 5. 数据与凭据 / Data and credential boundaries

```text
  Browser
    +-- localStorage: language preference only
    +-- unsaved form / credentials: in-memory state
    +-- displayed chat: fetched from control plane

  Host: .data/agents/<agent-id>/
    +-- config.json          Agent settings + secrets + runtimeToken
    +-- runtime-config.json  Read-only mount source for the container
    +-- messages.json        User / assistant / application error history

  Docker: kars-byo-workspace-<agent-id>
    +-- /sandbox/home/       CLI configuration + runtime state
    +-- /sandbox/agent/      Workspace + generated instruction files

  Agent container
    +-- /run/agent/config.json    Read-only configuration mount
    +-- CLI environment          Provider key / GitHub token
    +-- /tmp                     Temporary data, not durable storage
```

| 操作 | Agent 配置与对话 | Docker 工作区 |
|---|---|---|
| 切换中英文 | 保留；用户内容不翻译 | 不受影响 |
| 取消生成 | 保存已收到的部分回复和取消状态 | 保留 |
| 停止容器 | 保留 | 保留 |
| 编辑并保存 | 更新配置，保留历史 | 保留；旧容器移除 |
| 删除 Agent | 删除配置和对话记录 | **保留 volume**，需单独确认清理 |

主机配置目录权限为 `0700`，主配置为 `0600`；容器挂载副本为 `0644`，仍处于受限父目录内。
模型凭据和 runtimeToken 不回显在普通 Agent API 响应中，但本地配置不是密钥保险库。
Docker 管理员和具有容器工具访问能力的 Agent 仍可能接触运行时凭据。

## 6. 与完整 KARS 的边界 / KARS integration boundary

```text
  CURRENT: local-direct

  Browser -> Node control plane -> BYO-shaped Docker container -> Provider
                                             |
                                             +-----------------> MCP

  NOT IMPLEMENTED HERE: full governed KARS deployment

  KarsSandbox CR -> KARS controller -> Sandbox pod
                                          |
                               +----------+-----------+
                               | Agent runtime        |
                               |       |              |
                               |       v              |
                               | Inference router     |
                               | + policy enforcement |
                               +----------+-----------+
                                          |
                                          v
                                    Provider / MCP
```

当前实现复用的是 BYO 镜像约定和适配思路：UID 1000、只读 rootfs、可写 `/sandbox` 与 `/tmp`、
8080 端口、`org.kars.runtime.contract=v1` label，以及 Agent 范围和版本环境变量。

**当前没有运行 KARS controller、inference-router、egress-guard、AgentMesh 或 Kubernetes。**
没有完整的统一工具治理、Token Budget、Content Safety、零凭据 Agent 或可验证审计。
不能把“满足镜像形态”理解为“已经接入整个 KARS runtime contract”。
Copilot CLI 的 GitHub 路由也不能直接等同于可任意替换 Base URL 的 OpenAI 客户端。

详见 [README 中的 KARS 接入边界](README.md#与-azurekars-byo-的关系与边界)。
