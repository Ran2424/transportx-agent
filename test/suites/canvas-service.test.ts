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
    const slidesPath = path.join(root, 'reports', 'slides.pptx');
    const originalTime = fs.statSync(slidesPath).mtime;
    fs.writeFileSync(slidesPath, 'updated with the same timestamp');
    fs.utimesSync(slidesPath, originalTime, originalTime);
    const updated = service.present(current, { adapterId: presented.adapterId, resource: presented.resources[0] });
    assert.equal(updated.operation, 'update');
    assert.ok(updated.revision > presented.revision);
    (current.entries as any[]).push({ message: { details: { canvas: updated } } });
    fs.writeFileSync(slidesPath, 'updated with an earlier timestamp');
    fs.utimesSync(slidesPath, new Date(0), new Date(0));
    const earlier = service.present(current, { adapterId: presented.adapterId, resource: presented.resources[0], operation: 'update' });
    assert.ok(earlier.revision > updated.revision);
    (current.entries as any[]).push({ message: { details: { canvas: earlier } } });
    const viewUpdate = service.present(current, { viewId: presented.viewId, operation: 'update' });
    assert.equal(viewUpdate.revision, earlier.revision + 1);
    fs.utimesSync(slidesPath, new Date(), new Date());
    const resourceFocus = service.present(current, { adapterId: presented.adapterId, resource: presented.resources[0], operation: 'focus' });
    assert.equal(resourceFocus.revision, earlier.revision, 'focus never publishes a content revision');
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
    const shared = service.createContext(current, { viewId: presented.viewId, revision: earlier.revision, target: { kind: 'slide', number: 8 } });
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

  // CAD Canvas accepts viewport targets and bounded selections, and rejects malformed ones
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-cad-canvas-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const current = {
      id: 'cad-session', cwd: root, entries: [], citationRegistryId: 'cad-session', activeCanvasContextIds: [] as string[],
      resolvedSessionPlan: { modules: [{ id: 'com.transportx.cad', canvasViews: [{ adapterId: 'com.transportx.canvas.cad', kind: 'cad', protocolVersion: '1.0' }] }] },
    };
    const presentation = {
      protocol: 'pi-canvas', version: '1.0', presentationId: 'cad_pres_test', adapterId: 'com.transportx.canvas.cad',
      kind: 'cad', viewId: 'cad:junction_plan', revision: 1, operation: 'present', title: '路口平面图',
      resources: [{ scope: 'session-file', path: 'cad/junction_plan/r1.dxf' }],
      payload: { format: 'dxf', path: 'cad/junction_plan/r1.dxf', sha256: 'a'.repeat(64), units: 'm', layerCount: 3, entityCount: 4, preview: 'cad/junction_plan/r1.png' },
      target: { kind: 'viewport', center: [500000, 3450000], zoom: 1, units: 'm' },
      generatedAt: '2026-10-23T00:00:00Z',
    };
    (current.entries as any[]).push({ message: { details: { canvas: presentation } } });
    const service = new CanvasService({ registry: () => ({ load: () => ({ resources: [] }) }) }, (_session: any, requested: string) => path.resolve(root, requested));
    const context = service.createContext(current, {
      viewId: presentation.viewId, revision: 1, target: presentation.target,
      selection: { kind: 'cad-selection', handles: ['2F', 'A1'], layers: ['SIGNAL'], count: 2, truncated: false },
    });
    assert.equal(context.adapterId, 'com.transportx.canvas.cad');
    assert.deepEqual(context.selection, { kind: 'cad-selection', handles: ['2F', 'A1'], layers: ['SIGNAL'], count: 2, truncated: false });
    assert.match(buildCanvasContextPrompt([context.contextId]), /CAD drawing/);
    const { projectCanvas } = await import('../../src/web/platform/canvas/canvas-state.ts');
    const projected = projectCanvas([{ message: { details: { canvas: presentation } } }] as any, []);
    assert.equal(projected.views[0].kind, 'cad');
    assert.equal((projected.views[0] as any).previewPath, 'cad/junction_plan/r1.png');
    assert.throws(() => service.createContext(current, { viewId: presentation.viewId, revision: 1, selection: { kind: 'cad-selection', handles: ['bad'], layers: [], count: 1, truncated: false } }), /selection is invalid/);
    const focused = service.present(current, { viewId: presentation.viewId, target: { kind: 'viewport', center: [1, 2], zoom: 2, units: 'm' } });
    assert.equal(focused.operation, 'focus');
    assert.deepEqual(focused.target, { kind: 'viewport', center: [1, 2], zoom: 2, units: 'm' });
    assert.throws(() => service.present(current, { viewId: presentation.viewId, target: { kind: 'viewport', center: [1, 2], zoom: 0, units: 'm' } }), /target is invalid/);
  }
});
