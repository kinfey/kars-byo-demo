# KARS BYO Agent Studio

本地运行的三运行时 Agent 工作台：Claude Code CLI、GitHub Copilot CLI 和 Codex CLI。
在同一个页面创建 Agent、构建镜像、启动独立容器、配置 MCP / Skills，并通过共享 Chat Test 进行流式对话。

## 本地启动

需要 Docker Desktop（已启动）及 Node.js 22+。

```bash
npm ci
npm run build
npm run images:build
npm start
```

打开 **http://127.0.0.1:4310**。也可以先启动页面，再逐个点击运行时的“构建镜像”。
项目 `.npmrc` 使用 Microsoft package feed 的 `/npm/` 端点。

## 中文 / English

在页面顶部选择 **中文 / English** 即可切换界面语言，默认中文。语言选择会保存在当前
浏览器中；也可以通过 `?lang=zh-CN` 或 `?lang=en` 指定语言。
切换不会重载页面，不会清空未保存的 Agent 配置、凭据输入或当前对话。
Agent 名称、用户指令、Skills 正文和模型回复保持原文，不会自动翻译。
应用自己的提示和 API 错误支持中英文；Docker / 第三方诊断日志保持原始文本。

长时间运行的文件生成任务会通过 Website 与 KARS runtime 两段心跳保持流连接。Website 不再
提前终止仍在运行的任务；runtime 默认允许 Agent 最长执行 60 分钟，可通过 `CHAT_TIMEOUT_MS`
调整为 1 分钟至 24 小时。Agent 在工作区
生成的 Word、Excel、PowerPoint、PDF、HTML、Markdown 和常见图片会作为交付物显示在回复下方：
原文件可直接下载；Office 文件会在 runtime 内转换为 PDF 进行在线预览；Markdown 会以格式化
内容渲染；HTML 在不允许脚本执行的 sandbox iframe 中预览。

KARS multi-CLI runtime 内置 Chromium 和 `curl`。`chrome`、`google-chrome`、
`google-chrome-stable` 与 `chromium` 都会通过 KARS egress proxy 访问网络，不会绕过
Sandbox 的网络治理策略。

如果浏览器与 Website 的流式连接临时中断，后台 Agent 不会被取消。页面会轮询当前 Session，
在任务完成后自动恢复最终回复和交付物；只有用户主动点击停止才会取消 runtime 任务。

runtime 会区分 CLI 的结构化工具输出和最终助手回复：工具事件默认最多 64 MiB，避免 PPT 等
长任务因被抑制的工具结果超过 4 MiB 而失败；实际发送到浏览器的助手文本仍限制为 4 MiB。
可通过 `CLI_STRUCTURED_OUTPUT_LIMIT_BYTES` 调整结构化输出预算。

Use the **中文 / English** selector in the top bar to switch the entire interface.
Chinese is the default; the browser remembers your selection. `?lang=en` and
`?lang=zh-CN` override it. Switching languages preserves unsaved configuration
and the current conversation. Agent-authored content and model responses are not
translated. API clients can select localized application feedback using the
`Accept-Language: en` or `Accept-Language: zh-CN` header.

界面采用 Azure Portal 风格的顶部栏、左侧资源导航和紧凑命令栏。字体以 Segoe UI 为首选，
不可用时使用系统字体回退；输入框与按钮使用紧凑的 Fluent 风格，支持明暗主题和移动端布局。
这只是本地应用的视觉风格，不表示应用已连接 Azure Portal 或使用 Azure 身份认证。

开发前端时，在两个终端分别执行 `npm run dev` 和 `npm run dev:web`，
然后打开 Vite 输出的本地地址。`PORT` 可修改后端端口；开发代理默认使用 4310。

## 创建 Agent

1. 选择运行时，填写名称、模型、Endpoint 和凭据。
2. 填写 Agent 指令，按需启用工具、配置 MCP 和添加 Skills。
3. 保存 Agent，构建对应镜像并启动容器，然后在共享 Chat Test 中新建 Session。
4. Session 第一条指令使用 `@Agent名称` 选择 Agent；后续不写 `@` 时沿用当前 Agent，直到 `@` 另一个 Agent。

