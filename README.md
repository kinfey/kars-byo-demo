# KARS BYO Agent Studio

**English** | [简体中文](README.zh.md)

An Agent workspace for three runtimes: Claude Code CLI, GitHub Copilot CLI, and Codex CLI.
Create Agents, configure MCP servers and Skills, and run streaming conversations from one UI.
The project supports both local Docker development and an Azure deployment backed by AKS/KARS.

## Local setup

Docker Desktop and Node.js 22 or later are required.

```bash
npm ci
npm run build
npm run images:build
npm start
```

Open **http://127.0.0.1:4310**. You may also start the UI first and build each runtime image
from the application. The project `.npmrc` uses the Microsoft package feed npm endpoint.

For frontend development, run `npm run dev` and `npm run dev:web` in separate terminals,
then open the address printed by Vite. Set `PORT` to change the backend port; the development
proxy uses port 4310 by default.

## Language support

Use the **中文 / English** selector in the top bar to switch the interface. Chinese is the
default, and the browser remembers the selection. The `?lang=en` and `?lang=zh-CN` query
parameters override the saved preference.

Changing languages does not reload the page or discard unsaved Agent configuration,
credential input, or the current conversation. Agent names, instructions, Skill content,
and model responses are kept in their original language. API clients can request localized
application messages with `Accept-Language: en` or `Accept-Language: zh-CN`.

The interface follows an Azure Portal-inspired layout with a top bar, resource navigation,
compact command bar, light and dark themes, and responsive mobile styling. This visual style
does not imply Azure Portal identity integration.

## Long-running tasks and deliverables

The Website and KARS runtime send heartbeats every 15 seconds to keep long file-generation
streams alive. The Website does not impose an early deadline on an active task. The runtime
allows an Agent to run for 60 minutes by default; `CHAT_TIMEOUT_MS` can configure a limit
between 1 minute and 24 hours.

Files generated in an Agent workspace are surfaced below the assistant response:

| Type | Online preview | Download |
|---|---|---|
| Word (`.doc`, `.docx`) | Converted to PDF with LibreOffice | Original file |
| Excel (`.xls`, `.xlsx`) | Converted to PDF with LibreOffice | Original file |
| PowerPoint (`.ppt`, `.pptx`) | Converted to PDF with LibreOffice | Original file |
| PDF | Native embedded viewer | Original file |
| HTML | Sandboxed iframe without script permission | Original file |
| SVG/PNG/GIF/JPG/JPEG/WebP | Native image preview | Original file |
| Markdown (`.md`, `.markdown`) | Safe rendered GFM Markdown | Original file |

The KARS multi-CLI runtime includes Chromium and `curl`. The `chrome`, `chromium`,
`google-chrome`, and `google-chrome-stable` commands all use the KARS egress proxy and do
not bypass Sandbox network governance.

If the browser-to-Website stream is interrupted, the Agent continues in the background.
The UI polls the current Session and restores the final response and deliverables when the
task finishes. Only an explicit **Stop generating** action cancels the runtime task.

Raw structured CLI output is accounted separately from the final assistant response.
Suppressed tool events have a 64 MiB default budget so long-running PPT jobs are not killed
when intermediate tool output crosses 4 MiB. User-visible assistant text remains capped at
4 MiB. Configure the structured output budget with `CLI_STRUCTURED_OUTPUT_LIMIT_BYTES`.

## Creating an Agent

1. Select a runtime and enter a name, model, endpoint, and credential.
2. Add Agent instructions and optionally enable tools, MCP servers, and Skills.
3. Save the Agent, build and start its runtime, then create a Session in the shared chat.
4. Start a Session with `@AgentName` to select an Agent. Later messages keep that Agent until
   another explicit `@AgentName` mention switches the executor.

An Agent draft may be saved without credentials, but chat remains unavailable until valid
credentials are configured. Use **Configure credentials** to add them. In local mode, saving
an updated configuration removes the old container while preserving its workspace and chat
history; restart the runtime to apply the new configuration. Host CLI logins are never
inherited automatically.

To edit an existing Agent, select it from the sidebar, choose **Edit configuration**, make
the changes, and save. Names, credentials, instructions, tool settings, MCP servers, and
Skills can be updated. Runtime type is immutable after creation; create a new Agent to switch
runtimes.

| Runtime | Credential | Default model | Endpoint |
|---|---|---|---|
| Claude Code CLI | API key for an Anthropic-compatible service | `claude-sonnet-4-6` | `https://api.anthropic.com` |
| GitHub Copilot CLI | GitHub token accepted by the CLI with Copilot access | `gpt-6-astra` | Managed by Copilot CLI |
| Codex CLI | API key for an OpenAI-compatible service | `gpt-5.4` | `https://api.openai.com/v1` |

For Claude, enter the service root; the CLI calls the Messages API. For Codex, enter a base
URL containing `/v1`; the provider must implement the Responses API, not only
`/chat/completions`. Model names must exist on the configured provider. Copilot uses
`gpt-6-astra` and does not silently fall back if the account lacks access.

