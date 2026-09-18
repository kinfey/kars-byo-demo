import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectSecrets,
  parseEvent,
  prepareRuntime,
  serializeConversation,
} from './adapters.mjs';
import { startCodexCompatibilityProxy } from './codex-compat-proxy.mjs';
import { agentTimeoutMs } from './timeouts.mjs';
import { createOutputBudget } from './output-limits.mjs';

const execute = promisify(execFile);
const INPUT_LIMIT = 1024 * 1024;
const SKILL_ARCHIVE_LIMIT = 5 * 1024 * 1024;
const TIMEOUT_MS = agentTimeoutMs();
const HEARTBEAT_MS = 15000;
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const MAX_ARTIFACTS = 200;
const active = new Set();
const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
const CLI_COMMANDS = {
  claude: { command: 'claude', name: 'Claude Code CLI' },
  copilot: { command: 'copilot', name: 'GitHub Copilot CLI' },
  codex: { command: 'codex', name: 'Codex CLI' },
};
const ARTIFACT_TYPES = new Map([
  ['.doc', 'office'], ['.docx', 'office'], ['.xls', 'office'], ['.xlsx', 'office'],
  ['.ppt', 'office'], ['.pptx', 'office'], ['.pdf', 'pdf'], ['.html', 'html'], ['.htm', 'html'],
  ['.svg', 'image'], ['.png', 'image'], ['.gif', 'image'], ['.jpg', 'image'], ['.jpeg', 'image'],
  ['.webp', 'image'], ['.md', 'markdown'], ['.markdown', 'markdown'],
]);
const CONTENT_TYPES = new Map([
  ['.pdf', 'application/pdf'], ['.html', 'text/html; charset=utf-8'], ['.htm', 'text/html; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.gif', 'image/gif'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.md', 'text/markdown; charset=utf-8'],
  ['.markdown', 'text/markdown; charset=utf-8'], ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]);

function workspaceRoot(agentId, sandboxRoot = '/sandbox/agents') {
  return path.join(sandboxRoot, agentId, 'workspace');
}

async function confinedArtifact(agentId, relative, sandboxRoot) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || path.isAbsolute(relative)) {
    throw new Error('Invalid artifact path');
  }
  const root = workspaceRoot(agentId, sandboxRoot);
  const rootReal = await realpath(root);
  const file = path.resolve(root, relative);
  if (file === root || !file.startsWith(`${root}${path.sep}`)) throw new Error('Invalid artifact path');
  let current = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Artifact is unavailable');
  }
  const fileReal = await realpath(file);
  if (fileReal === rootReal || !fileReal.startsWith(`${rootReal}${path.sep}`)) throw new Error('Invalid artifact path');
  const info = await lstat(fileReal);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ARTIFACT_BYTES) throw new Error('Artifact is unavailable');
  const extension = path.extname(fileReal).toLowerCase();
  const type = ARTIFACT_TYPES.get(extension);
  if (!type) throw new Error('Artifact type is not supported');
  return { file: fileReal, info, extension, type, relative: path.relative(rootReal, fileReal).split(path.sep).join('/') };
}

export async function listArtifacts(agentId, { sandboxRoot = '/sandbox/agents' } = {}) {
  const root = workspaceRoot(agentId, sandboxRoot);
  try { await stat(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const rootReal = await realpath(root);
  const artifacts = [];
  async function visit(directory) {
    if (artifacts.length >= MAX_ARTIFACTS) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (artifacts.length >= MAX_ARTIFACTS || entry.name.startsWith('.')) continue;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase();
        const type = ARTIFACT_TYPES.get(extension);
        if (!type) continue;
        const info = await stat(file);
        if (info.size > MAX_ARTIFACT_BYTES) continue;
        artifacts.push({
          path: path.relative(rootReal, file).split(path.sep).join('/'),
          name: entry.name,
          type,
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        });
      }
    }
  }
  await visit(rootReal);
  return artifacts.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

async function sendArtifact(res, agentId, relative, preview, sandboxRoot) {
  const artifact = await confinedArtifact(agentId, relative, sandboxRoot);
  let file = artifact.file;
  let extension = artifact.extension;
  let cleanup;
  if (preview && artifact.type === 'office') {
    const directory = await mkdtemp('/tmp/kars-preview-');
    cleanup = () => rm(directory, { recursive: true, force: true });
    const profile = new URL(`file://${directory}/profile`).href;
    await execute('libreoffice', [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', 'pdf', '--outdir', directory, file], {
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    });
    file = path.join(directory, `${path.parse(file).name}.pdf`);
    await stat(file);
    extension = '.pdf';
  }
  try {
    const info = await stat(file);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES.get(extension) || 'application/octet-stream',
      'Content-Length': String(info.size),
      'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(preview && extension === '.pdf' ? `${path.parse(artifact.file).name}.pdf` : path.basename(artifact.file))}`,
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:",
      'X-Content-Type-Options': 'nosniff',
    });
    await new Promise((resolve, reject) => {
      const input = createReadStream(file);
      input.on('error', reject);
      res.on('close', resolve);
      res.on('finish', resolve);
      input.pipe(res);
    });
  } finally {
    if (cleanup) await cleanup();
  }
}

