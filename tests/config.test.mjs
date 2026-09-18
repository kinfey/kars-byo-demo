import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProvider, normalizeConfig, normalizeProvider, publicConfig, publicProvider, requireId, resolveAgentMention } from '../server/config.mjs';
import { buildInvocation } from '../runtime/adapters.mjs';
import { Store } from '../server/store.mjs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const input = { name: 'Research Agent', runtime: 'copilot', credential: 'test-secret' };
test('Copilot keeps required model and never exposes credential/token', () => {
  const config = { ...normalizeConfig(input), runtimeToken: 'private-token' };
  assert.equal(config.model, 'gpt-6-astra');
  assert.equal(publicConfig(config).credential, undefined);
  assert.equal(publicConfig(config).runtimeToken, undefined);
  assert.equal(publicConfig(config).hasCredential, true);
});
test('blank credential on update retains existing value', () => {
  const config = normalizeConfig(input);
  const updated = normalizeConfig({ ...input, credential: '', name: 'Edited' }, config);
  assert.equal(updated.credential, 'test-secret');
  assert.equal(updated.id, config.id);
});

test('MCP keys are redacted publicly and retained when an Agent is edited', () => {
  const config = normalizeConfig({ ...input, mcpServers: {
    mcp_01: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer mcp-secret' } },
  } });
  const visible = publicConfig(config);
  assert.equal(visible.mcpServers.mcp_01.headers, undefined);
  assert.equal(visible.mcpServers.mcp_01.hasKey, true);
  const updated = normalizeConfig({ ...visible, name: 'Edited MCP Agent' }, config);
  assert.equal(updated.mcpServers.mcp_01.headers.Authorization, 'Bearer mcp-secret');
});

test('each Agent keeps one runtime and provider credential', () => {
  const previous = normalizeConfig({ name: 'Agent', runtime: 'copilot', credential: 'copilot-token' });
  assert.throws(
    () => normalizeConfig({ name: 'Agent', runtime: 'claude', credential: 'anthropic-token' }, previous),
    /Create a new agent/,
  );
  assert.equal(previous.runtime, 'copilot');
  assert.equal(previous.credential, 'copilot-token');
});

test('Copilot model is configurable per Agent', () => {
  const config = normalizeConfig({ name: 'Agent', runtime: 'copilot', model: 'gpt-5.4', credential: 'copilot-token' });
  assert.equal(config.model, 'gpt-5.4');
});

test('provider settings are isolated, redacted and override matching Agents only', () => {
  const copilot = normalizeProvider({ model: 'gpt-provider', credential: 'copilot-provider-token' }, 'copilot');
  const claude = normalizeProvider({ model: 'claude-provider', baseUrl: 'https://anthropic.example.test', credential: 'anthropic-provider-token' }, 'claude');
  assert.equal(publicProvider(copilot, 'copilot').hasCredential, true);
  assert.equal(publicProvider(copilot, 'copilot').credential, undefined);
  assert.equal(applyProvider(normalizeConfig(input), copilot).model, 'gpt-provider');
  assert.equal(applyProvider(normalizeConfig({ name: 'Claude', runtime: 'claude' }), claude).credential, 'anthropic-provider-token');
  assert.throws(() => normalizeProvider({ model: 'x', baseUrl: 'file:///etc/passwd' }, 'codex'));
});

test('@Agent routing switches explicitly and otherwise keeps the session Agent', () => {
  const alpha = normalizeConfig({ name: 'Alpha Agent', runtime: 'copilot' });
  const beta = normalizeConfig({ name: 'Beta', runtime: 'claude' });
  const agents = [alpha, beta];
  assert.deepEqual(resolveAgentMention('@Alpha Agent inspect this', agents, null), {
    agent: alpha, prompt: 'inspect this', switched: true,
  });
  assert.equal(resolveAgentMention('continue', agents, alpha.id).agent.id, alpha.id);
  assert.equal(resolveAgentMention('@Beta switch now', agents, alpha.id).agent.id, beta.id);
  assert.throws(() => resolveAgentMention('no initial mention', agents, null), /Start the session/);
  assert.throws(() => resolveAgentMention('@Unknown do work', agents, alpha.id), /Unknown @Agent/);
});

