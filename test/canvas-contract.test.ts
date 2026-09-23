const { test } = require('node:test');
const assert = require('node:assert/strict');

async function canvasContract() { return import('../src/contracts/canvas.ts'); }

const base = {
  protocol: 'pi-canvas',
  version: '1.0',
  presentationId: 'presentation-1',
  adapterId: 'com.transportx.canvas.document',
  kind: 'document',
  viewId: 'document:slides',
  revision: 0,
  operation: 'present',
  title: '路口分析',
  resources: [{ scope: 'session-file', path: 'reports/slides.pptx' }],
  payload: { format: 'pptx' },
  target: { kind: 'slide', number: 8 },
  generatedAt: '2026-09-23T10:00:00+08:00',
};

test('Canvas presentation accepts bounded adapter data and safe resources', async () => {
  const { parseCanvasPresentationStructured, getCanvasPresentationFromToolResult } = await canvasContract();
  const parsed = parseCanvasPresentationStructured(base);
  assert.equal(parsed.ok, true);
  assert.deepEqual(getCanvasPresentationFromToolResult({ details: { canvas: base } }), base);
});

test('Canvas presentation rejects unsafe paths, versions and oversized adapter data', async () => {
  const { parseCanvasPresentationStructured, CANVAS_MAX_JSON_BYTES } = await canvasContract();
  assert.equal(parseCanvasPresentationStructured({ ...base, resources: [{ scope: 'session-file', path: '../secret.pptx' }] }).ok, false);
  assert.equal(parseCanvasPresentationStructured({ ...base, version: '2.0' }).ok, false);
  assert.equal(parseCanvasPresentationStructured({ ...base, payload: { text: 'x'.repeat(CANVAS_MAX_JSON_BYTES) } }).ok, false);
  assert.equal(parseCanvasPresentationStructured({ ...base, revision: 0.5 }).ok, false);
});

test('Canvas resource scopes and explicit context share the same guarded references', async () => {
  const { parseCanvasContextStructured, parseCanvasPresentationStructured } = await canvasContract();
  const citation = { scope: 'citation', resourceId: 'report', sha256: 'a'.repeat(64) };
  const capability = { scope: 'capability', moduleId: 'com.transportx.video', resourceId: 'video-1', revision: 2 };
  assert.equal(parseCanvasPresentationStructured({ ...base, resources: [citation, capability] }).ok, true);
  const context = parseCanvasContextStructured({
    protocol: 'pi-canvas-context',
    version: '1.0',
    contextId: 'context-1',
    adapterId: base.adapterId,
    viewId: base.viewId,
    revision: 0,
    resources: [citation],
    target: base.target,
    selection: { kind: 'text', text: '结论' },
    createdAt: base.generatedAt,
  });
  assert.equal(context.ok, true);
  assert.equal(parseCanvasPresentationStructured({ ...base, resources: [{ ...citation, sha256: 'not-a-digest' }] }).ok, false);
});

test('Geo and Video Canvas targets are validated by their domain contracts', async () => {
  const { parseGeoCanvasTarget, parseVideoCanvasTarget } = await import('../src/contracts/canvas-media.ts');
  assert.deepEqual(parseGeoCanvasTarget({ kind: 'map-view', bounds: [121.39, 31.16, 121.53, 31.28] }), { kind: 'map-view', bounds: [121.39, 31.16, 121.53, 31.28] });
  assert.equal(parseGeoCanvasTarget({ kind: 'map-view', bounds: [181, 31.16, 182, 31.28] }), null);
  assert.deepEqual(parseVideoCanvasTarget({ kind: 'offset', seconds: 12 }), { kind: 'offset', seconds: 12 });
  assert.deepEqual(parseVideoCanvasTarget({ kind: 'timestamp', at: '2026-08-16T08:32:10+08:00' }), { kind: 'timestamp', at: '2026-08-16T08:32:10+08:00' });
  assert.equal(parseVideoCanvasTarget({ kind: 'offset', seconds: -1 }), null);
});