function createRedactor(secrets, emit) {
  const values = [...new Set(secrets.filter(value => typeof value === 'string' && value.length))].sort((a, b) => b.length - a.length);
  const keep = Math.max(0, ...values.map(value => value.length - 1));
  let pending = '';
  return {
    push(text, final = false) {
      pending += text;
      let output = '';
      const limit = final ? pending.length : Math.max(0, pending.length - keep);
      let index = 0;
      while (index < limit) {
        const secret = values.find(value => pending.startsWith(value, index));
        if (secret) {
          output += '[REDACTED]';
          index += secret.length;
        } else output += pending[index++];
      }
      pending = pending.slice(index);
      if (output) emit(output);
    },
  };
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function requestBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    const error = new Error('Content-Type application/json is required');
    error.status = 415;
    throw error;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > INPUT_LIMIT) {
      const error = new Error('Request exceeds 1 MiB');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function skillArchive(req) {
  if (req.headers['content-type'] !== 'application/zip') {
    const error = new Error('Content-Type application/zip is required');
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > SKILL_ARCHIVE_LIMIT) {
      const error = new Error('Skill ZIP exceeds 5 MiB');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!size) throw new Error('Skill ZIP is empty');
  return Buffer.concat(chunks);
}

export async function installSkill(req, agentId, name, remove = false, { sandboxRoot = '/sandbox/agents' } = {}) {
  if (!/^[0-9a-f-]{36}$/.test(agentId) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('Invalid Agent or Skill name');
  if (active.has(agentId)) {
    const error = new Error('Agent already has an active operation');
    error.status = 409;
    throw error;
  }
  const root = path.join(sandboxRoot, agentId);
  const upload = path.join(root, '.skill-uploads', `${name}.zip`);
  const target = path.join(root, 'skills', name);
  if (remove) {
    await rm(target, { recursive: true, force: true });
    await rm(upload, { force: true });
    return;
  }
  const archive = await skillArchive(req);
  await mkdir(path.dirname(upload), { recursive: true, mode: 0o700 });
  await writeFile(upload, archive, { mode: 0o600 });
  try {
    await execute('python3', [path.join(runtimeRoot, 'extract-skill.py'), upload, target, name], {
      timeout: 30000,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    await rm(upload, { force: true });
    const detail = String(error.stderr || error.message).trim().split('\n').at(-1);
    const failure = new Error(`Skill ZIP extraction failed: ${detail}`);
    failure.status = 400;
    throw failure;
  }
}

function validateInput(input) {
  const config = input?.config;
  if (!config || !Object.hasOwn(CLI_COMMANDS, config.runtime) || !/^[0-9a-f-]{36}$/.test(config.id ?? '')) {
    throw new Error('A valid CLI Agent configuration is required');
  }
  if (!config.credential || typeof config.credential !== 'string') {
    const credential = config.runtime === 'copilot' ? 'GitHub Copilot Token' : 'API Key';
    const error = new Error(`${credential} is required by the KARS ${CLI_COMMANDS[config.runtime].name} runtime`);
    error.status = 409;
    throw error;
  }
  if (!config.model || typeof config.model !== 'string' || typeof config.name !== 'string' || typeof config.instructions !== 'string' ||
      typeof config.tools !== 'boolean' || !Array.isArray(config.skills) ||
      !config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
    throw new Error('Invalid GitHub Copilot CLI Agent configuration');
  }
  const history = input.history ?? [];
  if (!Array.isArray(history) || history.length > 100 || history.some(message =>
    !message || !['user', 'assistant'].includes(message.role) ||
    typeof message.content !== 'string' || message.content.length > 64000)) {
    throw new Error('Invalid conversation history');
  }
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 64000) {
    throw new Error('Prompt must contain 1–64000 characters');
  }
  return { config, history, prompt: input.prompt };
}

async function runChat(res, input, cliVersions, signal) {
  const { config, history, prompt } = validateInput(input);
  const cli = CLI_COMMANDS[config.runtime];
  const redactDiagnostic = value => collectSecrets(config).reduce(
    (text, secret) => typeof secret === 'string' && secret ? text.split(secret).join('[REDACTED]') : text,
    String(value),
  );
  const cliVersion = cliVersions[config.runtime];
  if (active.has(config.id)) {
    const error = new Error('Agent already has an active operation');
    error.status = 409;
    throw error;
  }
  active.add(config.id);
  let child;
  let timer;
  const outputBudget = createOutputBudget(cli.name);
  let pending = '';
  let failed = false;
  let hasText = false;
  let deferredError;
  let stderr = '';
  let compatibilityProxy;
  let timeoutReached = false;
  const emit = event => {
    if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.flushHeaders?.();
  const terminate = () => {
    if (!child?.pid || child.exitCode !== null) return;
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch (error) {
      if (error.code !== 'ESRCH') console.error(`Failed to stop Copilot CLI process: ${error.message}`);
    }
  };
  try {
    const root = path.join('/sandbox/agents', config.id);
    let runtimeConfig = config;
    if (config.runtime === 'codex' && config.tools && Object.keys(config.mcpServers).length &&
        !/^(?:gpt-|codex)/i.test(config.model)) {
      compatibilityProxy = await startCodexCompatibilityProxy({
        upstream: config.baseUrl,
        credential: config.credential,
      });
      runtimeConfig = { ...config, baseUrl: compatibilityProxy.baseUrl };
    }
    const adapter = await prepareRuntime(runtimeConfig, {
      home: path.join(root, 'home'),
      workspace: path.join(root, 'workspace'),
      profile: 'kars-byo',
    });
    const invocation = adapter.invocation(serializeConversation({ history, prompt }));
    emit({ type: 'status', text: `${cli.name} ${cliVersion} loaded in KARS` });
    const redactor = createRedactor(collectSecrets(config), text => {
      hasText = true;
      emit({ type: 'text', text });
    });
    child = spawn(invocation.command, invocation.args, {
      cwd: invocation.workspace,
      env: invocation.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      shell: false,
    });
    signal.addEventListener('abort', terminate, { once: true });
    timer = setTimeout(() => {
      timeoutReached = true;
      terminate();
    }, TIMEOUT_MS);
    timer.unref();
    child.stdin.on('error', () => {});
    child.stdin.end(invocation.stdin ?? '');
    child.stdout.setEncoding('utf8');
    const state = {};
    const consume = line => {
      if (!line.trim() || failed) return;
      let event;
      try { event = JSON.parse(line); }
      catch { throw new Error(`${cli.name} returned malformed structured output`); }
      for (const item of parseEvent(config.runtime, event, state)) {
        if (item.type === 'text') {
          outputBudget.addAssistant(item.text);
          redactor.push(item.text);
        }
        else if (item.type === 'error') throw new Error(redactDiagnostic(
          item.detail ? `CLI provider request failed: ${item.detail}` : item.message,
        ));
        else emit(item);
      }
    };
    child.stdout.on('data', chunk => {
      try {
        outputBudget.addStructured(chunk);
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          outputBudget.checkEvent(line);
          consume(line);
        }
        outputBudget.checkEvent(pending);
      } catch (error) {
        failed = true;
        emit({ type: 'error', message: error.message });
        terminate();
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      try {
        outputBudget.addDiagnostic(chunk);
        stderr = (stderr + chunk).slice(-8192);
      } catch (error) {
        if (failed) return;
        failed = true;
        emit({ type: 'error', message: error.message });
        terminate();
      }
    });
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, childSignal) => resolve({ code, childSignal }));
    });
    if (pending && !failed) {
      outputBudget.checkEvent(pending);
      consume(pending);
    }
    redactor.push('', true);
    if (!failed && timeoutReached) throw new Error('Agent run timed out');
    if (!failed && (signal.aborted || result.childSignal)) throw signal.reason ?? new Error(`${cli.name} was stopped`);
    if (!failed && result.code !== 0) {
      const diagnostic = redactDiagnostic(stderr).replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
      throw new Error(diagnostic
        ? `${cli.name} run failed: ${diagnostic.slice(0, 1000)}`
        : `${cli.name} run failed; check the configured credential`);
    }
    if (!failed && !hasText && !state.hasText) throw new Error(`${cli.name} completed without an assistant response`);
    if (!failed) {
      const artifacts = await listArtifacts(config.id);
      if (artifacts.length) emit({ type: 'artifacts', artifacts });
      emit({ type: 'done' });
    }
  } catch (error) {
    if (res.headersSent) {
      if (!failed) emit({ type: 'error', message: redactDiagnostic(error.message) });
      failed = true;
    } else deferredError = error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', terminate);
    terminate();
    if (compatibilityProxy) await compatibilityProxy.close();
    active.delete(config.id);
    if (!deferredError && !res.writableEnded) res.end();
  }
  if (deferredError) throw deferredError;
}

