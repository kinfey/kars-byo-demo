# Azure Deployment Plan

> **Status:** Deployed

Generated: 2026-09-18T12:09:13+08:00

---

## 1. Project Overview

**Goal:** Prevent long-running Agent work from failing with `Chat client disconnected`, and expose generated deliverables with online preview and download.

**Path:** Modify Existing

---

## 2. Requirements

| Attribute | Value |
|-----------|-------|
| Classification | Development |
| Scale | Existing single-replica deployment |
| Budget | No new Azure resources |
| Subscription | Existing selected Azure subscription; confirmation required |
| Location | `swedencentral`; confirmation required |

### Deliverable UX

| Type | Preview | Download |
|------|---------|----------|
| Word (`.doc`, `.docx`) | Runtime converts to PDF; browser displays PDF | Original file |
| Excel (`.xls`, `.xlsx`) | Runtime converts to PDF; browser displays PDF | Original file |
| PowerPoint (`.ppt`, `.pptx`) | Runtime converts to PDF; browser displays PDF | Original file |
| PDF | Native embedded PDF viewer | Original file |
| HTML | Sandboxed iframe | Original file |
| SVG/PNG/GIF/JPG/JPEG/WebP | Native image preview | Original file |
| Markdown (`.md`, `.markdown`) | Sanitized rendered Markdown | Original file |

---

## 3. Root Cause and Components

The failed PPT request ran from `03:45:11Z` to `03:53:03Z`. During long tool work, the streaming chain emitted no user-visible data for an extended interval. The client/proxy connection closed, then both the Website and KARS runtime abort handlers converted the close into `Chat client disconnected`.

| Component | Change |
|-----------|--------|
| Browser stream client | Accept heartbeat events without displaying messages |
| Website NDJSON stream | Emit periodic heartbeat events and flush headers |
| Website → KARS client | Consume runtime heartbeat events |
| KARS runtime stream | Emit periodic heartbeat events while the CLI is active |
| KARS runtime artifacts API | Safely list and serve supported files under one Agent workspace |
| Office preview | Convert Office files to temporary PDFs using LibreOffice |
| Website artifacts proxy | Proxy metadata, preview and download without exposing AKS credentials |
| React UI | Show deliverable cards, preview dialog, download actions and rendered Markdown |

---

## 4. Recipe Selection

**Selected:** Existing Azure CLI, ACR, Azure Container Apps and AKS/KARS workflow.

No new infrastructure or Azure resource provisioning is required.

---

## 5. Security and Reliability

- Confine artifact paths to `/sandbox/agents/<agent-id>/workspace`.
- Reject traversal, symlinks, unsupported extensions, directories and oversized files.
- Apply `Content-Security-Policy` and sandbox HTML previews.
- Serve SVG as an image, never execute it as document HTML.
- Sanitize rendered Markdown before insertion into the DOM.
- Generate Office preview PDFs in temporary directories and remove them after each response.
- Keep original deliverables unchanged.
- Heartbeats do not alter persisted chat history or visible model output.

---

## 6. Provisioning Limit Checklist

No Azure resources will be created. Existing ACR, Azure Container Apps and AKS resources are reused.

| Resource Type | Number to Deploy | Total After Deployment | Limit/Quota | Notes |
|---------------|------------------|------------------------|-------------|-------|
| New Azure resources | 0 | Unchanged | Not applicable | Image and workload updates only |

**Status:** Resource limits unchanged.

---

## 7. Execution Checklist

### Planning

- [x] Inspect failed session timing and persisted error
- [x] Inspect Website and KARS runtime streaming code
- [x] Inspect existing workspace and deployment architecture
- [x] Define preview/download behavior by file type
- [x] Confirm Azure context and obtain approval

### Implementation

- [x] Add end-to-end NDJSON heartbeat handling
- [x] Add safe runtime artifact listing/download/preview endpoints
- [x] Add Website artifact proxy endpoints
- [x] Add Office-to-PDF preview support to runtime image
- [x] Add sanitized Markdown rendering and deliverable UI
- [x] Add focused API and runtime tests
- [x] Run full tests, build and container validation
- [x] Set status to `Ready for Validation`

### Validation and Deployment

- [x] Invoke `azure-validate`
- [x] Build and push immutable Website and runtime images
- [x] Invoke `azure-deploy`
- [x] Verify long-idle streaming survives
- [x] Verify every supported deliverable type can preview/download
- [x] Set status to `Deployed`

---

## 8. Validation Proof

