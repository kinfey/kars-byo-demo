import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { promisify } from 'node:util';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);

test('local API persists agents, hides credentials and blocks cross-origin mutation', async () => {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'byo-api-test-'));
  const server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = once(server, 'exit');
  try {
    await Promise.race([
      once(server.stdout, 'data'),
      exit.then(() => { throw new Error('Server exited before listening'); }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Server startup timed out')), 10000); timer.unref(); }),
    ]);
    const base = `http://127.0.0.1:${port}`;
    const blocked = await fetch(`${base}/api/agents`, { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(blocked.status, 403);
    const wrongType = await fetch(`${base}/api/agents`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(wrongType.status, 400);
    const created = await fetch(`${base}/api/agents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Temporary test agent', runtime: 'copilot' }),
    });
    assert.equal(created.status, 201);
    const agent = await created.json();
    assert.equal(agent.model, 'gpt-6-astra');
    assert.equal(agent.credential, undefined);
    assert.equal(agent.runtimeToken, undefined);
    assert.equal(agent.status, 'missing');
    const archivePath = path.join(directory, 'api-skill.zip');
    await execute('python3', ['-c',
      'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],\"w\") as z:z.writestr(\"SKILL.md\",\"# API Skill\\n\")',
      archivePath]);
    const uploaded = await fetch(`${base}/api/agents/${agent.id}/skills/api-skill`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip', 'X-Skill-Filename': 'api-skill.zip' },
      body: await readFile(archivePath),
    });
    const uploadedText = await uploaded.text();
    assert.equal(uploaded.status, 200, uploadedText);
    const skillAgent = JSON.parse(uploadedText);
    assert.deepEqual(skillAgent.skills, [{ name: 'api-skill', source: 'archive', fileName: 'api-skill.zip' }]);
    assert.match(await readFile(path.join(directory, agent.id, 'skills', 'api-skill', 'SKILL.md'), 'utf8'), /^---\nname: api-skill\n[\s\S]*# API Skill\n$/);
    const history = await fetch(`${base}/api/agents/${agent.id}/messages`);
    assert.deepEqual(await history.json(), []);
    const chat = await fetch(`${base}/api/agents/${agent.id}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'Hello' }) });
    assert.equal(chat.status, 409);
    const failure = await chat.json();
    assert.equal(failure.code, 'CREDENTIAL_REQUIRED');
    assert.match(failure.error, /GitHub Copilot Token/);
    assert.match(failure.error, /尚未配置/);
    assert.equal(chat.headers.get('content-language'), 'zh-CN');
    const englishChat = await fetch(`${base}/api/agents/${agent.id}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
      body: JSON.stringify({ prompt: 'Hello' }),
    });
    assert.equal(englishChat.status, 409);
    assert.equal(englishChat.headers.get('content-language'), 'en');
    assert.equal((await englishChat.json()).error, 'Missing GitHub Copilot Token. Open Configure, save your credential, and restart the container before chatting.');
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(sessionResponse.status, 201);
    const session = await sessionResponse.json();
    const initialWithoutMention = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'Hello' }),
    });
    assert.equal(initialWithoutMention.status, 400);
    const mentioned = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '@Temporary test agent Hello' }),
    });
    assert.equal(mentioned.status, 409);
    assert.equal((await mentioned.json()).code, 'CREDENTIAL_REQUIRED');
    const continued = await fetch(`${base}/api/sessions/${session.id}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'Continue' }),
    });
    assert.equal(continued.status, 409);
    const sessions = await (await fetch(`${base}/api/sessions`)).json();
    assert.equal(sessions[0].currentAgentId, agent.id);
    assert.equal(sessions[0].title, 'Hello');
    assert.deepEqual(await (await fetch(`${base}/api/sessions/${session.id}/messages`)).json(), []);
    const deletedSession = await fetch(`${base}/api/sessions/${session.id}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(deletedSession.status, 200);
    assert.deepEqual(await (await fetch(`${base}/api/sessions`)).json(), []);
    for (const [locale, expected] of [['zh-CN', '请填写 Agent 名称'], ['en', 'Agent name is required']]) {
      const invalid = await fetch(`${base}/api/agents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Language': locale },
        body: JSON.stringify({ name: '', runtime: 'copilot' }),
      });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error, expected);
    }
    const cancel = await fetch(`${base}/api/agents/${agent.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(cancel.status, 200);
    const clearHistory = await fetch(`${base}/api/agents/${agent.id}/messages`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(clearHistory.status, 200);
    assert.deepEqual(await (await fetch(`${base}/api/agents/${agent.id}/messages`)).json(), []);
    const deleted = await fetch(`${base}/api/agents/${agent.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const deletedPayload = await deleted.json();
    assert.equal(deleted.status, 200, JSON.stringify(deletedPayload));
    const providerSaved = await fetch(`${base}/api/providers/codex`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'codex-provider-model', baseUrl: 'https://openai.example.test/v1', credential: 'provider-secret' }),
    });
    assert.equal(providerSaved.status, 200);
    const publicProvider = await providerSaved.json();
    assert.equal(publicProvider.hasCredential, true);
    assert.equal(publicProvider.credential, undefined);
    const providers = await (await fetch(`${base}/api/providers`)).json();
    assert.equal(providers.codex.model, 'codex-provider-model');
    assert.equal(providers.claude.configured, false);
    const codexCreated = await fetch(`${base}/api/agents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Shared provider Agent', runtime: 'codex' }),
    });
    const codexAgent = await codexCreated.json();
    assert.equal(codexAgent.model, 'codex-provider-model');
    assert.equal(codexAgent.hasCredential, true);
    assert.equal(codexAgent.credential, undefined);
    assert.equal((await fetch(`${base}/api/agents/${codexAgent.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
    assert.deepEqual(await (await fetch(`${base}/api/agents`)).json(), []);
  } finally {
    server.kill('SIGTERM');
    await exit;
    await rm(directory, { recursive: true });
  }
});
