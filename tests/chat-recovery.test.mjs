import test from 'node:test';
import assert from 'node:assert/strict';
import { isRecoverableChatError, recoverChatHistory } from '../web/src/chat-recovery.js';

test('chat recovery recognizes only interrupted stream errors', () => {
  assert.equal(isRecoverableChatError({ i18nKey: 'api.errors.networkFailed' }), true);
  assert.equal(isRecoverableChatError({ i18nKey: 'api.errors.connectionClosed' }), true);
  assert.equal(isRecoverableChatError(new Error('runtime failed')), false);
});

test('chat recovery polls until the persisted assistant response is available', async () => {
  const histories = [
    [{ role: 'user', content: 'old' }, { role: 'user', content: 'new' }],
    [{ role: 'user', content: 'old' }, { role: 'user', content: 'new' }, { role: 'assistant', content: 'done' }],
  ];
  let calls = 0;
  const recovered = await recoverChatHistory(async () => histories[Math.min(calls++, histories.length - 1)], {
    priorMessageCount: 1,
    attempts: 3,
    intervalMs: 0,
    wait: async () => {},
  });
  assert.equal(calls, 2);
  assert.equal(recovered.at(-1).content, 'done');
});

test('chat recovery stops polling after explicit cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const recovered = await recoverChatHistory(async () => { calls += 1; return []; }, {
    priorMessageCount: 0,
    signal: controller.signal,
    wait: async () => {},
  });
  assert.equal(recovered, null);
  assert.equal(calls, 0);
});
