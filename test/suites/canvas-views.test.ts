const { test } = require('node:test') as typeof import('node:test');

test('Canvas focus, document identity and content survive updates and navigation', async () => {
  const assert = require('node:assert/strict');
  const fixture = require('../fixtures/features/geo-tool-result.json').presentVisualizationResult;

  async function canvasApi() { return import('../../src/web/platform/canvas/canvas-state.ts'); }

  function mapResult(id: string, call: string, revision = 1) {
    const message = structuredClone(fixture);
    message.toolCallId = call;
    message.details.visualization.visualizationId = id;
    message.details.visualization.revision = revision;
    return { type: 'message', message };
  }

  // unified Canvas presentations project through registered adapters and use presentation identity for focus
  {
    const { projectCanvas, syncCanvas, closeCanvasTab, EMPTY_CANVAS } = await canvasApi();
    const canvas = {
      protocol: 'pi-canvas', version: '1.0', presentationId: 'present-1',
      adapterId: 'com.transportx.canvas.document', kind: 'document', viewId: 'document:slides', revision: 0,
      operation: 'present', title: '路口分析', resources: [{ scope: 'session-file', path: 'reports/slides.pptx' }],
      payload: { format: 'pptx' }, target: { kind: 'slide', number: 8 }, generatedAt: '2026-09-23T10:00:00+08:00',
    };
    const context = { sessionId: 'session-1', cwd: '/task' };
    const content = projectCanvas([{ message: { toolCallId: 'canvas-1', details: { canvas } } }] as any, [], context);
    assert.equal(content.views.length, 1);
    assert.equal(content.views[0].kind, 'document');
    assert.equal((content.views[0] as any).path, '/task/reports/slides.pptx');
    assert.deepEqual((content.views[0] as any).canvasTarget, { kind: 'slide', number: 8 });
    let state = syncCanvas(EMPTY_CANVAS, content);
    state = closeCanvasTab(state, 'document:slides');
    const focused = projectCanvas([{ message: { toolCallId: 'canvas-1', details: { canvas } } }, { message: { toolCallId: 'canvas-2', details: { canvas: { ...canvas, presentationId: 'focus-2', operation: 'focus' } } } }] as any, [], context);
    state = syncCanvas(state, focused);
    assert.equal(state.activeId, 'document:slides');
    assert.equal(state.open, true);
  }

  // closing and selecting tabs survives unchanged snapshots; explicit Agent focus reopens a tab without a new revision
  {
    const { projectCanvas, syncCanvas, closeCanvasTab, activateCanvas, EMPTY_CANVAS } = await canvasApi();
    const entries = [mapResult('first', 'map-1'), mapResult('second', 'map-2')];
    const content = projectCanvas(entries as any, []);
    let state = syncCanvas(EMPTY_CANVAS, content);
    state = activateCanvas(state, 'geo:first');
    assert.equal(syncCanvas(state, content), state);
    state = closeCanvasTab(state, 'geo:first');
    assert.equal(syncCanvas(state, content), state);
    const focus = projectCanvas([...entries, mapResult('first', 'show-1')] as any, []);
    state = syncCanvas(state, focus);
    assert.equal(state.activeId, 'geo:first');
    assert.deepEqual(state.tabIds, ['geo:second', 'geo:first']);
    state = closeCanvasTab(closeCanvasTab(state, 'geo:first'), 'geo:second');
    assert.equal(state.open, false);
    assert.equal(syncCanvas(state, focus), state);
    assert.equal(EMPTY_CANVAS.tabIds.length, 0, 'other sessions do not inherit tabs');
  }

  // manual documents survive tool snapshots, close/reopen and repeated citation navigation
  {
    const { EMPTY_CANVAS, projectCanvas, syncCanvas, withCanvasDocuments, openCanvasDocument, closeCanvasTab, activateCanvas } = await canvasApi();
    const { resolveDocument } = await import('../../src/web/platform/canvas/document-state.ts');
    const document = resolveDocument({ sessionId: 'one', title: '报告', path: 'report.md' }, '/task')!;
    let state = openCanvasDocument(EMPTY_CANVAS, document);
    assert.equal(state.open, true);
    state = syncCanvas(state, withCanvasDocuments(projectCanvas([], []), state));
    assert.deepEqual(state.tabIds, [document.id]);
    state = openCanvasDocument(state, document);
    assert.equal(state.documents.length, 1);
    assert.equal(state.tabIds.length, 1);
    const locator = { kind: 'document' as const, section: '结论' };
    state = openCanvasDocument(state, { ...document, locator });
    state = openCanvasDocument(state, { ...document, locator });
    assert.equal(state.documents[0].navigationId, 2, 'repeated navigation is an explicit request');
    state = closeCanvasTab(state, document.id);
    assert.equal(state.open, false);
    assert.equal(syncCanvas(state, withCanvasDocuments(projectCanvas([], []), state)), state);
    state = activateCanvas(state, document.id);
    const withMap = projectCanvas([mapResult('map', 'present')] as any, []);
    state = syncCanvas(state, withCanvasDocuments(withMap, state));
    state = syncCanvas(state, withCanvasDocuments(projectCanvas([], []), state));
    assert.deepEqual(state.tabIds, [document.id], 'removing a map does not remove the document');
    assert.deepEqual(EMPTY_CANVAS.documents, [], 'other sessions retain an empty initial state');
  }

  // document identity uses full paths, owning sessions and pinned citation versions
  {
    const { resolveDocument, documentPath, documentFormat, isOfficeFormat } = await import('../../src/web/platform/canvas/document-state.ts');
    const request = { sessionId: 'one', title: '报告', path: 'output/../report.md' };
    const first = resolveDocument(request, '/task')!;
    assert.equal(first.id, resolveDocument({ ...request, path: '/task/report.md' }, '/task')!.id);
    assert.notEqual(first.id, resolveDocument({ ...request, path: 'other/report.md' }, '/task')!.id);
    assert.notEqual(first.id, resolveDocument({ ...request, sessionId: 'two' }, '/task')!.id);
    assert.equal(documentPath('output\\..\\report.md', 'C:\\task'), 'C:/task/report.md');
    const source = { sourceVersionId: 'sv_report', sourceKey: 'session:report.md', title: '报告', acquiredAt: '2026-10-16', content: { kind: 'file', scope: 'session', path: 'report.md', mimeType: 'text/markdown', sha256: 'a'.repeat(64), size: 100 } } as const;
    const pinned = resolveDocument({ ...request, source }, '/task')!;
    assert.equal(pinned.source, source);
    assert.equal(resolveDocument(request, '/task')!.source, undefined, 'ordinary browsing always reads the current file');
    assert.equal(pinned.id, resolveDocument({ ...request, path: '/task/report.md', source }, '/task')!.id);
    assert.notEqual(pinned.id, resolveDocument({ ...request, source: { ...source, sourceVersionId: 'sv_new', content: { ...source.content, sha256: 'b'.repeat(64) } } }, '/task')!.id);
    assert.equal(resolveDocument({ ...request, path: 'image.png' }, '/task'), null);
    assert.equal(documentFormat('report.docx'), 'docx');
    assert.equal(documentFormat('sheet.bin', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'xlsx');
    assert.equal(documentFormat('counts.csv'), 'csv');
    assert.equal(documentFormat('counts.bin', 'text/csv; charset=utf-8'), 'csv');
    assert.equal(documentFormat('slides.PPTX'), 'pptx');
    assert.equal(documentFormat('legacy.xls'), null);
    assert.equal(documentFormat('legacy.ods'), null);
    assert.equal(isOfficeFormat('docx'), true);
    assert.equal(isOfficeFormat('pdf'), false);
  }

  // CSV parser preserves quoted delimiters and line breaks for Canvas tables
  {
    const { parseDelimited } = await import('../../src/web/platform/workspace/delimited-table.ts');
    assert.deepEqual(parseDelimited('name,note\nA,"one,two"\nB,"line 1\nline 2"\n', ','), [
      ['name', 'note'],
      ['A', 'one,two'],
      ['B', 'line 1\nline 2'],
    ]);
  }

  // document headings have unique anchors and ambiguous or absent citations do not guess
  {
    const { documentHeadings, documentTarget } = await import('../../src/web/platform/canvas/document-state.ts');
    const headings = documentHeadings(['结论', '结论', '结论-2', 'Methods & data'].map((text) => ({ text, level: 2 })));
    assert.equal(new Set(headings.map((item) => item.id)).size, headings.length);
    const locator = { kind: 'document' as const };
    assert.equal(documentTarget(headings, { ...locator, section: '结论' }), null);
    assert.equal(documentTarget(headings, { ...locator, nodeId: '#结论-2', section: '结论' }), '结论-2');
    assert.equal(documentTarget(headings, { ...locator, section: 'Methods & data' }), 'methods-data');
    assert.equal(documentTarget(headings, { ...locator, section: '不存在' }), null);
  }
});