允许不填凭据保存草稿，但这不代表已获得模型访问权限。缺少凭据时，页面会明确提示并禁用
Chat 发送。点击「配置凭据」即可补填；即使容器正在运行也能编辑，保存会移除旧容器，
保留工作区与对话记录，随后重新启动即可。系统不会自动继承宿主机已有的 CLI 登录。

编辑已有 Agent：在左侧选择 Agent，点击顶部「编辑配置」，修改后点击顶部或表单底部
「保存修改」。名称、凭据、指令、工具开关、MCP 和 Skills 均可更新；运行时类型创建后固定，
需要更换运行时请创建新 Agent。再次点击当前 Agent 不会清空未保存的修改。

| Runtime | 凭据 | 默认模型 | Endpoint |
|---|---|---|---|
| Claude Code CLI | Anthropic 兼容服务 API Key | `claude-sonnet-4-6` | `https://api.anthropic.com` |
| GitHub Copilot CLI | CLI 支持且具有 Copilot 权限的 GitHub Token | `gpt-6-astra` | 由 Copilot CLI 管理 |
| Codex CLI | OpenAI 兼容服务 API Key | `gpt-5.4` | `https://api.openai.com/v1` |

Claude Endpoint 填服务根地址，CLI 会请求 Messages API。Codex Endpoint 填包含 `/v1`
的 API 基址；服务必须支持 **Responses API**，只有 `/chat/completions` 的兼容服务不够。
模型名称必须是对应服务实际提供的模型。Copilot 使用固定的 `gpt-6-astra`，
不会在权限不足或模型不可用时偷偷切换模型。

这里的 Copilot Token 指 CLI 支持的 GitHub OAuth Token（例如 `gho_...`），或具有
**Copilot Requests** 账户权限的 fine-grained PAT（`github_pat_...`）。
不支持 classic PAT（`ghp_...`），也不是任意 OpenAI Key；
不能假定短期 Copilot 推理会话 Token 可以用于 CLI 登录。访问权限、组织策略和
`gpt-6-astra` 可用性由 GitHub 账户决定。页面不会自动读取你主机上已有的 CLI 登录凭据。

容器访问主机模型服务时，请使用 `http://host.docker.internal:<port>`，
而不是 `localhost`（容器内的 localhost 指容器自身）。远程服务优先使用 HTTPS。

## MCP、工具和 Skills

默认使用受限工具配置。启用工具代表允许 CLI 在自己的容器内自主执行命令、读写工作区并调用
配置的 MCP；这是明确的能力授权，不是只允许某一条命令的细粒度策略。
关闭开关时不加载配置的 MCP，并使用对应 CLI 的限制配置；不同 CLI 的内置工具关闭能力
并不等同，不能把“关闭开关”理解成额外的操作系统隔离边界。
外部 MCP 服务拥有自己的权限与副作用，请只接入可信服务器。

页面中的远程 MCP 配置只需填写 Streamable HTTP Endpoint 和可选 MCP Key。Key 会作为
Authorization Bearer 凭据保存，并自动转换为 Claude Code、GitHub Copilot CLI 或 Codex CLI
各自的原生 MCP 配置，不需要手写 JSON。

以下是运行时内部兼容格式示例，页面用户不需要填写：

```json
{
  "workspace": {
    "command": "node",
    "args": ["/opt/kars-byo/runtime/mcp-workspace.mjs"]
  }
}
```

远程 MCP 使用 Streamable HTTP：

```json
{
  "docs": {
    "type": "http",
    "url": "https://YOUR_MCP_HOST/mcp",
    "headers": {
      "Authorization": "Bearer YOUR_MCP_TOKEN"
    }
  }
}
```

