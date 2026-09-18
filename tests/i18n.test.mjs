import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocale, localizeMessage, messages } from '../server/i18n.mjs';
import {
  catalogs, resolveLocale as resolveUiLocale, translate, getLocale, setLocale, subscribeLocale,
} from '../web/src/i18n.js';

test('API locale negotiation supports both languages and honors quality priorities', () => {
  assert.equal(resolveLocale(), 'zh-CN');
  assert.equal(resolveLocale('en-US,en;q=0.9,zh-CN;q=0.8'), 'en');
  assert.equal(resolveLocale('en;q=0.3,zh-CN;q=0.9'), 'zh-CN');
  assert.equal(resolveLocale('fr,EN-gb;q=0.6'), 'en');
  assert.equal(resolveLocale('en;q=0,zh-CN;q=1'), 'zh-CN');
  assert.equal(resolveLocale('en;q=invalid'), 'zh-CN');
});

test('every application-owned API message has a distinct Chinese and English version', () => {
  for (const [english, chinese] of Object.entries(messages)) {
    assert.ok(english && chinese);
    assert.notEqual(english, chinese);
    assert.equal(localizeMessage(english, 'zh-CN'), chinese);
    assert.equal(localizeMessage(chinese, 'en'), english);
  }
});

test('API validation parameters and known runtime statuses are localized', () => {
  assert.equal(localizeMessage('name must be a string of at most 100 characters', 'zh-CN'), '名称必须是最多 100 个字符的字符串');
  assert.equal(localizeMessage('MCP headers must map names to strings', 'zh-CN'), 'MCP headers 必须是名称到字符串的映射');
  assert.equal(localizeMessage('Starting GitHub Copilot CLI…', 'zh-CN'), '正在启动 GitHub Copilot CLI…');
  assert.equal(localizeMessage('Running tool: workspace_read', 'zh-CN'), '正在执行工具：workspace_read');
  assert.equal(localizeMessage('Tool failed: workspace_read', 'en'), 'Tool failed: workspace_read');
  const missing = 'Missing GitHub Copilot Token. Open Configure, save your credential, and restart the container before chatting.';
  assert.match(localizeMessage(missing, 'zh-CN'), /尚未配置 GitHub Copilot Token/);
  assert.equal(localizeMessage(localizeMessage(missing, 'zh-CN'), 'en'), missing);
});

test('unknown diagnostics and user/model text remain unchanged', () => {
  for (const value of ['My original user prompt', '用户自定义内容', 'Docker build output: npm ERR! E404']) {
    assert.equal(localizeMessage(value, 'en'), value);
    assert.equal(localizeMessage(value, 'zh-CN'), value);
  }
});

test('frontend catalogs cover the same keys with complete English translations', () => {
  assert.deepEqual(Object.keys(catalogs.en).sort(), Object.keys(catalogs['zh-CN']).sort());
  for (const [key, english] of Object.entries(catalogs.en)) {
    assert.equal(typeof english, 'string', key);
    assert.ok(english.trim(), key);
    assert.ok(catalogs['zh-CN'][key].trim(), key);
    if (!key.startsWith('language.')) assert.doesNotMatch(english, /[\u4e00-\u9fff]/, key);
    const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(placeholders(english), placeholders(catalogs['zh-CN'][key]), key);
  }
});

test('UI locale preference resolves URL before saved choice and keeps Chinese as default', () => {
  assert.equal(resolveUiLocale(), 'zh-CN');
  assert.equal(resolveUiLocale({ search: '?lang=en', stored: 'zh-CN' }), 'en');
  assert.equal(resolveUiLocale({ search: '?lang=zh-CN', stored: 'en' }), 'zh-CN');
  assert.equal(resolveUiLocale({ search: '?lang=unknown', stored: 'en' }), 'en');
  assert.equal(resolveUiLocale({ stored: 'invalid' }), 'zh-CN');
});

test('UI translation interpolation preserves user text and locale changes notify subscribers', () => {
  assert.equal(translate('en', 'studio.deleteConfirmTitle', { name: '用户 {name}' }), 'Delete “用户 {name}”?');
  assert.equal(translate('zh-CN', 'studio.editConfig'), '编辑配置');
  const original = getLocale();
  const events = [];
  const unsubscribe = subscribeLocale(() => events.push(getLocale()));
  try {
    setLocale('en');
    setLocale('zh-CN');
    assert.deepEqual(events, ['en', 'zh-CN']);
  } finally { unsubscribe(); setLocale(original); }
});
