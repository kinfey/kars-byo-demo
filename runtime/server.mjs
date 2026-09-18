import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRuntime, parseEvent, serializeConversation, collectSecrets } from './adapters.mjs';
import { agentTimeoutMs } from './timeouts.mjs';

const INPUT_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const LINE_LIMIT = 1024 * 1024;
const TIMEOUT_MS = agentTimeoutMs();
const hash = value => createHash('sha256').update(value).digest();

export function authorized(header, token) {
  return typeof header === 'string' && header.startsWith('Bearer ') &&
    timingSafeEqual(hash(header.slice(7)), hash(token));
}

export function validateConfig(config, env = process.env) {
  if (env.KARS_RUNTIME_CONTRACT_VERSION !== 'v1') throw new Error('KARS_RUNTIME_CONTRACT_VERSION must be v1');
  if (!config || !['claude', 'copilot', 'codex'].includes(config.runtime)) throw new Error('Invalid runtime');
  if (env.KARS_RUNTIME && env.KARS_RUNTIME !== config.runtime) throw new Error('Image runtime does not match configuration');
  if (!env.SANDBOX_NAME || env.SANDBOX_NAME !== config.id) throw new Error('SANDBOX_NAME must match the configured agent id');
  if (typeof config.runtimeToken !== 'string' || config.runtimeToken.length < 32) throw new Error('A runtimeToken of at least 32 characters is required');
  for (const key of ['id', 'name', 'model', 'credential', 'instructions']) {
    if (typeof config[key] !== 'string' || config[key].includes('\0')) throw new Error(`Invalid ${key}`);
  }
  if (!config.model || config.model.startsWith('-')) throw new Error('Invalid model');
  if (typeof config.tools !== 'boolean') throw new Error('Invalid tools setting');
  if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) throw new Error('Invalid MCP servers');
  if (!Array.isArray(config.skills)) throw new Error('Invalid skills');
  return config;
}

export function validateChat(input) {
  if (!input || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 64000) throw new Error('prompt must be nonempty and at most 64000 characters');
  const history = input.history ?? [];
  if (!Array.isArray(history) || history.length > 100 || history.some(item =>
    !item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || item.content.length > 64000)) {
    throw new Error('history must contain at most 100 user/assistant messages');
  }
  return { prompt: input.prompt, history };
}

export function createRedactor(secrets, emit) {
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
        if (secret) { output += '[REDACTED]'; index += secret.length; }
        else output += pending[index++];
      }
      pending = pending.slice(index);
      if (output) emit(output);
    },
  };
}