stdio MCP 进程在 Agent 容器内运行，不是在宿主机运行。若需要额外程序，应扩展
`containers/Dockerfile` 安装；只读根文件系统下不建议在会话中临时 `npx` 下载程序。
Skill 名称使用小写字母、数字和连字符。每个 Skill 上传一个不超过 5 MiB 的 ZIP，`SKILL.md`
可直接位于 ZIP 根目录，或位于 ZIP 中唯一的顶层文件夹内；macOS 生成的 `__MACOSX` 和
`.DS_Store` 元数据不会影响该识别。ZIP 也可以包含脚本、模板和其他资源。上传后会安全解压至持久化 Agent 存储和
KARS sandbox 的 `/sandbox/agents/<agent-id>/skills/<skill-name>/`；每次对话前会重新同步，
避免 KARS Pod 重启造成文件丢失。运行时会分别映射到 Claude Code 的 `~/.claude/skills/`、
GitHub Copilot CLI 的 `<workspace>/.github/skills/` 和 Codex CLI 的 `~/.agents/skills/`。
系统会把用户填写的名称写入 `SKILL.md` frontmatter，确保三种 CLI 识别一致。Skill 是指令，
不会自动授予工具权限。
需要 CLI 主动读取并执行 Skill 工作流时，应启用工具；受限模式可能无法使用依赖工具的 Skill。

镜像固定 CLI 版本为 Claude Code `2.1.263`、Copilot `1.0.83`、Codex `0.152.0`。
Copilot 的受限工具模式使用该版本已验证的非空工具 allowlist；Codex 使用原生 feature
配置和 bundled model metadata 限制工具，因此升级 CLI 后需要同步检查适配器。
Codex 的 `exec --json` 以消息 / 工具事件粒度返回结果，不承诺每个 token 都单独推送。

## 架构与数据

项目支持 Azure 托管部署和本地 Docker 开发两种运行模式。当前 Azure 部署由
Azure Container Apps 承载 Website/control plane，由 AKS 上的 KARS Sandbox 执行 Agent。
下图使用 Markdown 纯文本绘制，不依赖 Mermaid 或其他渲染插件。

### Azure 部署架构

```text
+--------------------------- User device ----------------------------+
|                                                                  |
|  Browser                                                         |
|  +----------------------+                                        |
|  | React Agent Studio   |                                        |
|  | - Agent management   |                                        |
|  | - Session chat       |                                        |
|  | - Artifact preview   |                                        |
|  | - Disconnect recovery|                                        |
|  +----------+-----------+                                        |
+-------------|----------------------------------------------------+
              | HTTPS: JSON APIs + streaming NDJSON
              | 15-second heartbeat
              v
+-------------------- Azure Container Apps -------------------------+
|                                                                  |
|  Website / control plane (Node.js, port 4310)                    |
|  +------------------------------------------------------------+  |
|  | - Agent/provider/Skill configuration                       |  |
|  | - Session and message persistence                          |  |
|  | - Browser stream + background recovery                     |  |
|  | - Artifact metadata/preview/download proxy                 |  |
|  | - Managed Identity authentication to AKS                   |  |
|  +----------------------+------------------+------------------+  |
|                         |                  |                     |
|                         |                  +--> Azure Files       |
|                         |                       /data/agents       |
|                         |                       - configurations   |
|                         |                       - credentials      |
|                         |                       - ZIP Skills       |
|                         |                       - Sessions/history |
+-------------------------|----------------------------------------+
                          |
                          | HTTPS + Azure managed identity token
                          | Kubernetes API service proxy
                          v
+------------------------------ AKS --------------------------------+
|                                                                   |
|  KARS controller                                                  |
|  +-------------------------+                                      |
|  | KarsSandbox reconciliation|                                    |
|  | ToolPolicy + NetworkPolicy|                                    |
|  +------------+------------+                                      |
|               |                                                   |
|               v                                                   |
|  Namespace: kars-kars-sbx-coding                                  |
|  +-------------------------------------------------------------+  |
|  | KARS Sandbox Pod                                            |  |
|  |                                                             |  |
|  |  +-----------------------+   +----------------------------+  |  |
|  |  | BYO Agent container   |   | KARS governance/runtime    |  |  |
|  |  | UID 1000, read-only   |   | - inference-router         |  |  |
|  |  | root filesystem       |   | - egress guard/proxy       |  |  |
|  |  |                       |   | - network policy           |  |  |
|  |  | Node runtime :8080    |<->| - tool policy              |  |  |
|  |  |  + Claude Code CLI    |   +-------------+--------------+  |  |
|  |  |  + Copilot CLI        |                 |                 |  |
|  |  |  + Codex CLI          |                 |                 |  |
|  |  |  + Chromium / curl    |                 |                 |  |
|  |  |  + LibreOffice        |                 |                 |  |
|  |  |  + MCP clients        |                 |                 |  |
|  |  +-----------+-----------+                 |                 |  |
|  |              |                             |                 |  |
|  |              v                             |                 |  |
|  |  /sandbox/agents/<agent-id>/               |                 |  |
|  |  + workspace (generated deliverables)      |                 |  |
|  |  + home (native CLI configuration)         |                 |  |
|  |  + skills (synchronized ZIP Skills)        |                 |  |
|  +--------------+-----------------------------|-----------------+  |
+-----------------|-----------------------------|--------------------+
                  |                             |
                  | Artifact API                | Governed HTTPS egress
                  |                             | via 127.0.0.1:8444
                  v                             v
       +----------------------+      +-----------------------------+
       | Website artifact     |      | External services           |
       | proxy and browser UI |      | - Model APIs                |
       |                      |      | - GitHub Copilot            |
       | Office -> PDF        |      | - Streamable HTTP MCP       |
       | Markdown -> rendered |      | - Web pages/package feeds   |
       | HTML -> sandboxed    |      +-----------------------------+
       | Images/PDF -> native |
       +----------------------+
```