The Copilot credential must be a GitHub OAuth token supported by the CLI, or a fine-grained
PAT whose account has **Copilot Requests** access. A classic PAT is not supported, and an
arbitrary OpenAI key is not a Copilot credential. Access, organization policy, and model
availability are controlled by the GitHub account.

From a local runtime container, connect to a model service running on the host with
`http://host.docker.internal:<port>`, not `localhost`. Prefer HTTPS for remote services.

## MCP, tools, and Skills

Agents use restricted tool settings by default. Enabling tools authorizes the CLI to run
commands, modify its workspace, and invoke configured MCP servers inside its own runtime.
This is a broad capability grant, not per-command approval. Disabling tools also disables
configured MCP servers, but native restriction behavior differs between CLIs and is not an
additional operating-system isolation boundary.

Only connect trusted external MCP servers because they have their own permissions and side
effects. In the UI, a remote MCP server requires a Streamable HTTP endpoint and an optional
MCP key. The key is written as an Authorization header in the selected CLI's native MCP
configuration; users do not need to write JSON manually.

The following examples show the internal compatibility format:

```json
{
  "workspace": {
    "command": "node",
    "args": ["/opt/kars-byo/runtime/mcp-workspace.mjs"]
  }
}
```

Remote Streamable HTTP MCP:

```json
{
  "docs": {
    "type": "http",
    "url": "https://YOUR_MCP_HOST/mcp",
    "headers": {
      "Authorization": "Bearer YOUR_MCP_KEY"
    }
  }
}
```

stdio MCP processes run inside the Agent runtime, not on the host. Extend
`containers/Dockerfile` when an additional executable is required; downloading tools with
ad hoc `npx` calls is discouraged under a read-only root filesystem.

Skill names use lowercase letters, numbers, and hyphens. Upload each Skill as a ZIP archive
of at most 5 MiB. `SKILL.md` may be at the ZIP root or inside its only top-level directory.
macOS `__MACOSX` and `.DS_Store` metadata do not affect root detection. Archives may include
scripts, templates, and other resources.

Uploaded Skills are safely extracted into persistent Agent storage and synchronized to
`/sandbox/agents/<agent-id>/skills/<skill-name>/` before each KARS conversation. This avoids
losing Skills when a KARS Pod restarts. The runtime maps them to:

- Claude Code: `~/.claude/skills/`
- GitHub Copilot CLI: `<workspace>/.github/skills/`
- Codex CLI: `~/.agents/skills/`

The system writes the configured name into `SKILL.md` frontmatter so all three CLIs recognize
the Skill consistently. A Skill provides instructions but does not grant tool permissions.
Enable tools when a Skill must read files or execute a workflow.

Runtime images pin Claude Code `2.1.263`, GitHub Copilot CLI `1.0.83`, and Codex CLI `0.152.0`.
The Copilot restricted mode uses a non-empty tool allowlist validated for that version. Codex
uses native feature settings and bundled model metadata. Revalidate adapters whenever a CLI
version changes.

## Architecture and data flow

The project supports Azure-managed and local Docker modes. In Azure, the Website/control
plane runs in Azure Container Apps and Agents execute in a KARS Sandbox on AKS. These diagrams
use Markdown ASCII text and require no Mermaid renderer.

### Azure deployment

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
|  +--------------------------+                                     |
|  | KarsSandbox reconciliation|                                    |
|  | ToolPolicy + NetworkPolicy|                                    |
|  +------------+-------------+                                     |
|               |                                                   |
|               v                                                   |
|  KARS Sandbox Pod                                                  |
|  +-------------------------------------------------------------+  |
|  | +-----------------------+   +-----------------------------+  |  |
|  | | BYO Agent container   |   | KARS governance/runtime     |  |  |
|  | | UID 1000, read-only   |   | - inference router          |  |  |
|  | | root filesystem       |   | - egress guard/proxy        |  |  |
|  | |                       |   | - network/tool policy       |  |  |
|  | | Node runtime :8080    |<->+--------------+--------------+  |  |
|  | |  + Claude Code CLI    |                  |                 |  |
|  | |  + Copilot CLI        |                  |                 |  |
|  | |  + Codex CLI          |                  |                 |  |
|  | |  + Chromium / curl    |                  |                 |  |
|  | |  + LibreOffice        |                  |                 |  |
|  | |  + MCP clients        |                  |                 |  |
|  | +-----------+-----------+                  |                 |  |
|  |             |                              |                 |  |
|  |             v                              |                 |  |
|  | /sandbox/agents/<agent-id>/                |                 |  |
|  | + workspace (generated deliverables)       |                 |  |
|  | + home (native CLI configuration)          |                 |  |
|  | + skills (synchronized ZIP Skills)         |                 |  |
|  +-------------+------------------------------|-----------------+  |
+----------------|------------------------------|--------------------+
                 |                              |
                 | Artifact API                 | Governed HTTPS egress
                 v                              v
      +----------------------+       +-----------------------------+
      | Website artifact     |       | External services           |
      | proxy and browser UI |       | - Model APIs                |
      |                      |       | - GitHub Copilot            |
      | Office -> PDF        |       | - Streamable HTTP MCP       |
      | Markdown -> rendered |       | - Web pages/package feeds   |
      | HTML -> sandboxed    |       +-----------------------------+
      | Images/PDF -> native |
      +----------------------+
