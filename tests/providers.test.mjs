import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { normalizeConfig } from '../server/config.mjs';
import { startContainer, removeContainer, command, volumeName } from '../server/docker.mjs';

const output = 'LOCAL_PROVIDER_SMOKE_OK';
function anthropic(res, model) {
  const message = { id: 'msg_smoke', type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of [
    { type: 'message_start', message },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: output } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: 'message_stop' },
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}
function openai(res, model) {
  const part = { type: 'output_text', text: output, annotations: [] };
  const item = { id: 'msg_smoke', type: 'message', role: 'assistant', status: 'completed', content: [part] };
  const response = { id: 'resp_smoke', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model, output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: output },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: output },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  events.forEach((event, sequence_number) => res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`));
  res.end();
}

test('real Claude/Codex CLIs reach a local compatible API and return streamed text', {
  skip: process.env.RUN_PROVIDER_TESTS !== '1', timeout: 240000,
}, async () => {
  const calls = [];
  const provider = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push(req.url);
    if (req.url.includes('count_tokens')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"input_tokens":10}');
    } else if (req.url.includes('/messages')) anthropic(res, body.model);
    else if (req.url.includes('/responses')) openai(res, body.model);
    else { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Unknown local fixture endpoint"}}'); }
  });
  provider.listen(0, '0.0.0.0');
  await once(provider, 'listening');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'byo-provider-test-'));
  try {
    for (const runtime of ['claude', 'codex']) {
      const baseUrl = `http://host.docker.internal:${provider.address().port}${runtime === 'codex' ? '/v1' : ''}`;
      const config = { ...normalizeConfig({ name: `Provider smoke ${runtime}`, runtime, baseUrl, credential: 'local-fixture-key-not-a-real-secret' }), runtimeToken: randomBytes(32).toString('hex') };
      const file = path.join(dir, `${runtime}.json`);
      await writeFile(file, JSON.stringify(config), { mode: 0o644 });
      try {
        const state = await startContainer(config, file);
        const response = await fetch(`http://127.0.0.1:${state.port}/chat`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.runtimeToken}` },
          body: JSON.stringify({ prompt: 'Reply with the local fixture message.', history: [] }),
          signal: AbortSignal.timeout(90000),
        });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        const events = text.trim().split('\n').map(line => JSON.parse(line));
        assert.equal(events.find(e => e.type === 'error'), undefined, text);
        assert.equal(events.filter(e => e.type === 'text').map(e => e.text).join(''), output, text);
        assert.ok(events.some(e => e.type === 'done'), text);
      } finally {
        await removeContainer(config.id);
        const volumes = await command(['volume', 'ls', '--filter', `name=^${volumeName(config.id)}$`, '--format', '{{.Name}}']);
        if (volumes) await command(['volume', 'rm', volumeName(config.id)]);
      }
    }
    assert.ok(calls.some(p => p.includes('/messages')));
    assert.ok(calls.some(p => p.includes('/responses')));
  } finally {
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
    await rm(dir, { recursive: true });
  }
});
