const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Chinese and English interface resources have matching keys', async () => {
  const { enUS, zhCN } = await import('../src/web/i18n/resources.ts');
  assert.deepEqual(Object.keys(enUS).sort(), Object.keys(zhCN).sort());
});

test('English interface resources do not silently fall back to Chinese', async () => {
  const { enUS } = await import('../src/web/i18n/resources.ts');
  const untranslated = Object.entries(enUS)
    .filter(([key, value]) => key !== 'settings.language.zhCN' && /[\u3400-\u9fff]/u.test(String(value)))
    .map(([key]) => key);
  assert.deepEqual(untranslated, []);
});
