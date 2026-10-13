const { test } = require('node:test') as typeof import('node:test');

test('Chinese and English UI resources have matching keys and no silent language fallback', async () => {
  const assert = require('node:assert/strict');

  // Chinese and English interface resources have matching keys
  {
    const { enUS, zhCN } = await import('../../src/web/i18n/resources.ts');
    assert.deepEqual(Object.keys(enUS).sort(), Object.keys(zhCN).sort());
  }

  // English interface resources do not silently fall back to Chinese
  {
    const { enUS } = await import('../../src/web/i18n/resources.ts');
    const untranslated = Object.entries(enUS)
      .filter(([key, value]) => key !== 'settings.language.zhCN' && /[\u3400-\u9fff]/u.test(String(value)))
      .map(([key]) => key);
    assert.deepEqual(untranslated, []);
  }
});
