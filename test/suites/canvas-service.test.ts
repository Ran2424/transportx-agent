const { test } = require('node:test') as typeof import('node:test');

test('Canvas documents round-trip with stable identity and reject unavailable adapters', async (t) => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { CanvasService, buildCanvasContextPrompt, restoreCanvasContextMessage } = require('../../bin/canvas-service.js');

  function session(cwd: string) {
    return {
      id: 'session-1', cwd, entries: [], citationRegistryId: 'session-1', activeCanvasContextIds: [] as string[],
      resolvedSessionPlan: {
        modules: [{ id: 'com.transportx.document', canvasViews: [{ adapterId: 'com.transportx.canvas.document', kind: 'document', protocolVersion: '1.0' }] }],
      },
    };
  }

  // Canvas Host validates a session document and returns a stable restorable presentation
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-canvas-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'reports'));
    fs.writeFileSync(path.join(root, 'reports', 'slides.pptx'), 'fixture');
    fs.writeFileSync(path.join(root, 'reports', 'counts.csv'), 'road,count\nA1,12\n');
    const current = session(root);
    const { CitationService } = require('../../bin/citation-service.js');
    const citation = new CitationService();
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
    const registered = citation.resolve(current, [{ path: 'reports/counts.csv', locator: { kind: 'table', rowStart: 1, rowEnd: 1 }, contentKind: 'result' }]);
    const source = registered.sources[0];
    const pinned = service.present(current, { adapterId: 'com.transportx.canvas.document', resource: { scope: 'capability', moduleId: 'com.transportx.citation', resourceId: source.sourceVersionId }, target: { kind: 'rows', start: 1, end: 1 } });
    assert.equal(pinned.viewId, `document:citation:${source.sourceVersionId}`);
    assert.equal(pinned.payload.source.sourceVersionId, source.sourceVersionId);
    const { resolveDocument } = await import('../../src/web/platform/canvas/document-state.ts');
    assert.equal(resolveDocument({ sessionId: current.id, title: source.title, path: source.content.path, source }, root)!.id, pinned.viewId);
    const { EMPTY_CANVAS, openCanvasDocument, projectCanvas, withCanvasDocuments, syncCanvas } = await import('../../src/web/platform/canvas/canvas-state.ts');
    const manual = resolveDocument({ sessionId: current.id, title: source.title, path: source.content.path, source, locator: { kind: 'table', rowStart: 1 } }, root)!;
    let state = openCanvasDocument(EMPTY_CANVAS, manual);
    const agentViews = projectCanvas([{ message: { role: 'toolResult', toolCallId: 'pin', details: { canvas: pinned } } }] as any, [], { sessionId: current.id, cwd: root });
    assert.equal(withCanvasDocuments(agentViews, state).views.length, 1, 'user and Agent share one version view');
    state = syncCanvas(state, withCanvasDocuments(agentViews, state));
    assert.equal(state.documents.length, 0, 'Agent navigation takes over a manual view');
    state = openCanvasDocument(state, manual);
    assert.equal(withCanvasDocuments(agentViews, state).views[0].kind, 'document');
    assert.equal((withCanvasDocuments(agentViews, state).views[0] as any).locator.rowStart, 1, 'later user navigation remains effective');
    fs.writeFileSync(path.join(root, 'reports/counts.csv'), 'changed');
    assert.throws(() => service.present(current, { adapterId: 'com.transportx.canvas.document', resource: pinned.resources[0] }), /changed/);
    const shared = service.createContext(current, { viewId: presented.viewId, revision: presented.revision, target: { kind: 'slide', number: 8 } });
    assert.throws(() => service.inspectContexts(current, [shared.contextId]), /current user turn/);
    current.activeCanvasContextIds = [shared.contextId];
    assert.deepEqual(service.inspectContexts(current, [shared.contextId]), [shared]);
    const prompt = `请解释这一页${buildCanvasContextPrompt([shared.contextId])}`;
    const restored = restoreCanvasContextMessage({ message: { role: 'user', content: prompt } });
    assert.deepEqual(restored.message.canvasContextIds, [shared.contextId]);
    assert.equal(restored.message.content, '请解释这一页');
    const image = { type: 'image', data: 'fixture', mimeType: 'image/png' };
    const original = { message: { role: 'user', content: [{ type: 'text', text: prompt }, image] } };
    const restoredBlocks = restoreCanvasContextMessage(original);
    assert.deepEqual(restoredBlocks.message.canvasContextIds, [shared.contextId]);
    assert.deepEqual(restoredBlocks.message.content, [{ type: 'text', text: '请解释这一页' }, image]);
    assert.deepEqual(original.message.content, [{ type: 'text', text: prompt }, image], 'restoration does not mutate Pi history');
  }

  // Canvas Host rejects unavailable adapters and invalid document targets
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-canvas-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'slides.pptx'), 'fixture');
    const current = session(root);
    const service = new CanvasService({ registry: () => ({ load: () => ({ resources: [] }) }) }, (_session: any, requested: string) => path.resolve(root, requested));
    assert.throws(() => service.present(current, { adapterId: 'unknown', resource: { scope: 'session-file', path: 'slides.pptx' } }), /not enabled/);
    assert.throws(() => service.present(current, { adapterId: 'com.transportx.canvas.document', resource: { scope: 'session-file', path: 'slides.pptx' }, target: { kind: 'slide', number: 0 } }), /target is invalid/);
  }
});