| Check | Command | Result |
|-------|---------|--------|
| Syntax | `node --check` for runtime and Website server modules | Pass |
| Tests | `npm test` | Pass: 49, skipped: 3 |
| Web build | `npm run build -- --emptyOutDir` | Pass |
| Website image | `docker build -f containers/Website.Dockerfile` | Pass |
| Runtime image | `docker build -f containers/KarsCli.Dockerfile` | Pass |
| Office conversion | LibreOffice HTML → DOCX → PDF inside runtime image | Pass |
| Runtime artifacts | Artifact list and DOCX PDF-preview endpoint | Pass |
| Azure access | Existing subscription, ACR and Container App checks | Pass |
| AKS manifest | Server-side dry-run through AKS command tunnel | Pass |

**Validated by:** azure-validate

**Validation timestamp:** 2026-09-18T12:22:00+08:00

---

## 10. Deployment Proof

| Check | Result |
|-------|--------|
| Website rollout | Immutable Website image deployed to Azure Container Apps; healthy revision receives 100% traffic |
| Runtime rollout | Immutable runtime image deployed to AKS/KARS; one Ready pod remains on the new image |
| Artifact APIs | Listing, Markdown, HTML and SVG previews, Office-to-PDF preview, and original Office download passed through the public Website endpoint |
| Artifact UI | Deliverable cards, rendered Markdown table, Office preview dialog, and download links verified in a real browser |
| HTML isolation | Inline script execution was blocked by the sandboxed preview iframe |
| Long-running chat | An 89-second Agent request completed with five heartbeat events and no disconnect |
| Cleanup | Temporary Agent workspace deliverables, validation Session, kubeconfig, test files, and local validation images removed |

**Deployment timestamp:** 2026-09-18T14:33:58+08:00

---

## 11. Ten-Minute Timeout Remediation

**Incident:** A later PPT generation request remained connected through heartbeats but was explicitly aborted by the Website after exactly 10 minutes.

**Root cause:** `server/index.mjs` retained a fixed 600,000 ms proxy timer, and the KARS CLI runtime independently retained the same 10-minute execution limit.

**Planned change:**

- Remove the Website's duplicate hard deadline so it follows the runtime lifecycle and user cancellation.
- Raise the runtime default execution limit to 60 minutes.
- Allow operators to configure `CHAT_TIMEOUT_MS` from 1 minute through 24 hours.
- Preserve the existing 15-second heartbeats and cancellation behavior.
- Deploy `CHAT_TIMEOUT_MS=3600000` to the KARS runtime.
- Build and deploy new immutable Website and runtime images.
- Verify a chat remains active beyond 10 minutes and completes without a timeout.

### Preparation Checklist

- [x] Diagnose the exact application-owned timeout
- [x] Remove the Website 10-minute abort timer
- [x] Add validated runtime timeout configuration
- [x] Configure the deployed runtime for 60 minutes
- [x] Add timeout regression coverage
- [x] Run focused tests and syntax checks
- [x] Set status to `Ready for Validation`
- [x] Invoke `azure-validate`
- [x] Build and push immutable images
- [x] Invoke `azure-deploy`
- [x] Verify a request exceeding 10 minutes

### Timeout Remediation Validation Proof

| Check | Command | Result |
|-------|---------|--------|
| Syntax | `node --check` for Website and runtime modules | Pass |
| Tests | `npm test` | Pass: 50, skipped: 3 |
| Web build | `npm run build -- --emptyOutDir` | Pass |
| Website image | `docker build -f containers/Website.Dockerfile` | Pass |
| Runtime image | `docker build -f containers/KarsCli.Dockerfile` | Pass |
| Timeout behavior | Regression test verifies 60-minute default and bounded override parsing | Pass |
| AKS manifest | Server-side dry-run through the AKS command tunnel | Pass |
| Current Azure health | Existing Container App reports `Running` and provisioning `Succeeded` | Pass |

**Timeout remediation validated:** 2026-09-18T15:41:00+08:00

### Timeout Remediation Deployment Proof

| Check | Result |
|-------|--------|
| Website rollout | New immutable image is running with successful provisioning |
| Runtime rollout | New immutable image is the only Ready KARS runtime pod |
| Runtime configuration | `CHAT_TIMEOUT_MS=3600000` is present on the deployed pod |
| Public health | Website health endpoint returns `{"status":"ok"}` |
| Ten-minute boundary | A real 663-second Agent request completed successfully with 44 heartbeat events and no errors |
| Cleanup | The validation Session and local validation files/images were removed |

