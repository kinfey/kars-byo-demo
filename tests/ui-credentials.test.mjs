import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { command } from '../server/docker.mjs';

test('bilingual UI preserves edits, localizes feedback, and persists Agent updates and language', {
  skip: !process.env.UI_CDP_URL, timeout: 60000,
}, async () => {
  const base = process.env.UI_BASE_URL || 'http://127.0.0.1:4310';
  async function api(url, method = 'GET', body) {
    const response = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.ok(response.ok, result.error);
    return result;
  }
  const tabs = await (await fetch(`${process.env.UI_CDP_URL}/json/list`)).json();
  const tab = tabs.find(item => item.type === 'page' && (item.url === 'about:blank' || item.url.startsWith(base)));
  assert.ok(tab, 'Use an isolated browser with an about:blank or Studio tab');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    if (response.id && pending.has(response.id)) {
      const callback = pending.get(response.id);
      pending.delete(response.id);
      callback(response);
    }
  });
  async function rpc(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 10000);
      pending.set(id, response => {
        clearTimeout(timer);
        if (response.error) reject(new Error(JSON.stringify(response.error)));
        else resolve(response.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await rpc('Runtime.evaluate', { expression, returnByValue: true });
    assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function waitFor(expression) {
    for (let i = 0; i < 80; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(`Browser condition timed out: ${expression}`);
  }
  async function fill(selector, value, textarea = false) {
    await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(${textarea ? 'HTMLTextAreaElement' : 'HTMLInputElement'}.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', {bubbles: true}));
    })()`);
  }
  async function language(locale) {
    await evaluate(`(() => {
      const select = document.querySelector('#language-select');
      select.value = ${JSON.stringify(locale)};
      select.dispatchEvent(new Event('change', {bubbles: true}));
    })()`);
    await waitFor(`document.documentElement.lang === ${JSON.stringify(locale)}`);
  }
  let agent;
  try {
    await rpc('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const name = `Credential UI smoke ${randomUUID()}`;
    agent = await api('/api/agents', 'POST', { name, runtime: 'copilot' });
    await api(`/api/agents/${agent.id}/start`, 'POST', {});
    await rpc('Page.navigate', { url: `${base}/?lang=zh-CN` });
    const agentButton = `[...document.querySelectorAll('.agent-item')].find(el=>el.textContent.includes(${JSON.stringify(name)}))`;
    await waitFor(`Boolean(${agentButton})`);
    await evaluate(`${agentButton}.click()`);
    await waitFor(`document.querySelector('#credential') && document.querySelector('[role="alert"]')?.textContent.includes('尚未配置')`);
    assert.equal(await evaluate(`document.querySelector('#credential').matches(':disabled')`), false);
    await evaluate(`[...document.querySelectorAll('.tab')].find(el=>el.textContent.includes('对话测试')).click()`);
    await waitFor(`Boolean(document.querySelector('#prompt'))`);
    assert.equal(await evaluate(`document.querySelector('#prompt').disabled`), true);
    assert.equal(await evaluate(`document.querySelector('.chat-composer button[type="submit"]').disabled`), true);
    await evaluate(`[...document.querySelectorAll('.studio-heading-actions button')].find(el=>el.textContent==='编辑配置').click()`);
    await waitFor(`document.activeElement?.id === 'agent-name'`);
    await evaluate(`[...document.querySelectorAll('button')].find(el=>el.textContent==='配置凭据').click()`);
    await waitFor(`document.activeElement?.id === 'credential'`);
    assert.equal(await evaluate(`document.querySelector('#credential').matches(':disabled')`), false);
    assert.equal((await api('/api/agents')).find(item => item.id === agent.id).hasCredential, false);
    const updatedName = `${name} edited`;
    await fill('#agent-name', updatedName);
    await evaluate(`${agentButton}.click()`);
    assert.equal(await evaluate(`document.querySelector('#agent-name').value`), updatedName);
    assert.equal(await evaluate(`document.body.textContent.includes('切换将丢弃修改')`), false);
    await fill('#credential', 'ui-regression-test-not-a-real-token');
    await language('en');
    assert.equal(await evaluate(`document.querySelector('#agent-name').value`), updatedName);
    assert.equal(await evaluate(`document.querySelector('#credential').value`), 'ui-regression-test-not-a-real-token');
    assert.equal(await evaluate(`Boolean(document.querySelector('.unsaved'))`), true);
    assert.equal(await evaluate(`document.querySelector('.studio-heading-actions').textContent.includes('保存修改')`), false);
    assert.match(await evaluate(`document.querySelector('.studio-heading-actions').textContent`), /save/i);
    const untranslated = await evaluate(`(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const remaining = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.nodeValue.trim();
        if (!/[\\u4e00-\\u9fff]/.test(text)) continue;
        if (node.parentElement.closest('#language-select, textarea, input, pre, .message-content, .agent-item-copy strong, .studio-heading-copy h2')) continue;
        if (['中文', '简体中文', '语言', '语言 / Language', 'Language / 语言', '中文 / English'].includes(text)) continue;
        remaining.push(text);
      }
      return remaining;
    })()`);
    assert.deepEqual(untranslated, [], 'English interface must not leave Chinese UI strings behind');
    const portalStyles = await evaluate(`(() => {
      const header = document.querySelector('.topbar');
      const input = document.querySelector('#agent-name');
      return {
        font: getComputedStyle(document.querySelector('.portal-ui')).fontFamily,
        inputSize: getComputedStyle(input).fontSize,
        inputRadius: getComputedStyle(input).borderTopLeftRadius,
        panelRadius: getComputedStyle(document.querySelector('.studio-panel')).borderTopLeftRadius,
        headerHeight: header.getBoundingClientRect().height,
        headerLeft: header.getBoundingClientRect().left,
        headerWidth: header.getBoundingClientRect().width,
        viewport: innerWidth,
      };
    })()`);
    assert.match(portalStyles.font, /^"Segoe UI"/);
    assert.equal(portalStyles.inputSize, '14px');
    assert.equal(portalStyles.inputRadius, '2px');
    assert.equal(portalStyles.panelRadius, '0px');
    assert.equal(portalStyles.headerHeight, 48);
    assert.equal(portalStyles.headerLeft, 0);
    assert.equal(portalStyles.headerWidth, portalStyles.viewport);
    await evaluate(`document.querySelector('.mcp-header .button').click()`);
    await waitFor(`Boolean(document.querySelector('#mcp-endpoint-0'))`);
    await fill('#mcp-endpoint-0', 'not-a-url');
    await waitFor(`Boolean(document.querySelector('.field-error'))`);
    assert.match(await evaluate(`document.querySelector('.field-error').textContent`), /Endpoint/i);
    assert.equal(await evaluate(`/[\\u4e00-\\u9fff]/.test(document.querySelector('.field-error').textContent)`), false);
    await language('zh-CN');
    assert.equal(await evaluate(`/[\\u4e00-\\u9fff]/.test(document.querySelector('.field-error').textContent)`), true);
    await language('en');
    await fill('#mcp-endpoint-0', 'https://mcp.example.com/mcp');
    await fill('#mcp-key-0', 'mcp-test-key');
    await language('zh-CN');
    await fill('#instructions', 'Updated instructions persisted from the browser.', true);
    await evaluate(`document.querySelector('.capability-toggle input').click()`);
    await waitFor(`!document.querySelector('.studio-heading-actions button[form="agent-config-form"]').disabled`);
    await evaluate(`document.querySelector('.studio-heading-actions button[form="agent-config-form"]').click()`);
    await waitFor(`document.querySelector('.notice.success')?.textContent.includes('配置已保存')`);
    const saved = (await api('/api/agents')).find(item => item.id === agent.id);
    assert.equal(saved.name, updatedName);
    assert.equal(saved.hasCredential, true);
    assert.equal(saved.instructions, 'Updated instructions persisted from the browser.');
    assert.equal(saved.tools, true);
    assert.deepEqual(saved.mcpServers, { mcp_01: { type: 'http', url: 'https://mcp.example.com/mcp', hasKey: true } });
    assert.deepEqual(saved.skills, []);
    assert.equal(saved.status, 'missing');
    await rpc('Page.navigate', { url: `${base}/?lang=zh-CN` });
    const updatedButton = `[...document.querySelectorAll('.agent-item')].find(el=>el.textContent.includes(${JSON.stringify(updatedName)}))`;
    await waitFor(`Boolean(${updatedButton})`);
    await evaluate(`${updatedButton}.click()`);
    await waitFor(`document.querySelector('#agent-name')?.value === ${JSON.stringify(updatedName)}`);
    assert.equal(await evaluate(`document.querySelector('#instructions').value`), saved.instructions);
    assert.equal(await evaluate(`document.querySelector('#mcp-endpoint-0').value`), 'https://mcp.example.com/mcp');
    assert.equal(await evaluate(`document.querySelector('#credential').value`), '');
    await language('en');
    await waitFor(`localStorage.getItem('kars-byo-language') === 'en'`);
    await rpc('Page.navigate', { url: base });
    await waitFor(`document.documentElement.lang === 'en' && Boolean(document.querySelector('#language-select'))`);
    assert.equal(await evaluate(`document.querySelector('#language-select').value`), 'en');
    await waitFor(`Boolean(${updatedButton})`);
    await evaluate(`${updatedButton}.click()`);
    await waitFor(`Boolean(document.querySelector('#instructions'))`);
    assert.equal(await evaluate(`document.querySelector('#instructions').value`), saved.instructions);
    await rpc('Page.navigate', { url: `${base}/?lang=zh-CN` });
    await waitFor(`document.documentElement.lang === 'zh-CN' && Boolean(document.querySelector('#language-select'))`);
    for (const locale of ['en', 'zh-CN']) {
      await language(locale);
      await rpc('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false });
      await waitFor(`innerWidth === 375`);
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, `${locale} mobile layout must not overflow`);
      assert.equal(await evaluate(`document.querySelector('#language-select').getBoundingClientRect().right <= innerWidth`), true);
    }
    await rpc('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  } finally {
    ws.close();
    if (agent) {
      const deleted = await api(`/api/agents/${agent.id}`, 'DELETE', {});
      const volumes = await command(['volume', 'ls', '--filter', `name=^${deleted.retainedVolume}$`, '--format', '{{.Name}}']);
      if (volumes) await command(['volume', 'rm', deleted.retainedVolume]);
    }
  }
});