```

### Chat and deliverable flow

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

Tool results are excluded from browser output and Session persistence. Deliverables are read
only from the matching Agent workspace and pass path traversal, symlink, extension, file count,
and size checks.

### Local development

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

See [ARCHITECTURE.md](ARCHITECTURE.md) for additional component and workflow diagrams. It
also uses Markdown ASCII diagrams rather than Mermaid.

## Storage and security

In local mode, every Agent has an isolated container, workspace volume, and authenticated
runtime HTTP token. Port 8080 maps to a random host loopback port, while the control plane
listens only on `127.0.0.1`.

Runtime containers use UID 1000, a read-only root filesystem, writable `/sandbox` and `/tmp`,
no Linux capabilities, `no-new-privileges`, and CPU, memory, and PID limits. They do not mount
the Docker socket or host workspace.

Agent configuration is stored under `.data/agents/<id>/`, while Session history is stored at
`.data/agents/.sessions/<session-id>/`. Directories use mode `0700`; primary configuration
files use `0600`. A runtime copy mounted read-only for UID 1000 uses `0644` but remains below
a `0700` parent directory.

Credentials are used only by local configuration and the active runtime. They do not enter
the image build context or process command line. **This is not a secret vault:** the local
user, Docker administrators, and tool-enabled Agents can access runtime credentials. Treat
MCP environment variables and headers as secrets as well.

Chat uses streaming NDJSON. Tool status and assistant text are represented separately.
The server persists full user/assistant Session history and replays it to the selected CLI.
Workspace files survive runtime restarts. Sessions are portable transcripts, not converted
native session IDs shared among the three CLIs. Oversized conversation context fails
explicitly rather than being silently truncated.

Updating local Agent configuration removes its old container so the new settings take effect.
Deleting an Agent removes its configuration but retains existing Session history and workspace
volume to avoid accidental data loss. Remove an unneeded workspace manually only after
reviewing its exact name:

```bash
docker volume ls --filter name=kars-byo-workspace-
docker volume rm kars-byo-workspace-AGENT_UUID
```

Do not expose the local control plane directly to the public internet. It is a single-user
development workspace without multi-user login, application-level RBAC, remote Docker TLS,
or production-grade secret management.

## Azure/KARS BYO relationship and boundaries

The runtime follows the upstream BYO quickstart image and HTTP adapter conventions:
`org.kars.runtime.contract=v1`, UID 1000, writable `/sandbox` and `/tmp`, port 8080, and
validation of `SANDBOX_NAME` and `KARS_RUNTIME_CONTRACT_VERSION`.

The project retains a `local-direct` Docker development mode. It is not `kars dev` and does
not start the KARS controller, inference router, or Kubernetes. The Azure deployment uses an
AKS KARS `KarsSandbox` BYO runtime with KARS NetworkPolicy, egress proxy, and ToolPolicy.

The CLIs still use their native protocols to reach configured model services. A BYO runtime
integration does not imply that every optional KARS capability is enabled, such as Token
Budget, Content Safety, complete `/agt/evaluate` evaluation for every native tool call, or
cross-Agent AgentMesh orchestration. Passing strict image-label or CR admission alone does
not implement the entire runtime plugin contract.

Upstream KARS selects a BYO image with `KarsSandbox.spec.runtime.kind: BYO` and
`spec.runtime.byo.image / contractVersion`. When adapting another deployment:

1. Deploy upstream KARS, enable `controller.byoStrict=true`, and push the runtime images to
   your registry.
2. Follow the matching CRD and controller implementation when mounting Agent configuration
   and writable workspaces.
3. Route Claude and Codex inference through the router `/anthropic` and `/v1` endpoints when
   adopting zero-credential routing.
4. Integrate `/agt/evaluate` for each CLI tool execution and route MCP through `/mcp` before
   claiming complete tool governance.
5. Validate controlled egress and proxy compatibility separately for Copilot CLI native token
   authentication and network traffic.

These cluster integrations apply only to the Azure deployment and do not start automatically
in `local-direct` mode.

References:

- https://github.com/Azure/kars
- https://github.com/Azure/kars/tree/main/examples/byo-quickstart
- https://github.com/Azure/kars/blob/main/docs/runtimes/CONTRACT.md
- https://github.com/Azure/kars/blob/main/docs/operations/byo-strict.md

The upstream quickstart README refers to `k8s/karssandbox.yaml`, while the example file on the
current main branch may still be named `k8s/clawsandbox.yaml`. Use the actual repository
contents instead of relying on a potentially stale path.