**Timeout remediation deployed:** 2026-09-18T16:02:50+08:00

---

## 12. Runtime Network and Chrome Enablement

**Diagnosis:**

- The runtime image does not contain Chrome or Chromium.
- Direct pod egress is intentionally governed and direct TCP requests time out.
- The KARS egress proxy at `127.0.0.1:8444` successfully reaches public HTTPS endpoints.
- Agent CLI processes already receive standard proxy environment variables, but Chrome needs an explicit proxy argument.

**Planned change:**

- Install Chromium and `curl` in the multi-CLI runtime image.
- Provide `chrome`, `google-chrome`, `google-chrome-stable`, and `chromium` commands through a KARS-aware wrapper.
- Configure Chromium with the KARS egress proxy, container-safe shared-memory behavior, and no setuid sandbox dependency.
- Keep KARS governance enabled and retain `egressMode: Learn`; do not bypass the egress guard.
- Build and deploy a new immutable runtime image.
- Verify command aliases, headless rendering, screenshot output, and HTTPS access through the governed proxy in the deployed pod.

### Network and Chrome Checklist

- [x] Diagnose current pod network policy and egress path
- [x] Confirm governed proxy can access public HTTPS
- [x] Confirm Chrome/Chromium is absent
- [x] Add Chromium, curl, and the proxy-aware wrapper
- [x] Validate the runtime image locally
- [x] Invoke `azure-validate`
- [x] Build and push the immutable runtime image
- [x] Invoke `azure-deploy`
- [x] Verify browser and network access in the deployed pod

### Network and Chrome Validation Proof

| Check | Result |
|-------|--------|
| Full tests | Pass: 50, skipped: 3 |
| Runtime image build | Pass |
| Runtime identity | Image remains non-root (`1000:1000`) |
| Browser commands | `chrome`, `chromium`, `google-chrome`, and `google-chrome-stable` resolve correctly |
| Browser version | Chromium 152 installed |
| Headless rendering | Local HTML screenshot generated successfully |
| Network tooling | curl installed |
| KARS governance | Existing egress proxy reached public HTTPS; direct unmanaged egress remained blocked |
| AKS manifest | Server-side dry-run passed |

**Network and Chrome validated:** 2026-09-18T16:29:26+08:00

### Network and Chrome Deployment Proof

| Check | Result |
|-------|--------|
| Runtime rollout | One Ready pod remains on the immutable browser-enabled image |
| Runtime security | Browser runs as UID 1000 under the existing restricted KARS sandbox |
| Network governance | Direct unmanaged egress remains blocked; HTTPS succeeds through the KARS proxy |
| curl | Agent verified `https://example.com` with HTTP 200 |
| Chrome | Agent verified Chromium 152 is executable |
| Browser navigation | Deployed headless Chromium loaded public HTTPS content through the proxy |
| Browser rendering | Deployed Chromium generated a non-empty screenshot |
| Cleanup | Validation Session, screenshot, kubeconfig, diagnostics, and local image were removed |

**Network and Chrome deployed:** 2026-09-18T16:47:27+08:00

---

## 13. Chat Network Interruption Recovery

**Diagnosis:**

- Public Website APIs, KARS runtime, Chrome, curl, DNS, and governed egress are currently healthy.
- A real chat request succeeds through the complete public path.
- The reported UI `network error` occurs when the browser-to-Website stream is interrupted.
- Website currently treats a browser disconnect as cancellation and aborts the still-running KARS Agent, persisting `Chat client disconnected`.

**Planned change:**

- Do not cancel an Agent solely because its browser stream disconnected.
- Continue the Website-to-KARS stream in the background and persist the final assistant response or runtime error.
- Make stream writes safe after the HTTP response has closed.
- Let the browser automatically poll Session history after a transient network interruption.
- Restore the completed response and deliverables without resubmitting the prompt.
- Preserve explicit Stop behavior through the existing cancel endpoint.
- Deploy a new immutable Website image; the runtime image and governed egress remain unchanged.

### Chat Recovery Checklist

- [x] Verify current public APIs and runtime health
- [x] Verify curl, Chrome, DNS, and governed egress
- [x] Reproduce a successful real chat
- [x] Identify disconnect-driven cancellation in Website code
- [x] Continue Agent execution after browser disconnect
- [x] Add automatic Session recovery in the UI
- [x] Add regression tests
- [x] Invoke `azure-validate`
- [x] Build and deploy the immutable Website image
- [x] Verify disconnect recovery through the public endpoint

