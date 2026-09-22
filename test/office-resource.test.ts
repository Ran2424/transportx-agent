const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Office resource loading requires bounded HEAD metadata and maps version errors', async (t: import('node:test').TestContext) => {
  const { loadOfficeResource, OfficeResourceError, OFFICE_PREVIEW_MAX_BYTES } = await import('../src/web/features/office/office-resource.ts');
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => new Response(null, { status: 200 });
  await assert.rejects(() => loadOfficeResource('/missing-length', new AbortController().signal), (error: unknown) => error instanceof OfficeResourceError && error.code === 'length-required');

  globalThis.fetch = async () => new Response(null, { status: 200, headers: { 'Content-Length': String(OFFICE_PREVIEW_MAX_BYTES + 1) } });
  await assert.rejects(() => loadOfficeResource('/too-large', new AbortController().signal), (error: unknown) => error instanceof OfficeResourceError && error.code === 'too-large');

  globalThis.fetch = async () => new Response(null, { status: 409 });
  await assert.rejects(() => loadOfficeResource('/changed', new AbortController().signal), (error: unknown) => error instanceof OfficeResourceError && error.code === 'version-changed');

  let request = 0;
  globalThis.fetch = async (_input, init) => {
    request += 1;
    assert.equal(init?.signal instanceof AbortSignal, true);
    if (request === 1) return new Response(null, { status: 200, headers: { 'Content-Length': '5' } });
    return new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 });
  };
  assert.deepEqual([...new Uint8Array(await loadOfficeResource('/document.docx', new AbortController().signal))], [1, 2, 3, 4, 5]);
  assert.equal(request, 2);
});
