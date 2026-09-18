import https from 'node:https';
import { readFile } from 'node:fs/promises';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const AKS_AUDIENCE = '6dae42f8-4368-4678-94ff-3960e28e3630';
let cachedIdentityToken;

function systemMessage(config) {
  const sections = [`You are ${config.name}.`];
  if (config.instructions.trim()) sections.push(config.instructions.trim());
  if (config.skills.length) {
    sections.push(`Apply these configured skills when relevant:\n${config.skills.map(skill =>
      `## ${skill.name}\n${skill.description ? `${skill.description}\n` : ''}${skill.content || 'Load this Skill from the configured runtime skills directory.'}`,
    ).join('\n\n')}`);
  }
  return sections.join('\n\n');
}

export function karsMessages(config, history, prompt) {
  return [
    { role: 'system', content: systemMessage(config) },
    ...history,
    { role: 'user', content: prompt },
  ];
}

function responseError(status, payload) {
  const detail = payload?.error?.message || payload?.error || payload?.message || JSON.stringify(payload);
  return new Error(`KARS HTTP ${status}: ${detail}`);
}

function endpointUrl(endpoint) {
  if (!endpoint) throw new Error('KARS chat endpoint is not configured');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('KARS chat endpoint must be an HTTPS URL without credentials, query or fragment');
  }
  return url;
}

async function managedIdentityToken(signal) {
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const identityHeader = process.env.IDENTITY_HEADER;
  if (!endpoint || !identityHeader) throw new Error('ACA managed identity endpoint is unavailable');
  if (cachedIdentityToken?.expiresAt > Date.now() + 60000) return cachedIdentityToken.value;
  const url = new URL(endpoint);
  url.searchParams.set('api-version', '2019-08-01');
  url.searchParams.set('resource', AKS_AUDIENCE);
  if (process.env.AZURE_CLIENT_ID) url.searchParams.set('client_id', process.env.AZURE_CLIENT_ID);
  const response = await fetch(url, { headers: { 'X-IDENTITY-HEADER': identityHeader }, signal });
  const payload = await response.json();
  if (!response.ok || !payload.access_token) throw responseError(response.status, payload);
  const expiresAt = Number(payload.expires_on) * 1000 || Date.now() + Number(payload.expires_in || 300) * 1000;
  cachedIdentityToken = { value: payload.access_token, expiresAt };
  return cachedIdentityToken.value;
}

async function karsRequest(url, options) {
  const caFile = process.env.KARS_CA_CERT_FILE;
  if (!caFile) return fetch(url, options);
  const ca = await readFile(caFile);
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: options.method, headers: options.headers, ca }, response => {
      resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        headers: response.headers,
        body: response,
        text: async () => {
          let value = '';
          for await (const chunk of response) value += chunk;
          return value;
        },
      });
    });
    const abort = () => request.destroy(options.signal.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    request.on('close', () => options.signal?.removeEventListener('abort', abort));
    request.on('error', reject);
    request.end(options.body);
  });
}

export async function checkKarsConnection({ endpoint, token, signal }) {
  const url = endpointUrl(endpoint);
  const cliRuntime = url.pathname.endsWith('/chat');
  if (cliRuntime) url.pathname = `${url.pathname.slice(0, -'/chat'.length)}/healthz`;
  else if (url.pathname.endsWith('/v1/chat/completions')) {
    url.pathname = `${url.pathname.slice(0, -'/v1/chat/completions'.length)}/healthz`;
  } else throw new Error('Unsupported KARS chat endpoint');
  const authorization = token || await managedIdentityToken(signal);
  const response = await karsRequest(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${authorization}` },
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    let payload = text;
    try { payload = JSON.parse(text); } catch {}
    throw responseError(response.status, payload);
  }
  const text = (await response.text()).trim();
  if (!cliRuntime) return { connected: text === 'ok' };
  const runtime = JSON.parse(text);
  const loaded = runtime.runtimes && Object.values(runtime.runtimes).length === 3 &&
    Object.values(runtime.runtimes).every(cli => cli.cliLoaded === true && cli.cliVersion);
  return {
    connected: runtime.status === 'ok' && runtime.runtime === 'multi-cli' && Boolean(loaded),
    runtime,
  };
}

function karsSkillUrl(endpoint, agentId, skillName) {
  const url = endpointUrl(endpoint);
  if (!url.pathname.endsWith('/chat')) throw new Error('KARS Skill sync requires the CLI runtime endpoint');
  url.pathname = `${url.pathname.slice(0, -'/chat'.length)}/skills/${encodeURIComponent(agentId)}/${encodeURIComponent(skillName)}`;
  return url;
}