test('KARS CLI invocations use the governed egress proxy', () => {
  const config = normalizeConfig(input);
  const invocation = buildInvocation(config, { profile: 'kars-byo' }, 'Hello');
  assert.equal(invocation.env.HTTPS_PROXY, 'http://127.0.0.1:8444');
  assert.equal(invocation.env.HTTP_PROXY, 'http://127.0.0.1:8444');
  assert.equal(invocation.env.NO_PROXY, '127.0.0.1,localhost');
});
test('reject unsafe paths, API URLs, malformed MCP and skill configs', () => {
  assert.throws(() => requireId('../../etc'));
  assert.throws(() => normalizeConfig({ ...input, model: '-other' }));
  assert.throws(() => normalizeConfig({ ...input, runtime: 'claude', baseUrl: 'file:///etc/passwd' }));
  assert.throws(() => normalizeConfig({ ...input, mcpServers: [] }));
  assert.throws(() => normalizeConfig({ ...input, mcpServers: { local: { command: 'node', args: [1] } } }));
  assert.throws(() => normalizeConfig({ ...input, skills: [{ name: '../escape', content: 'x' }] }));
  assert.throws(() => normalizeConfig({ ...input, tools: 'false' }));
});
test('accept native stdio and streamable HTTP MCP plus skills', () => {
  const config = normalizeConfig({ ...input, tools: true, mcpServers: {
    workspace: { command: 'node', args: ['/opt/kars-byo/runtime/mcp-workspace.mjs'] },
    docs: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer test' } },
  }, skills: [{ name: 'code-review', description: 'Review code', content: 'Explain correctness risks.' }] });
  assert.equal(config.skills[0].name, 'code-review');
  assert.equal(config.tools, true);
});
test('accept ZIP-backed Skill metadata without embedding archive content', () => {
  const config = normalizeConfig({ ...input, skills: [{ name: 'ppt', source: 'archive', fileName: 'ppt.zip' }] });
  assert.deepEqual(config.skills, [{ name: 'ppt', source: 'archive', fileName: 'ppt.zip' }]);
});
test('persistent store restricts directory and credential file permissions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byo-store-test-'));
  try {
    const store = new Store(root);
    await store.init();
    const config = normalizeConfig(input);
    await store.save(config);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(store.directory(config.id), 'config.json'))).mode & 0o777, 0o600);
    assert.deepEqual(await store.messages(config.id), []);
    await store.saveMessages(config.id, [{ role: 'user', content: 'Hello' }]);
    assert.equal((await store.messages(config.id))[0].content, 'Hello');
    const migratedSessions = await store.migrateLegacySessions();
    assert.equal(migratedSessions.length, 1);
    assert.equal((await store.sessionMessages(migratedSessions[0].id))[0].agentName, config.name);
    assert.deepEqual(await store.messages(config.id), []);
    assert.equal((await store.migrateLegacySessions()).length, 1);
    await store.saveProviders({ copilot: normalizeProvider({ model: 'gpt-test', credential: 'provider-secret' }, 'copilot') });
    assert.equal((await store.providers()).copilot.credential, 'provider-secret');
    assert.equal((await stat(path.join(root, 'providers.json'))).mode & 0o777, 0o600);
    assert.equal((await store.list()).length, 1);
    const now = new Date().toISOString();
    const session = { id: crypto.randomUUID(), title: 'Persistent session', currentAgentId: config.id, createdAt: now, updatedAt: now };
    await store.saveSession(session);
    await store.saveSessionMessages(session.id, [{ role: 'user', content: 'Session message', agentId: config.id }]);
    assert.equal((await store.sessions())[0].title, 'Persistent session');
    assert.equal((await store.sessionMessages(session.id))[0].content, 'Session message');
    await store.deleteSession(session.id);
    assert.equal((await store.sessions()).length, 1);
    await store.deleteSession(migratedSessions[0].id);
    assert.deepEqual(await store.migrateLegacySessions(), []);
  } finally { await rm(root, { recursive: true }); }
});

test('legacy per-Agent credentials migrate only when provider settings do not conflict', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byo-provider-migration-'));
  try {
    const store = new Store(root);
    await store.init();
    const first = normalizeConfig({ name: 'First', runtime: 'copilot', model: 'gpt-shared', credential: 'shared-token' });
    const second = normalizeConfig({ name: 'Second', runtime: 'copilot', model: 'gpt-shared', credential: 'shared-token' });
    await store.save(first);
    await store.save(second);
    const providers = await store.migrateLegacyProviders();
    assert.equal(providers.copilot.credential, 'shared-token');
    assert.equal((await store.get(first.id)).credential, '');
    assert.equal((await store.get(second.id)).credential, '');

    const claudeA = normalizeConfig({ name: 'Claude A', runtime: 'claude', credential: 'token-a' });
    const claudeB = normalizeConfig({ name: 'Claude B', runtime: 'claude', credential: 'token-b' });
    await store.save(claudeA);
    await store.save(claudeB);
    await store.migrateLegacyProviders();
    assert.equal((await store.providers()).claude, undefined);
    assert.equal((await store.get(claudeA.id)).credential, 'token-a');
  } finally { await rm(root, { recursive: true }); }
});
