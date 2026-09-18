import http from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { applyProvider, normalizeConfig, normalizeProvider, publicConfig, publicProvider, resolveAgentMention, RUNTIMES, requireId } from './config.mjs';
import { command, inspect, startContainer, removeContainer, volumeName, containerName } from './docker.mjs';
import { resolveLocale, localizeMessage, messageTranslations } from './i18n.mjs';
import { checkKarsConnection, deleteKarsSkill, getKarsArtifact, listKarsArtifacts, streamKarsChat, syncKarsSkill } from './kars.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const store = new Store(path.resolve(process.env.DATA_DIR || path.join(root, '.data/agents')));
await store.init();
await store.migrateLegacyProviders();
await store.migrateLegacySessions();
const port = Number(process.env.PORT || 4310);
const host = process.env.HOST || '127.0.0.1';
const deploymentMode = process.env.DEPLOYMENT_MODE || 'local-direct';
const aksManaged = deploymentMode === 'kars-aks';
const karsChatEndpoint = process.env.KARS_CHAT_ENDPOINT || '';
const karsChatToken = process.env.KARS_CHAT_TOKEN || '';
const karsModel = process.env.KARS_MODEL || 'gpt-6-astra';
const publicOrigins = (process.env.PUBLIC_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
const publicHosts = publicOrigins.map(value => new URL(value).host);
const busy = new Set();
const chatting = new Map();
let building = false;
const json = (res, status, value) => {
  const localized = value && !Array.isArray(value) && typeof value.error === 'string'
    ? { ...value, error: localizeMessage(value.error, res.locale), translations: messageTranslations(value.error) } : value;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Language': res.locale, Vary: 'Accept-Language' });
  res.end(JSON.stringify(localized));
};
const stream = res => {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Language': res.locale, Vary: 'Accept-Language' });
  res.flushHeaders?.();
  return event => {
    const localized = event.type === 'error' ? { ...event, message: localizeMessage(event.message, res.locale), translations: messageTranslations(event.message) }
      : event.type === 'status' ? { ...event, text: localizeMessage(event.text, res.locale), translations: messageTranslations(event.text) } : event;
    if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(localized)}\n`);
  };
};
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Content-Type application/json is required');
  let value = '';
  for await (const chunk of req) {
    value += chunk;
    if (Buffer.byteLength(value) > 1_000_000) throw new Error('Request is too large');
  }
  return JSON.parse(value || '{}');
}
async function zipBody(req) {
  if (req.headers['content-type'] !== 'application/zip') throw new Error('Content-Type application/zip is required');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new Error('Skill ZIP exceeds 5 MiB');
    chunks.push(chunk);
  }
  if (!size) throw new Error('Skill ZIP is empty');
  return Buffer.concat(chunks);
}
function redact(value, config) {
  let result = String(value);
  const secrets = [config.credential, config.runtimeToken];
  for (const server of Object.values(config.mcpServers || {})) secrets.push(...Object.values(server.env || {}), ...Object.values(server.headers || {}));
  for (const secret of secrets) if (secret?.length >= 4) result = result.split(secret).join('[REDACTED]');
  return result;
}
async function configured(config) {
  const providers = await store.providers();
  return applyProvider(config, providers[config.runtime]);
}
async function display(config) {
  const effective = await configured(config);
  return {
    ...publicConfig(effective),
    ...(aksManaged ? { status: 'running' } : await inspect(config.id)),
  };
}
async function removeRuntime(id, { allowUnavailable = false } = {}) {
  if (aksManaged) return false;
  try {
    await removeContainer(id);
    return true;
  } catch (error) {
    if (!allowUnavailable) throw error;
    console.error(`Runtime cleanup skipped while deleting Agent ${id}: ${error.message}`);
    return false;
  }
}
async function locked(id, action) {
  if (busy.has(id) || chatting.has(id)) { const error = new Error('Agent is busy; cancel its current operation first'); error.status = 409; throw error; }
  busy.add(id);
  try { return await action(); } finally { busy.delete(id); }
}
async function chat(req, res, config, prompt, sessionId) {
  config = await configured(config);
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 64000) throw new Error('Prompt must contain 1–64000 characters');
  if (busy.has(config.id) || chatting.has(config.id)) throw new Error('Agent already has an active operation');
  if (!config.credential) {
    const credentialName = config.runtime === 'copilot' ? 'GitHub Copilot Token' : 'API Key';
    const error = new Error(aksManaged
      ? `Missing ${credentialName}. Open Configure and save your credential before chatting.`
      : `Missing ${credentialName}. Open Configure, save your credential, and restart the container before chatting.`);
    error.status = 409;
    error.code = 'CREDENTIAL_REQUIRED';
    throw error;
  }
  const abort = new AbortController();
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  chatting.set(config.id, { abort, done });
  let send;
  let messages;
  let answer = '';
  let artifacts = [];
  let completed = false;
  let savedUser = false;
  let heartbeat;
  try {
    let state;
    if (!aksManaged) {
      state = await inspect(config.id);
      if (state.status !== 'running' || !state.port) throw new Error('Start the agent container before chatting');
    }
    messages = sessionId ? await store.sessionMessages(sessionId) : await store.messages(config.id);
    // Full transcript replay is portable across the three CLIs; reject rather than silently truncate.
    const history = messages.filter(m => m.role === 'user' || m.role === 'assistant').map(({ role, content }) => ({ role, content }));
    const conversationBytes = Buffer.byteLength(JSON.stringify(history)) + Buffer.byteLength(prompt);
    // Copilot accepts the transcript as one argv value; Linux limits a single argument to 128 KiB.
    const maxConversationBytes = config.runtime === 'copilot' ? 120000 : 200000;
    if (history.length > 100 || conversationBytes > maxConversationBytes) throw new Error('Conversation is too large; create a new agent for a fresh workspace/session');
    messages.push({ role: 'user', content: prompt, agentId: config.id, agentName: config.name, createdAt: new Date().toISOString() });
    if (sessionId) await store.saveSessionMessages(sessionId, messages);
    else await store.saveMessages(config.id, messages);
    savedUser = true;
    send = stream(res);
    heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15000);
    if (aksManaged) {
      send({ type: 'status', text: 'Running KARS runtime on AKS' });
      for (const skill of config.skills.filter(item => item.source === 'archive')) {
        send({ type: 'status', text: `Synchronizing Skill: ${skill.name}` });
        await syncKarsSkill({
          endpoint: karsChatEndpoint,
          token: karsChatToken,
          agentId: config.id,
          skillName: skill.name,
          archive: await store.skillArchive(config.id, skill.name),
          signal: abort.signal,
        });
      }
      answer = await streamKarsChat({
        endpoint: karsChatEndpoint,
        token: karsChatToken,
        model: karsModel,
        config,
        history,
        prompt,
        signal: abort.signal,
        onText: text => send({ type: 'text', text }),
        onStatus: text => send({ type: 'status', text }),
        onArtifacts: value => {
          artifacts = value;
          send({ type: 'artifacts', artifacts: value });
        },
      });
      completed = true;
    } else {
      send({ type: 'status', text: `Starting ${RUNTIMES[config.runtime].name}…` });
      const response = await fetch(`http://127.0.0.1:${state.port}/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.runtimeToken}` },
        body: JSON.stringify({ prompt, history }), signal: abort.signal,
      });
      if (!response.ok) {
        let detail = await response.text();
        if (response.headers.get('content-type')?.includes('application/json')) {
          const payload = JSON.parse(detail);
          if (typeof payload.error === 'string') detail = payload.error;
        }
        throw new Error(`Runtime HTTP ${response.status}: ${detail}`);
      }
      let pending = '';
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === 'text') { event.text = redact(event.text, config); answer += event.text; }
          if (event.type === 'error') throw new Error(event.message);
          if (event.type === 'artifacts' && Array.isArray(event.artifacts)) artifacts = event.artifacts;
          if (event.type === 'done') { completed = true; continue; }
          if (event.text) event.text = redact(event.text, config);
          send(event);
        }
      }
    }
    if (!completed) throw new Error('Runtime stream ended without completion');
    messages.push({ role: 'assistant', content: answer, agentId: config.id, agentName: config.name, artifacts, createdAt: new Date().toISOString() });
    if (sessionId) await store.saveSessionMessages(sessionId, messages);
    else await store.saveMessages(config.id, messages);
    send({ type: 'done' });
  } catch (error) {
    const message = redact(abort.signal.aborted ? (abort.signal.reason?.message || 'Chat cancelled') : error.message, config);
    if (savedUser) {
      if (answer) messages.push({ role: 'assistant', content: answer, agentId: config.id, agentName: config.name, createdAt: new Date().toISOString() });
      messages.push({ role: 'error', content: message, agentId: config.id, agentName: config.name, createdAt: new Date().toISOString() });
      if (sessionId) await store.saveSessionMessages(sessionId, messages);
      else await store.saveMessages(config.id, messages);
    }
    if (send) send({ type: 'error', message });
    else throw error;
  } finally {
    clearInterval(heartbeat);
    chatting.delete(config.id);
    finish();
    if (send && !res.destroyed && !res.writableEnded) res.end();
  }
}

