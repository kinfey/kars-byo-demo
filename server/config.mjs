import { randomUUID } from 'node:crypto';

export const RUNTIMES = {
  claude: { id: 'claude', name: 'Claude Code CLI', image: 'kars-byo/claude:local', model: 'claude-sonnet-4-6', baseUrl: 'https://api.anthropic.com' },
  copilot: { id: 'copilot', name: 'GitHub Copilot CLI', image: 'kars-byo/copilot:local', model: 'gpt-6-astra', baseUrl: '' },
  codex: { id: 'codex', name: 'Codex CLI', image: 'kars-byo/codex:local', model: 'gpt-5.4', baseUrl: 'https://api.openai.com/v1' },
};

export function requireId(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid agent ID');
  return id;
}

function text(value, name, max, fallback = '') {
  const result = value ?? fallback;
  if (typeof result !== 'string' || result.length > max) throw new Error(`${name} must be a string of at most ${max} characters`);
  return result;
}

export function normalizeConfig(input, previous) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected an agent configuration object');
  const runtime = Object.hasOwn(RUNTIMES, input.runtime) ? RUNTIMES[input.runtime] : undefined;
  if (!runtime) throw new Error('Select claude, copilot or codex');
  const runtimeChanged = previous && previous.runtime !== input.runtime;
  if (runtimeChanged) throw new Error('Create a new agent to change its runtime');
  const name = text(input.name, 'name', 100).trim();
  if (!name) throw new Error('Agent name is required');
  const model = text(input.model, 'model', 160, runtime.model).trim();
  if (!model || model.startsWith('-')) throw new Error('Model is invalid');
  const baseUrl = runtime.id === 'copilot' ? '' : text(input.baseUrl, 'baseUrl', 2048, runtime.baseUrl).replace(/\/+$/, '');
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API base URL must be HTTP(S), without credentials, query or fragment');
  }
  const credential = text(input.credential, 'credential', 16000) || previous?.credential || '';
  if (/[\r\n\0]/.test(credential)) throw new Error('Credential must be a single line');
  const submittedMcpServers = input.mcpServers ?? {};
  if (!submittedMcpServers || typeof submittedMcpServers !== 'object' || Array.isArray(submittedMcpServers) || Object.keys(submittedMcpServers).length > 20) throw new Error('MCP servers must be an object with at most 20 servers');
  const mcpServers = Object.fromEntries(Object.entries(submittedMcpServers).map(([key, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [key, value];
    const server = { ...value };
    delete server.hasKey;
    for (const field of ['headers', 'env']) {
      if (!Object.hasOwn(server, field) && previous?.mcpServers?.[key]?.[field]) server[field] = previous.mcpServers[key][field];
    }
    return [key, server];
  }));
  if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers) || Object.keys(mcpServers).length > 20) throw new Error('MCP servers must be an object with at most 20 servers');
  for (const [key, server] of Object.entries(mcpServers)) {
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(key) || !server || typeof server !== 'object') throw new Error('Invalid MCP server name/configuration');
    if (server.url) {
      const url = new URL(server.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid MCP HTTP URL');
      if (server.type && server.type !== 'http') throw new Error('Only streamable HTTP and stdio MCP are supported');
    } else if (typeof server.command !== 'string' || !server.command || server.command.startsWith('-')) {
      throw new Error('MCP stdio servers require a command');
    }
    if (server.args && (!Array.isArray(server.args) || server.args.some(a => typeof a !== 'string'))) throw new Error('MCP args must be strings');
    for (const field of ['env', 'headers']) {
      if (server[field] && (typeof server[field] !== 'object' || Array.isArray(server[field]) || Object.values(server[field]).some(v => typeof v !== 'string'))) throw new Error(`MCP ${field} must map names to strings`);
    }
  }
  if (JSON.stringify(mcpServers).length > 64000) throw new Error('MCP configuration is too large');
  const skills = input.skills ?? [];
  if (!Array.isArray(skills) || skills.length > 30) throw new Error('At most 30 skills are allowed');
  const names = new Set();
  for (const skill of skills) {
    if (!skill || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill.name) || names.has(skill.name)) throw new Error('Skill names must be unique lowercase slugs');
    names.add(skill.name);
    text(skill.description, 'Skill description', 1000);
    if (skill.source === 'archive') {
      if (skill.fileName !== undefined) text(skill.fileName, 'Skill file name', 255);
    } else if (!text(skill.content, 'Skill content', 64000).trim()) throw new Error('Skill content is required');
  }
  if (input.tools !== undefined && typeof input.tools !== 'boolean') throw new Error('tools must be boolean');
  return {
    id: previous?.id ?? randomUUID(), name, runtime: runtime.id, model, baseUrl, credential,
    instructions: text(input.instructions, 'instructions', 64000), tools: input.tools ?? false,
    mcpServers, skills, createdAt: previous?.createdAt ?? new Date().toISOString(),
  };
}

