// 配置保存的合并语义：只提交差异时，未提交的键必须保持原值。
import assert from 'node:assert/strict';
import { mergeConfigPatch } from '../lib/index.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}\n  ${error.message}`);
  }
}

const base = {
  provider: 'opencode',
  model: 'gpt-5',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-secret',
  modelName: 'gpt-5-mini',
  turnLimit: 50,
  categoryBatch: 100,
  categoryLimit: 1000,
  digestLevel: 'standard',
  quoteMaxCount: 5,
  quoteMaxChars: 2400,
};

test('只提交 digestLevel 时，模型与索引配置不变', () => {
  const next = mergeConfigPatch(base, { digestLevel: 'rich' });
  assert.equal(next.digestLevel, 'rich');
  assert.equal(next.provider, 'opencode');
  assert.equal(next.model, 'gpt-5');
  assert.equal(next.baseUrl, 'https://api.example.com/v1');
  assert.equal(next.apiKey, 'sk-secret');
  assert.equal(next.modelName, 'gpt-5-mini');
  assert.equal(next.turnLimit, 50);
  assert.equal(next.categoryBatch, 100);
  assert.equal(next.categoryLimit, 1000);
});

test('只提交引用配额时，其它键同样保留', () => {
  const next = mergeConfigPatch(base, { quoteMaxCount: 9 });
  assert.equal(next.quoteMaxCount, 9);
  assert.equal(next.quoteMaxChars, 2400);
  assert.equal(next.digestLevel, 'standard');
  assert.equal(next.apiKey, 'sk-secret');
});

test('显式提交空字符串表示清空该键', () => {
  const next = mergeConfigPatch(base, { apiKey: '', model: '' });
  assert.equal(next.apiKey, '');
  assert.equal(next.model, '');
  assert.equal(next.provider, 'opencode');
});

test('非法值回落当前值，而不是回默认值', () => {
  const next = mergeConfigPatch(base, { turnLimit: -1, quoteMaxCount: 999 });
  assert.equal(next.turnLimit, 50);
  assert.equal(next.quoteMaxCount, 5);
});

test('空 patch 返回与当前等价的对象', () => {
  const next = mergeConfigPatch(base, {});
  assert.deepEqual(next, base);
});

test('没有当前配置时用默认值', () => {
  const next = mergeConfigPatch(null, { digestLevel: 'compact' });
  assert.equal(next.digestLevel, 'compact');
  assert.equal(next.turnLimit, 50);
  assert.equal(next.quoteMaxCount, 5);
  assert.equal(next.quoteMaxChars, 2400);
  assert.equal(next.provider, '');
});

test('布尔与未知键不影响已知键', () => {
  const next = mergeConfigPatch(base, { unknownKey: 'x', digestLevel: 'bogus' });
  assert.equal(next.digestLevel, 'standard');
  assert.equal(next.provider, 'opencode');
  assert.equal('unknownKey' in next, false);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
