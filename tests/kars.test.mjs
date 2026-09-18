import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { checkKarsConnection, getKarsArtifact, karsMessages, listKarsArtifacts, streamKarsChat, syncKarsSkill } from '../server/kars.mjs';

const config = {
  name: 'AKS Agent',
  instructions: 'Keep answers concise.',
  skills: [{ name: 'review', description: 'Review code', content: 'Find correctness bugs.' }],
};

test('KARS messages include agent configuration and conversation history', () => {
  const messages = karsMessages(config, [{ role: 'assistant', content: 'Earlier' }], 'Hello');
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /Keep answers concise/);
  assert.match(messages[0].content, /Find correctness bugs/);
  assert.deepEqual(messages.slice(1), [
    { role: 'assistant', content: 'Earlier' },
    { role: 'user', content: 'Hello' },
  ]);
});

test('ZIP Skills synchronize through the KARS service proxy', async () => {
  let request;
  mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url: String(url), options };
    return new Response('{"ok":true}', { status: 200 });
  });
  try {
    const archive = Buffer.from('zip-bytes');
    await syncKarsSkill({
      endpoint: 'https://aks.example/api/v1/namespaces/ns/services/runtime/proxy/chat',
      token: 'aks-token',
      agentId: '11111111-1111-1111-1111-111111111111',
      skillName: 'ppt',
      archive,
    });
    assert.match(request.url, /\/proxy\/skills\/11111111-1111-1111-1111-111111111111\/ppt$/);
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers['Content-Type'], 'application/zip');
    assert.equal(request.options.body, archive);
  } finally {
    mock.restoreAll();
  }
});

test('KARS client authenticates and converts OpenAI SSE text', async () => {
  let request;
  mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, authorization: options.headers.Authorization, body: JSON.parse(options.body) };
    return new Response([
      'data: {"choices":[{"delta":{"content":"KARS "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"works"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const parts = [];
  try {
    const answer = await streamKarsChat({
      endpoint: 'https://kars.example/v1/chat/completions',
      token: 'bridge-token',
      model: 'gpt-6-astra',
      config,
      history: [],
      prompt: 'Hello',
      onText: text => parts.push(text),
    });
    assert.equal(answer, 'KARS works');
    assert.deepEqual(parts, ['KARS ', 'works']);
    assert.equal(request.authorization, 'Bearer bridge-token');
    assert.equal(request.body.reasoning_effort, 'none');
    assert.equal(request.body.stream, true);
    assert.equal(request.body.model, 'gpt-6-astra');
  } finally {
    mock.restoreAll();
  }
});

test('KARS connection check uses the authenticated router health endpoint', async () => {
  let request;
  mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url: String(url), method: options.method, authorization: options.headers.Authorization };
    return new Response('ok');
  });
  try {
    assert.deepEqual(await checkKarsConnection({
      endpoint: 'https://kars.example/service/proxy/v1/chat/completions',
      token: 'bridge-token',
    }), { connected: true });
    assert.deepEqual(request, {
      url: 'https://kars.example/service/proxy/healthz',
      method: 'GET',
      authorization: 'Bearer bridge-token',
    });
  } finally {
    mock.restoreAll();
  }
});

test('KARS multi-CLI runtime health proves all CLIs are loaded', async () => {
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    status: 'ok',
    runtime: 'multi-cli',
    runtimes: {
      claude: { cli: 'Claude Code CLI', cliLoaded: true, cliVersion: '2.1.263' },
      copilot: { cli: 'GitHub Copilot CLI', cliLoaded: true, cliVersion: '1.0.83' },
      codex: { cli: 'Codex CLI', cliLoaded: true, cliVersion: '0.152.0' },
    },
    profile: 'kars-byo',
  })));
  try {
    assert.deepEqual(await checkKarsConnection({
      endpoint: 'https://kars.example/service/proxy/chat',
      token: 'aks-token',
    }), {
      connected: true,
      runtime: {
        status: 'ok',
        runtime: 'multi-cli',
        runtimes: {
          claude: { cli: 'Claude Code CLI', cliLoaded: true, cliVersion: '2.1.263' },
          copilot: { cli: 'GitHub Copilot CLI', cliLoaded: true, cliVersion: '1.0.83' },
          codex: { cli: 'Codex CLI', cliLoaded: true, cliVersion: '0.152.0' },
        },
        profile: 'kars-byo',
      },
    });
  } finally {
    mock.restoreAll();
  }
});

test('KARS Copilot runtime receives Agent configuration and streams CLI events', async () => {
  let request;
  mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url: String(url), body: JSON.parse(options.body) };
    return new Response([
      '{"type":"heartbeat"}',
      '{"type":"status","text":"GitHub Copilot CLI 1.0.83 loaded in KARS"}',
      '{"type":"text","text":"CLI works"}',
      '{"type":"artifacts","artifacts":[{"path":"deck.pptx","name":"deck.pptx","type":"office","size":10}]}',
      '{"type":"done"}',
      '',
    ].join('\n'));
  });
  const parts = [];
  const statuses = [];
  const artifacts = [];
  try {
    const answer = await streamKarsChat({
      endpoint: 'https://kars.example/service/proxy/chat',
      token: 'aks-token',
      model: 'gpt-6-astra',
      config: {
        ...config,
        id: '11111111-1111-1111-1111-111111111111',
        runtime: 'copilot',
        model: 'gpt-6-astra',
        baseUrl: 'https://provider.example/v1',
        credential: 'github-token',
        tools: false,
        mcpServers: {},
      },
      history: [],
      prompt: 'Hello',
      onText: text => parts.push(text),
      onStatus: text => statuses.push(text),
      onArtifacts: value => artifacts.push(...value),
    });
    assert.equal(answer, 'CLI works');
    assert.deepEqual(parts, ['CLI works']);
    assert.deepEqual(statuses, ['GitHub Copilot CLI 1.0.83 loaded in KARS']);
    assert.equal(artifacts[0].path, 'deck.pptx');
    assert.equal(request.body.config.runtime, 'copilot');
    assert.equal(request.body.config.credential, 'github-token');
    assert.equal(request.body.config.baseUrl, 'https://provider.example/v1');
    assert.equal(request.body.prompt, 'Hello');
  } finally {
    mock.restoreAll();
  }
});

test('KARS artifact proxy lists files and preserves preview query parameters', async () => {
  const requests = [];
  mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    if (String(url).includes('path=')) return new Response('pdf', { headers: { 'Content-Type': 'application/pdf' } });
    return new Response(JSON.stringify({ artifacts: [{ path: 'deck.pptx', type: 'office' }] }));
  });
  try {
    const artifacts = await listKarsArtifacts({
      endpoint: 'https://kars.example/service/proxy/chat',
      token: 'aks-token',
      agentId: '11111111-1111-1111-1111-111111111111',
    });
    assert.equal(artifacts[0].path, 'deck.pptx');
    const response = await getKarsArtifact({
      endpoint: 'https://kars.example/service/proxy/chat',
      token: 'aks-token',
      agentId: '11111111-1111-1111-1111-111111111111',
      relative: 'folder/deck.pptx',
      preview: true,
    });
    assert.equal(await response.text(), 'pdf');
    assert.match(requests[1], /\/proxy\/artifacts\/11111111-1111-1111-1111-111111111111\?/);
    assert.match(requests[1], /path=folder%2Fdeck\.pptx/);
    assert.match(requests[1], /preview=1/);
  } finally {
    mock.restoreAll();
  }
});