export function publicConfig(config) {
  const { credential, runtimeToken, ...rest } = config;
  const mcpServers = Object.fromEntries(Object.entries(rest.mcpServers || {}).map(([name, source]) => {
    const { headers, env, ...server } = source;
    return [name, { ...server, hasKey: Boolean(Object.keys(headers || {}).length || Object.keys(env || {}).length) }];
  }));
  return { ...rest, mcpServers, hasCredential: Boolean(credential) };
}

export function normalizeProvider(input, runtimeId, previous) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a provider configuration object');
  const runtime = Object.hasOwn(RUNTIMES, runtimeId) ? RUNTIMES[runtimeId] : undefined;
  if (!runtime) throw new Error('Select claude, copilot or codex');
  const model = text(input.model, 'model', 160, previous?.model || runtime.model).trim();
  if (!model || model.startsWith('-')) throw new Error('Model is invalid');
  const baseUrl = runtime.id === 'copilot'
    ? ''
    : text(input.baseUrl, 'baseUrl', 2048, previous?.baseUrl || runtime.baseUrl).replace(/\/+$/, '');
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('API base URL must be HTTP(S), without credentials, query or fragment');
    }
  }
  const credential = text(input.credential, 'credential', 16000) || previous?.credential || '';
  if (/[\r\n\0]/.test(credential)) throw new Error('Credential must be a single line');
  return { runtime: runtime.id, model, baseUrl, credential, updatedAt: new Date().toISOString() };
}

export function publicProvider(provider, runtimeId) {
  const runtime = RUNTIMES[runtimeId];
  const { credential, ...rest } = provider || {};
  return {
    runtime: runtimeId,
    model: rest.model || runtime.model,
    baseUrl: runtimeId === 'copilot' ? '' : (rest.baseUrl || runtime.baseUrl),
    hasCredential: Boolean(credential),
    configured: Boolean(provider),
    ...(rest.updatedAt ? { updatedAt: rest.updatedAt } : {}),
  };
}

export function applyProvider(config, provider) {
  if (!provider) return config;
  return {
    ...config,
    model: provider.model,
    baseUrl: provider.baseUrl,
    credential: provider.credential,
  };
}

export function resolveAgentMention(prompt, agents, currentAgentId) {
  const value = text(prompt, 'prompt', 64000).trim();
  if (!value) throw new Error('Prompt must contain 1–64000 characters');
  if (value.startsWith('@')) {
    const ordered = [...agents].sort((a, b) => b.name.length - a.name.length);
    const lower = value.toLocaleLowerCase();
    const agent = ordered.find(candidate => {
      const mention = `@${candidate.name}`.toLocaleLowerCase();
      return lower.startsWith(mention) && (value.length === mention.length || /\s/.test(value[mention.length]));
    });
    if (!agent) throw new Error('Unknown @Agent mention');
    const command = value.slice(agent.name.length + 1).trim();
    if (!command) throw new Error('Enter an instruction after @Agent');
    return { agent, prompt: command, switched: agent.id !== currentAgentId };
  }
  const agent = agents.find(candidate => candidate.id === currentAgentId);
  if (!agent) throw new Error('Start the session with @Agent followed by an instruction');
  return { agent, prompt: value, switched: false };
}