export async function main() {
  if (process.env.KARS_RUNTIME_CONTRACT_VERSION !== 'v1') {
    throw new Error('KARS runtime contract v1 is required');
  }
  const cliVersions = {};
  for (const [runtime, cli] of Object.entries(CLI_COMMANDS)) {
    const { stdout, stderr } = await execute(cli.command, ['--version'], { timeout: 15000 });
    const version = `${stdout}\n${stderr}`.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];
    if (!version) throw new Error(`${cli.name} version could not be determined`);
    cliVersions[runtime] = version;
  }
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      return sendJson(res, 200, {
        status: 'ok',
        runtime: 'multi-cli',
        runtimes: Object.fromEntries(Object.entries(CLI_COMMANDS).map(([runtime, cli]) => [runtime, {
          cli: cli.name,
          cliLoaded: true,
          cliVersion: cliVersions[runtime],
        }])),
        profile: 'kars-byo',
      });
    }
    const skillMatch = req.url?.match(/^\/skills\/([0-9a-f-]{36})\/([a-z0-9][a-z0-9-]{0,63})(\/delete)?$/);
    if (skillMatch && req.method === 'POST') {
      try {
        await installSkill(req, skillMatch[1], skillMatch[2], Boolean(skillMatch[3]));
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        return sendJson(res, error.status || 400, { error: error.message });
      }
    }
    const requestUrl = new URL(req.url, 'http://runtime.local');
    const artifactMatch = requestUrl.pathname.match(/^\/artifacts\/([0-9a-f-]{36})$/);
    if (artifactMatch && req.method === 'GET') {
      try {
        const relative = requestUrl.searchParams.get('path');
        if (!relative) return sendJson(res, 200, { artifacts: await listArtifacts(artifactMatch[1]) });
        await sendArtifact(res, artifactMatch[1], relative, requestUrl.searchParams.get('preview') === '1');
      } catch (error) {
        if (!res.headersSent) sendJson(res, 400, { error: error.message });
        else res.destroy(error);
      }
      return;
    }
    if (req.method !== 'POST' || req.url !== '/chat') return sendJson(res, 404, { error: 'Not found' });
    const abort = new AbortController();
    let heartbeat;
    res.once('close', () => {
      if (!res.writableEnded) abort.abort(new Error('Chat client disconnected'));
    });
    try {
      const input = await requestBody(req);
      heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify({ type: 'heartbeat' })}\n`);
      }, HEARTBEAT_MS);
      await runChat(res, input, cliVersions, abort.signal);
    } catch (error) {
      if (!res.headersSent) sendJson(res, error.status ?? 400, { error: error.message });
      else if (!res.writableEnded) {
        res.write(`${JSON.stringify({ type: 'error', message: error.message })}\n`);
        res.end();
      }
    } finally { clearInterval(heartbeat); }
  });
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(`KARS CLI runtime startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