### 对话与交付物流

```text
User prompt
    |
    v
Website saves user message
    |
    v
KARS runtime launches selected CLI
    |
    +--> status events ----------------------+
    +--> assistant text                      |
    +--> 15-second heartbeats                | streaming NDJSON
    +--> generated workspace files           |
    |                                        v
    +--> artifact scan --> artifact metadata --> Browser
    |
    v
Website saves assistant response + artifact references
    |
    +--> normal connection: final "done" event
    |
    +--> interrupted connection: Agent continues in background
                               and Browser polls Session history
```

CLI 原始结构化工具输出与最终助手文本分开计量。工具结果不会发送到浏览器或写入 Session；
结构化事件默认最多 64 MiB，最终助手文本最多 4 MiB。所有交付物只能从对应 Agent 的
workspace 读取，并经过路径、符号链接、扩展名、数量和文件大小检查。

### 本地开发架构

```text
Browser
   |
   | HTTP JSON / streaming NDJSON
   v
Node control plane: 127.0.0.1:4310
   |
   +--> .data/agents/<id>/                 Agent configuration
   +--> .data/agents/.sessions/<id>/       Session history
   |
   +--> Docker CLI
          |
          +--> One isolated container and workspace volume per Agent
                 |
                 +--> Claude Code CLI --> configured Anthropic API
                 +--> Copilot CLI     --> GitHub Copilot
                 +--> Codex CLI       --> configured Responses API
                 +--> native tools + MCP + Skills
```

更细的组件说明和流程图见 **[ARCHITECTURE.md](ARCHITECTURE.md)**；其中的图同样使用
Markdown 纯文本框图。

每个 Agent 使用独立容器、独立 Docker 工作区 volume 和独立运行时 HTTP Token。
Runtime 的 8080 端口映射到主机随机 **loopback** 端口；控制台也只监听 `127.0.0.1`。
容器采用 UID 1000、只读 rootfs、可写 `/sandbox` 与 `/tmp`、禁用 Linux capabilities、
`no-new-privileges`、CPU / 内存 / PID 限额。不挂载 Docker socket 或宿主机工作目录。

Agent 配置持久化在 `.data/agents/<id>/`；每次对话作为独立 Session 持久化在
`.data/agents/.sessions/<session-id>/`，目录权限为 `0700`。
主配置文件权限 `0600`；为容器 UID 1000 提供只读 bind mount 的运行时副本为 `0644`，
仍位于 `0700` 的父目录内。凭据只在本机配置和容器运行时中使用，不进入镜像构建上下文，
也不通过进程命令行传递。**这不是密钥保险库：本机用户、Docker 管理员及启用工具的
Agent 能接触运行时凭据。MCP env / headers 同样应视为秘密配置。**

