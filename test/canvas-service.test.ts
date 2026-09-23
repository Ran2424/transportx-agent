const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CanvasService, buildCanvasContextPrompt, restoreCanvasContextMessage } = require('../bin/canvas-service.js');

function session(cwd: string) {
  return {
    id: 'session-1', cwd, entries: [], citationRegistryId: 'session-1', activeCanvasContextIds: [] as string[],
    resolvedSessionPlan: {
      modules: [{ id: 'com.transportx.document', canvasViews: [{ adapterId: 'com.transportx.canvas.document', kind: 'document', protocolVersion: '1.0' }] }],
    },
  };
}

test('Canvas Host validates a session document and returns a stable restorable presentation', (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-canvas-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'reports'));
  fs.writeFileSync(path.join(root, 'reports', 'slides.pptx'), 'fixture');
  fs.writeFileSync(path.join(root, 'reports', 'counts.csv'), 'road,count\nA1,12\n');
  const current = session(root);
  const citation = { registry: () => ({ load: () => ({ resources: [] }) }) };
  const service = new CanvasService(citation, (_session: any, requested: string) => path.resolve(root, requested));
  const presented = service.present(current, {
    adapterId: 'com.transportx.canvas.document',
    resource: { scope: 'session-file', path: 'reports/slides.pptx' },
    target: { kind: 'slide', number: 8 },
  });
  assert.equal(presented.kind, 'document');
  assert.deepEqual(presented.resources, [{ scope: 'session-file', path: 'reports/slides.pptx' }]);
  assert.deepEqual(presented.target, { kind: 'slide', number: 8 });
  (current.entries as any[]).push({ message: { details: { canvas: presented } } });
  const focused = service.present(current, { viewId: presented.viewId, target: { kind: 'slide', number: 2 } });
  assert.equal(focused.viewId, presented.viewId);
  assert.equal(focused.revision, presented.revision);
  assert.notEqual(focused.presentationId, presented.presentationId);
  assert.equal(focused.operation, 'focus');
  const csv = service.present(current, {
    adapterId: 'com.transportx.canvas.document',
    resource: { scope: 'session-file', path: 'reports/counts.csv' },
  });
  assert.equal((csv.payload as any).format, 'csv');
  assert.deepEqual(csv.resources, [{ scope: 'session-file', path: 'reports/counts.csv' }]);
  const shared = service.createContext(current, { viewId: presented.viewId, revision: presented.revision, target: { kind: 'slide', number: 8 } });
  assert.throws(() => service.inspectContexts(current, [shared.contextId]), /current user turn/);
  current.activeCanvasContextIds = [shared.contextId];
  assert.deepEqual(service.inspectContexts(current, [shared.contextId]), [shared]);
  const prompt = `请解释这一页${buildCanvasContextPrompt([shared.contextId])}`;
  const restored = restoreCanvasContextMessage({ message: { role: 'user', content: prompt } });
  assert.deepEqual(restored.message.canvasContextIds, [shared.contextId]);
  assert.equal(restored.message.content, '请解释这一页');
});

test('Canvas Host rejects unavailable adapters and invalid document targets', (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-canvas-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'slides.pptx'), 'fixture');
  const current = session(root);
  const service = new CanvasService({ registry: () => ({ load: () => ({ resources: [] }) }) }, (_session: any, requested: string) => path.resolve(root, requested));
  assert.throws(() => service.present(current, { adapterId: 'unknown', resource: { scope: 'session-file', path: 'slides.pptx' } }), /not enabled/);
  assert.throws(() => service.present(current, { adapterId: 'com.transportx.canvas.document', resource: { scope: 'session-file', path: 'slides.pptx' }, target: { kind: 'slide', number: 0 } }), /target is invalid/);
});