export function createRuntimeServer(config, adapter, { spawnProcess = spawn, timeoutMs = TIMEOUT_MS, killGraceMs = 1500 } = {}) {
  let busy = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok', runtime: config.runtime, contractVersion: 'v1', profile: 'local-direct', busy,
        toolMode: config.tools ? 'autonomous-container' : config.runtime === 'codex' ? 'read-only' : 'no-tools',
      }));
      return;
    }
    function reject(status, error) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error }));
    }
    if (req.method !== 'POST' || req.url !== '/chat') return reject(404, 'Not found');
    if (!authorized(req.headers.authorization, config.runtimeToken)) return reject(401, 'Unauthorized');
    if (!config.credential) return reject(400, 'Configure a provider credential before starting a chat');
    if (busy) return reject(409, 'An agent run is already active');
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return reject(415, 'Expected application/json');
    if (Number(req.headers['content-length']) > INPUT_LIMIT) return reject(413, 'Request exceeds 256 KiB');
    busy = true;
    let child;
    let closed = false;
    let completed = false;
    let failed = false;
    let timeout;
    let escalation;
    let bytes = 0;
    let outputBytes = 0;
    let textCount = 0;
    let line = '';
    let drainNeeded = false;
    function signalGroup(signal) {
      if (!child?.pid) return false;
      try { process.kill(-child.pid, signal); return true; }
      catch {
        try { return child.kill(signal); } catch { return false; }
      }
    }
    function terminate() {
      const running = signalGroup('SIGTERM');
      if (!escalation && running) {
        escalation = setTimeout(() => {
          signalGroup('SIGKILL');
          escalation = undefined;
          if (completed) busy = false;
        }, killGraceMs);
        escalation.unref();
      }
    }
    function send(event) {
      if (closed || res.writableEnded || res.destroyed) return;
      if (res.writableLength > OUTPUT_LIMIT) { closed = true; terminate(); res.destroy(); return; }
      if (!res.write(JSON.stringify(event) + '\n')) drainNeeded = true;
    }
    const redactor = createRedactor(collectSecrets(config), text => { textCount += text.length; send({ type: 'text', text }); });
    function fail(message) {
      if (failed || closed) return;
      failed = true;
      send({ type: 'error', message });
      terminate();
    }
    function finish() {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      if (!escalation) busy = false;
      if (!closed) {
        if (!failed) redactor.push('', true);
        send({ type: 'done' });
        res.end();
      }
    }
    res.on('close', () => {
      if (!completed) { closed = true; terminate(); if (!child) { completed = true; busy = false; clearTimeout(timeout); } }
    });
    timeout = setTimeout(() => {
      if (!res.headersSent) {
        closed = true; completed = true; busy = false;
        reject(408, 'Request body timed out');
        req.destroy();
      } else { fail('Agent run timed out'); finish(); }
    }, timeoutMs);
    try {
      const chunks = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > INPUT_LIMIT) { const error = new Error('Request exceeds 256 KiB'); error.status = 413; throw error; }
        chunks.push(chunk);
      }
      const input = validateChat(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (closed) return;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      send({ type: 'status', text: `Running ${config.runtime} CLI (local-direct)` });
      if (config.runtime === 'codex' && !config.tools) {
        send({ type: 'status', text: 'Read-only mode: shell, file-edit, image-read, MCP, and interactive tools disabled by native CLI configuration.' });
      }
      const invocation = adapter.invocation(serializeConversation(input));
      child = spawnProcess(invocation.command, invocation.args, {
        cwd: adapter.workspace, env: invocation.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, shell: false,
      });
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      const state = {};
      function consume(value) {
        if (!value.trim() || failed || closed) return;
        let event;
        try { event = JSON.parse(value); }
        catch { fail('CLI returned malformed structured output'); return; }
        for (const item of parseEvent(config.runtime, event, state)) {
          if (item.type === 'text') redactor.push(item.text);
          else if (item.type === 'error') fail(item.message);
          else if (item.type === 'status') send(item);
        }
      }
      child.stdout.on('data', chunk => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > OUTPUT_LIMIT) return fail('CLI output exceeded 4 MiB');
        line += chunk;
        let newline;
        while ((newline = line.indexOf('\n')) !== -1) {
          const value = line.slice(0, newline);
          line = line.slice(newline + 1);
          if (value.length > LINE_LIMIT) return fail('CLI event exceeded size limit');
          consume(value);
        }
        if (line.length > LINE_LIMIT) fail('CLI event exceeded size limit');
        if (drainNeeded) { child.stdout.pause(); drainNeeded = false; }
      });
      res.on('drain', () => child?.stdout.resume());
      child.stderr.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > OUTPUT_LIMIT) fail('CLI output exceeded 4 MiB');
      });
      child.on('error', () => { fail('Unable to start the configured CLI'); finish(); });
      child.on('exit', () => terminate());
      child.on('close', (code, signal) => {
        if (line) consume(line);
        if (!failed && !closed && (code !== 0 || signal)) fail('CLI run failed; check provider configuration and credentials');
        if (!failed && !closed && !state.hasText && !textCount) fail('CLI completed without an assistant response');
        // Even a successful CLI may leave stdio MCP descendants behind.
        terminate();
        finish();
      });
      child.stdin.end(invocation.stdin ?? '');
    } catch (error) {
      clearTimeout(timeout);
      if (error.status === 413 && !res.headersSent) res.setHeader('Connection', 'close');
      if (!res.headersSent && !closed) reject(error.status ?? 400, error instanceof SyntaxError ? 'Invalid JSON' : error.message);
      else if (!closed) { fail('Agent runtime failed'); finish(); }
      if (!child) { completed = true; busy = false; }
      else terminate();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}

export async function main() {
  const configFile = '/run/agent/config.json';
  const content = await readFile(configFile, 'utf8');
  if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('Runtime configuration exceeds 1 MiB');
  const config = validateConfig(JSON.parse(content));
  const adapter = await prepareRuntime(config);
  const server = createRuntimeServer(config, adapter);
  server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(() => { console.error('Runtime startup failed: check contract v1, SANDBOX_NAME, and mounted configuration.'); process.exitCode = 1; });
}