### Chat Recovery Validation Proof

| Check | Result |
|-------|--------|
| Full tests | Pass: 53, skipped: 3 |
| Recovery unit tests | Recoverable error classification, polling, and cancellation passed |
| Frontend production build | Pass |
| Server syntax | Pass |
| Website image | Dockerfile built successfully using Azure ACR isolated build |
| Existing runtime | Public chat, Chrome, curl, DNS, and governed egress remain healthy |
| Cancellation | Explicit cancel endpoint remains the only path that aborts an active Agent |

**Chat recovery validated:** 2026-09-18T17:40:47+08:00

### Chat Recovery Deployment Proof

| Check | Result |
|-------|--------|
| Website rollout | New immutable Website image is running with successful provisioning |
| Public health | Website health endpoint returns `{"status":"ok"}` |
| Fault injection | Public chat client connection was forcibly closed after 5 seconds |
| Background execution | The Agent continued its 20-second task after the client disconnected |
| Persistence | Final assistant response was saved to the Session |
| Error handling | No `Chat client disconnected` or runtime error was persisted |
| UI recovery | Frontend polls Session history after recoverable stream failures without resubmitting the prompt |
| Cleanup | Fault-injection Session and local diagnostic files were removed |

**Chat recovery deployed:** 2026-09-18T18:44:05+08:00

---

## 14. Claude Structured Output Limit Remediation

**Incident:** PPT generation failed repeatedly with `Claude Code CLI output exceeded 4 MiB`.

**Root cause:** The runtime applies the 4 MiB browser-response limit to all raw CLI stdout and stderr. Claude structured output includes suppressed tool results and diagnostics, so a long artifact task can exceed 4 MiB even when the assistant response shown to the user is small.

**Planned change:**

- Keep the user-visible assistant response limit at 4 MiB.
- Separate raw structured stdout, individual event, and stderr diagnostic budgets.
- Permit up to 64 MiB of raw structured stdout, 16 MiB per structured event, and 16 MiB of stderr.
- Continue suppressing tool arguments/results from browser output and persisted messages.
- Make the raw stdout limit configurable with validated environment settings.
- Deploy a new immutable runtime image and verify more than 4 MiB of suppressed Claude tool output no longer aborts the request.

### Output Limit Checklist

- [x] Confirm the production failure and affected Session
- [x] Identify combined raw stdout/stderr accounting as the root cause
- [x] Separate structured, event, diagnostic, and assistant limits
- [x] Add regression tests above the previous 4 MiB boundary
- [x] Invoke `azure-validate`
- [x] Build and deploy the immutable runtime image
- [x] Verify a public Agent request with more than 4 MiB of suppressed tool output

### Output Limit Validation Proof

| Check | Result |
|-------|--------|
| Full tests | Pass: 56, skipped: 3 |
| Boundary regression | 5 MiB of structured output is accepted while assistant text remains independently bounded |
| Limit validation | Invalid configured byte limits fail during runtime startup |
| Syntax | Runtime modules pass `node --check` |
| Web build | Pass |
| Runtime image | Dockerfile built successfully using Azure ACR isolated build |
| AKS manifest | Server-side dry-run passed |
| Security behavior | Tool results remain suppressed; browser/persisted assistant text remains capped at 4 MiB |

**Output limit remediation validated:** 2026-09-18T20:56:00+08:00

### Output Limit Deployment Proof

| Check | Result |
|-------|--------|
| Runtime rollout | One Ready pod remains on the immutable output-limit image |
| Runtime configuration | Structured CLI output budget is 64 MiB |
| Production boundary test | Claude executed a command producing 5 MiB of tool output |
| Result | Request completed without an output-limit error |
| Data minimization | Tool output remained suppressed; only 170 bytes of user-visible response were streamed |
| Assistant safety limit | User-visible response remains capped at 4 MiB |
| Cleanup | Validation Session and temporary kubeconfig files were removed |

**Output limit remediation deployed:** 2026-09-18T21:12:45+08:00

---

## 9. Expected Files

- `runtime/kars-copilot-server.mjs`
- `server/kars.mjs`
- `server/index.mjs`
- `web/src/api.js`
- `web/src/main.jsx`
- `web/src/style.css`
- `web/src/i18n.js`
- `containers/KarsCli.Dockerfile`
- `package.json`
- `package-lock.json`
- related tests and deployment manifests