Chat 使用流式 NDJSON；工具状态与最终回答分开显示。共享 Chat Test 使用 `@Agent名称`
切换执行者，并在没有新 `@` 时沿用 Session 当前 Agent。会话历史由服务器按 Session
持久化，每轮向 CLI 重放该 Session 完整的 user / assistant 历史，工作区文件跨容器重启保留。
不是三种 CLI 原生 session ID 的互相转换。超过上下文长度上限会明确报错，不会静默丢弃历史。
取消 Chat 会终止本轮 CLI 执行；停止 Agent 不会删除工作区。

修改配置会移除旧容器，需重新启动以确保新配置生效。删除 Agent 会删除其配置，但保留已有
Session 历史与工作区 volume，避免误删对话和任务产物；确实不再需要时手动删除相应命名 volume：

```bash
docker volume ls --filter name=kars-byo-workspace-
# Review the exact volume name before removing it:
docker volume rm kars-byo-workspace-AGENT_UUID
```

不要把控制台直接暴露到公网。它是单机、单用户开发工作台，没有多用户登录、RBAC、
远程 Docker TLS 或面向生产的密钥管理。

## 与 Azure/kars BYO 的关系与边界

本项目参考上游 BYO quickstart 的镜像和 HTTP 适配模式，采用
`org.kars.runtime.contract=v1` label、UID 1000、`/sandbox`、`/tmp`、8080 端口，
校验 `SANDBOX_NAME` / `KARS_RUNTIME_CONTRACT_VERSION`。

项目保留 `local-direct` Docker 开发编排；该模式不是 `kars dev`，没有启动 KARS
controller、inference-router 或 Kubernetes。Azure 部署则使用真正的 AKS KARS
`KarsSandbox` BYO runtime，并启用 KARS network policy、egress proxy 和 ToolPolicy。
当前 CLI 仍通过各自原生协议连接配置的模型服务；不要把 BYO runtime 接入等同于已经采用
KARS 的全部可选能力，例如 Token Budget、Content Safety、完整 `/agt/evaluate` 工具评估
或跨 Agent 的 AgentMesh 编排。
镜像 label / CR 的 strict admission 通过并不代表已实现整个 runtime plugin contract。

上游 KARS 的 BYO 接入用 `KarsSandbox.spec.runtime.kind: BYO` 和
`spec.runtime.byo.image / contractVersion` 选择镜像。若迁移到真正的 kind / AKS KARS：

1. 先部署上游 KARS，启用 `controller.byoStrict=true`，推送三个镜像到自己的 registry。
2. 根据对应版本的 CRD 与 controller 实现，为 wrapper 挂载 Agent 配置及可写工作区。
3. Claude / Codex 推理分别改为 router 的 `/anthropic` 和 `/v1` 基址，凭据只交给 router。
4. 为 CLI 的每次工具执行接入 `/agt/evaluate`，MCP 经 router `/mcp`；
   不可仅改 Endpoint 就宣称实现了完整治理。
5. Copilot CLI 原生 Token 登录与其网络调用需单独验证受控 egress / proxy 的兼容性。
   不应假定它与一个可以任意替换 OpenAI base URL 的客户端相同。

这些集群接线仅用于 Azure 部署，不会在 `local-direct` 模式中自动启动。

参考：

- https://github.com/Azure/kars
- https://github.com/Azure/kars/tree/main/examples/byo-quickstart
- https://github.com/Azure/kars/blob/main/docs/runtimes/CONTRACT.md
- https://github.com/Azure/kars/blob/main/docs/operations/byo-strict.md

上游 quickstart README 使用 `k8s/karssandbox.yaml`，但当前 main 中示例文件仍名为
`k8s/clawsandbox.yaml`；应以实际文件及内容为准，不依赖过时路径。
