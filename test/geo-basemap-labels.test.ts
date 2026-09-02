const { test } = require('node:test');
const assert = require('node:assert/strict');

test('basemap localization targets bilingual names without changing road shields', async () => {
  const { usesLocalBasemapName } = await import('../src/public/visualization/geo/geo-basemap-labels.ts');

  assert.equal(usesLocalBasemapName([
    'case',
    ['has', 'name:nonlatin'],
    ['concat', ['get', 'name:latin'], ' ', ['get', 'name:nonlatin']],
    ['get', 'name'],
  ]), true);
  assert.equal(usesLocalBasemapName(['to-string', ['get', 'ref']]), false);
});