const server = http.createServer(async (req, res) => {
  res.locale = resolveLocale(req.headers['accept-language']);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.url === '/healthz' && req.method === 'GET') return json(res, 200, { status: 'ok' });
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...publicHosts]);
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  if (!aksManaged && !allowedHosts.has(req.headers.host) && !allowedHosts.has(forwardedHost)) return json(res, 403, { error: 'Only local requests are allowed' });
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5173', 'http://localhost:5173', ...publicOrigins]);
  const forwardedProtocol = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const forwardedOrigin = forwardedHost ? `${forwardedProtocol}://${forwardedHost}` : '';
  if (!aksManaged && req.headers.origin && !allowedOrigins.has(req.headers.origin) && req.headers.origin !== forwardedOrigin) return json(res, 403, { error: 'Cross-origin request denied' });
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const segments = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/api/status' && req.method === 'GET') {
      if (aksManaged) {
        let karsConnected = false;
        let runtime;
        try {
          const result = await checkKarsConnection({
            endpoint: karsChatEndpoint,
            token: karsChatToken,
            signal: AbortSignal.timeout(5000),
          });
          karsConnected = result.connected;
          runtime = result.runtime;
        } catch (error) {
          console.error(`KARS connectivity check failed: ${error.message}`);
        }
        return json(res, 200, {
          mode: deploymentMode,
          karsConnected,
          ...(runtime ? { runtime } : {}),
          runtimes: Object.values(RUNTIMES).map(r => ({ ...r, managed: true })),
        });
      }
      try {
        await command(['info', '--format', '{{.ServerVersion}}']);
        const images = (await command(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'])).split('\n');
        return json(res, 200, { docker: true, mode: 'local-direct', runtimes: Object.values(RUNTIMES).map(r => ({ ...r, installed: images.includes(r.image) })) });
      } catch (error) { return json(res, 200, { docker: false, dockerError: localizeMessage(error.message, res.locale), mode: 'local-direct', runtimes: Object.values(RUNTIMES).map(r => ({ ...r, installed: false })) }); }
    }
    if (url.pathname === '/api/providers' && req.method === 'GET') {
      const providers = await store.providers();
      return json(res, 200, Object.fromEntries(Object.keys(RUNTIMES).map(id => [id, publicProvider(providers[id], id)])));
    }
    if (segments[0] === 'api' && segments[1] === 'providers' && segments[2] && !segments[3] && req.method === 'PUT') {
      const runtime = Object.hasOwn(RUNTIMES, segments[2]) ? segments[2] : undefined;
      if (!runtime) throw new Error('Unknown runtime');
      const input = await body(req);
      return await locked(`provider-${runtime}`, async () => {
        const providers = await store.providers();
        providers[runtime] = normalizeProvider(input, runtime, providers[runtime]);
        await store.saveProviders(providers);
        json(res, 200, publicProvider(providers[runtime], runtime));
      });
    }
    if (url.pathname === '/api/sessions') {
      if (req.method === 'GET') return json(res, 200, await store.sessions());
      if (req.method === 'POST') {
        const input = await body(req);
        const agents = await store.list();
        const currentAgentId = input.agentId && agents.some(agent => agent.id === input.agentId) ? input.agentId : null;
        const now = new Date().toISOString();
        const session = { id: randomUUID(), title: 'New session', currentAgentId, createdAt: now, updatedAt: now };
        await store.saveSession(session);
        return json(res, 201, session);
      }
    }
    if (segments[0] === 'api' && segments[1] === 'sessions' && segments[2]) {
      const sessionId = requireId(segments[2]);
      const session = await store.session(sessionId);
      const action = segments[3];
      if (req.method === 'DELETE' && !action) {
        await body(req);
        return await locked(sessionId, async () => {
          await store.deleteSession(sessionId);
          return json(res, 200, { ok: true });
        });
      }
      if (req.method === 'GET' && action === 'messages') return json(res, 200, await store.sessionMessages(sessionId));
      if (req.method === 'POST' && action === 'chat') {
        const input = await body(req);
        return await locked(sessionId, async () => {
          const agents = await store.list();
          const resolved = resolveAgentMention(input.prompt, agents, session.currentAgentId);
          const now = new Date().toISOString();
          await store.saveSession({
            ...session,
            currentAgentId: resolved.agent.id,
            title: session.title === 'New session' ? resolved.prompt.slice(0, 60) : session.title,
            updatedAt: now,
          });
          return await chat(req, res, resolved.agent, resolved.prompt, sessionId);
        });
      }
      if (req.method === 'POST' && action === 'cancel') {
        await body(req);
        const active = session.currentAgentId ? chatting.get(session.currentAgentId) : undefined;
        active?.abort.abort(new Error('Chat cancelled'));
        if (active) await active.done;
        return json(res, 200, { ok: true });
      }
    }
    if (segments[0] === 'api' && segments[1] === 'images' && segments[3] === 'build' && req.method === 'POST') {
      await body(req);
      if (aksManaged) throw new Error('Image builds are managed by KARS on AKS');
      const runtime = Object.hasOwn(RUNTIMES, segments[2]) ? RUNTIMES[segments[2]] : undefined;
      if (!runtime) throw new Error('Unknown runtime');
      if (building) throw new Error('Another image build is already running');
      building = true;
      const send = stream(res);
      try {
        await command(['build', '--build-arg', `RUNTIME=${runtime.id}`, '-t', runtime.image, '-f', path.join(root, 'containers/Dockerfile'), root], { timeout: 1800000, onData: text => send({ type: 'log', text }) });
        send({ type: 'done' });
      } catch (error) { send({ type: 'error', message: error.message }); }
      finally { building = false; res.end(); }
      return;
    }
    if (url.pathname === '/api/agents') {
      if (req.method === 'GET') return json(res, 200, await Promise.all((await store.list()).map(display)));
      if (req.method === 'POST') {
        const config = { ...normalizeConfig(await body(req)), runtimeToken: randomBytes(32).toString('hex') };
        await store.save(config);
        return json(res, 201, aksManaged
          ? await display(config)
          : { ...publicConfig(await configured(config)), status: 'missing' });
      }
    }
    if (segments[0] === 'api' && segments[1] === 'agents' && segments[2]) {
      const id = requireId(segments[2]);
      const config = await store.get(id);
      const action = segments[3];
      if (action === 'skills' && segments[4] && req.method === 'PUT') {
        const skillName = segments[4];
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skillName)) throw new Error('Skill names must be unique lowercase slugs');
        const encodedFileName = String(req.headers['x-skill-filename'] || `${skillName}.zip`);
        let fileName;
        try { fileName = decodeURIComponent(encodedFileName); }
        catch { throw new Error('Skill file name is invalid'); }
        if (!fileName.toLowerCase().endsWith('.zip') || fileName.length > 255 || /[/\\\0]/.test(fileName)) throw new Error('Skill file must be a ZIP archive');
        const archive = await zipBody(req);
        return await locked(id, async () => {
          await store.saveSkillArchive(id, skillName, archive);
          try {
            await execute('python3', [
              path.join(root, 'runtime', 'extract-skill.py'),
              store.skillArchivePath(id, skillName),
              store.skillDirectory(id, skillName),
              skillName,
            ], { timeout: 30000, maxBuffer: 64 * 1024 });
          } catch (error) {
            await store.deleteSkillArchive(id, skillName);
            const detail = String(error.stderr || error.message).trim().split('\n').at(-1);
            throw new Error(`Skill ZIP extraction failed: ${detail}`);
          }
          if (aksManaged) await syncKarsSkill({
            endpoint: karsChatEndpoint,
            token: karsChatToken,
            agentId: id,
            skillName,
            archive,
            signal: AbortSignal.timeout(60000),
          });
          const next = {
            ...config,
            skills: [...config.skills.filter(skill => skill.name !== skillName), {
              name: skillName,
              source: 'archive',
              fileName,
            }],
          };
          await store.save(next);
          return json(res, 200, aksManaged
            ? await display(next)
            : { ...publicConfig(await configured(next)), status: 'missing' });
        });
      }
      if (action === 'artifacts' && req.method === 'GET') {
        if (!aksManaged) {
          const error = new Error('Artifact preview is available in the KARS AKS deployment');
          error.status = 409;
          throw error;
        }
        const relative = url.searchParams.get('path');
        if (!relative) {
          const artifacts = await listKarsArtifacts({
            endpoint: karsChatEndpoint,
            token: karsChatToken,
            agentId: id,
            signal: AbortSignal.timeout(30000),
          });
          return json(res, 200, { artifacts });
        }
        const upstream = await getKarsArtifact({
          endpoint: karsChatEndpoint,
          token: karsChatToken,
          agentId: id,
          relative,
          preview: url.searchParams.get('preview') === '1',
          signal: AbortSignal.timeout(120000),
        });
        const contentType = upstream.headers.get?.('content-type') || upstream.headers['content-type'];
        const contentLength = upstream.headers.get?.('content-length') || upstream.headers['content-length'];
        const contentDisposition = upstream.headers.get?.('content-disposition') || upstream.headers['content-disposition'];
        res.writeHead(200, {
          'Content-Type': contentType || 'application/octet-stream',
          ...(contentLength ? { 'Content-Length': contentLength } : {}),
          ...(contentDisposition ? { 'Content-Disposition': contentDisposition } : {}),
          'Cache-Control': 'private, no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:",
          'X-Content-Type-Options': 'nosniff',
        });
        for await (const chunk of upstream.body) {
          if (res.destroyed) break;
          res.write(chunk);
        }
        if (!res.writableEnded) res.end();
        return;
      }
      if (req.method === 'GET' && action === 'messages') {
        const messages = await store.messages(id);
        return json(res, 200, messages.map(message => message.role === 'error'
          ? { ...message, content: localizeMessage(message.content, res.locale) } : message));
      }
      if (req.method === 'DELETE' && action === 'messages') {
        await body(req);
        return await locked(id, async () => {
          await store.saveMessages(id, []);
          json(res, 200, { ok: true });
        });
      }
      if (req.method === 'POST' && action === 'chat') return await chat(req, res, config, (await body(req)).prompt);
      if (req.method === 'POST' && action === 'cancel') {
        await body(req);
        const active = chatting.get(id);
        active?.abort.abort(new Error('Chat cancelled'));
        if (active) await active.done;
        return json(res, 200, { ok: true });
      }
      if (req.method === 'PUT' && !action) {
        const input = await body(req);
        return await locked(id, async () => {
          const next = { ...normalizeConfig(input, config), runtimeToken: config.runtimeToken };
          const retained = new Set(next.skills.filter(skill => skill.source === 'archive').map(skill => skill.name));
          const removed = config.skills.filter(skill => skill.source === 'archive' && !retained.has(skill.name));
          for (const skill of removed) {
            if (aksManaged) await deleteKarsSkill({
              endpoint: karsChatEndpoint,
              token: karsChatToken,
              agentId: id,
              skillName: skill.name,
              signal: AbortSignal.timeout(30000),
            });
            await store.deleteSkillArchive(id, skill.name);
          }
          await removeRuntime(id);
          await store.save(next);
          json(res, 200, aksManaged
            ? await display(next)
            : { ...publicConfig(await configured(next)), status: 'missing' });
        });
      }
      if (req.method === 'POST' && ['start', 'stop'].includes(action)) {
        await body(req);
        return await locked(id, async () => {
          if (aksManaged) throw new Error('Runtime lifecycle is managed by KARS on AKS');
          if (action === 'start') {
            // The enclosing directory is 0700; the bind-mounted file must be readable by container UID 1000.
            const effective = await configured(config);
            const runtimeFile = path.join(store.directory(id), 'runtime-config.json');
            await writeFile(runtimeFile, JSON.stringify(effective), { mode: 0o644 });
            await startContainer(effective, runtimeFile);
          }
          else {
            const state = await inspect(id);
            if (state.status === 'running') await command(['stop', '--time', '10', containerName(id)]);
          }
          json(res, 200, await display(config));
        });
      }
      if (req.method === 'DELETE' && !action) {
        await body(req);
        return await locked(id, async () => {
          const runtimeRemoved = await removeRuntime(id, { allowUnavailable: true });
          for (const skill of config.skills.filter(item => item.source === 'archive')) {
            if (aksManaged) await deleteKarsSkill({
              endpoint: karsChatEndpoint,
              token: karsChatToken,
              agentId: id,
              skillName: skill.name,
              signal: AbortSignal.timeout(30000),
            });
          }
          // Workspace volumes deliberately survive deletion to prevent accidental data loss.
          await store.deleteAgent(id);
          json(res, 200, { ok: true, runtimeRemoved, retainedVolume: volumeName(id) });
        });
      }
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Endpoint not found' });
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    const dist = path.join(root, 'dist');
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let file = path.resolve(dist, relative || 'index.html');
    if (file !== dist && !file.startsWith(`${dist}${path.sep}`)) return json(res, 403, { error: 'Invalid path' });
    try { if (!(await stat(file)).isFile()) file = path.join(dist, 'index.html'); }
    catch (error) { if (error.code === 'ENOENT') file = path.join(dist, 'index.html'); else throw error; }
    const data = await readFile(file);
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'" });
    res.end(data);
  } catch (error) {
    if (error instanceof SyntaxError) error.message = 'Invalid JSON';
    if (!res.headersSent) json(res, error.status || (error.code === 'ENOENT' ? 404 : 400), { error: error.message, ...(error.code === 'CREDENTIAL_REQUIRED' ? { code: error.code } : {}) });
    else res.end();
  }
});
server.listen(port, host, () => console.log(`KARS BYO Agent Studio: http://${host}:${port}`));