function karsArtifactUrl(endpoint, agentId, relative, preview) {
  const url = endpointUrl(endpoint);
  if (!url.pathname.endsWith('/chat')) throw new Error('KARS artifact access requires the CLI runtime endpoint');
  url.pathname = `${url.pathname.slice(0, -'/chat'.length)}/artifacts/${encodeURIComponent(agentId)}`;
  if (relative) url.searchParams.set('path', relative);
  if (preview) url.searchParams.set('preview', '1');
  return url;
}

export async function listKarsArtifacts({ endpoint, token, agentId, signal }) {
  const authorization = token || await managedIdentityToken(signal);
  const response = await karsRequest(karsArtifactUrl(endpoint, agentId), {
    method: 'GET',
    headers: { Authorization: ['Bearer', authorization].join(' ') },
    signal,
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('KARS artifact list returned invalid JSON'); }
  if (!response.ok) throw responseError(response.status, payload);
  return payload.artifacts || [];
}

export async function getKarsArtifact({ endpoint, token, agentId, relative, preview, signal }) {
  const authorization = token || await managedIdentityToken(signal);
  const response = await karsRequest(karsArtifactUrl(endpoint, agentId, relative, preview), {
    method: 'GET',
    headers: { Authorization: ['Bearer', authorization].join(' ') },
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    let payload = text;
    try { payload = JSON.parse(text); } catch {}
    throw responseError(response.status, payload);
  }
  return response;
}

export async function syncKarsSkill({ endpoint, token, agentId, skillName, archive, signal }) {
  const authorization = token || await managedIdentityToken(signal);
  const response = await karsRequest(karsSkillUrl(endpoint, agentId, skillName), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${authorization}`,
      'Content-Type': 'application/zip',
      'Content-Length': String(archive.length),
    },
    body: archive,
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    let payload = text;
    try { payload = JSON.parse(text); } catch {}
    throw responseError(response.status, payload);
  }
}

export async function deleteKarsSkill({ endpoint, token, agentId, skillName, signal }) {
  const authorization = token || await managedIdentityToken(signal);
  const url = karsSkillUrl(endpoint, agentId, skillName);
  url.pathname += '/delete';
  const response = await karsRequest(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authorization}` },
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    let payload = text;
    try { payload = JSON.parse(text); } catch {}
    throw responseError(response.status, payload);
  }
}

export async function streamKarsChat({ endpoint, token, model, config, history, prompt, signal, onText, onStatus = () => {}, onArtifacts = () => {} }) {
  const url = endpointUrl(endpoint);
  const cliRuntime = url.pathname.endsWith('/chat');
  const authorization = token || await managedIdentityToken(signal);
  const response = await karsRequest(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authorization}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cliRuntime ? {
      config: {
        id: config.id,
        name: config.name,
        runtime: config.runtime,
        model: config.model,
        baseUrl: config.baseUrl,
        credential: config.credential,
        instructions: config.instructions,
        tools: config.tools,
        mcpServers: config.mcpServers,
        skills: config.skills,
      },
      history,
      prompt,
    } : {
      model,
      messages: karsMessages(config, history, prompt),
      reasoning_effort: 'none',
      stream: true,
    }),
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    let payload = text;
    try { payload = JSON.parse(text); } catch {}
    throw responseError(response.status, payload);
  }
  if (!response.body) throw new Error('KARS response stream is unavailable');

  let pending = '';
  let answer = '';
  let completed = false;
  const decoder = new TextDecoder();
  const receive = line => {
    if (cliRuntime) {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'error') throw new Error(event.message || 'GitHub Copilot CLI failed');
      if (event.type === 'status') onStatus(event.text);
      if (event.type === 'artifacts' && Array.isArray(event.artifacts)) onArtifacts(event.artifacts);
      if (event.type === 'done') completed = true;
      if (event.type !== 'text' || typeof event.text !== 'string' || !event.text) return;
      answer += event.text;
      if (Buffer.byteLength(answer) > MAX_OUTPUT_BYTES) throw new Error('KARS response exceeded 4 MiB');
      onText(event.text);
      return;
    }
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') {
      completed = true;
      return;
    }
    const event = JSON.parse(data);
    if (event.error) throw responseError(response.status, event);
    const text = event.choices?.[0]?.delta?.content;
    if (typeof text !== 'string' || !text) return;
    answer += text;
    if (Buffer.byteLength(answer) > MAX_OUTPUT_BYTES) throw new Error('KARS response exceeded 4 MiB');
    onText(text);
  };
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      receive(line);
    }
  }
  pending += decoder.decode();
  if (pending) receive(pending.replace(/\r$/, ''));
  if (!completed) throw new Error('KARS response stream ended without completion');
  if (!answer) throw new Error('KARS completed without an assistant response');
  return answer;
}
