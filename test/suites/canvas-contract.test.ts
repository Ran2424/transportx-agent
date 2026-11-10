const { test } = require('node:test') as typeof import('node:test');

test('Canvas resources and adapter contracts accept valid presentations and reject unsafe input', async () => {
  const assert = require('node:assert/strict');

  async function canvasContract() { return import('../../src/contracts/canvas.ts'); }

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

  // Finite service contracts reject conflicting resources and executable policy bags.
  {
    const { parseTrafficScenario, parseSimulationCanvasPayload, parseSimulationGeometry } = await import('../../src/contracts/simulation.ts');
    const scenario = require('../../modules/optional/hongqiao-night-demo/assets/night-demo/multimodal-baseline.json');
    assert.ok(parseTrafficScenario(scenario));
    const berthConflict = structuredClone(scenario);
    berthConflict.configuration.coordination.fleet[1].berth = berthConflict.configuration.coordination.fleet[0].berth;
    assert.equal(parseTrafficScenario(berthConflict), null);
    const wrongConnection = structuredClone(scenario);
    wrongConnection.configuration.coordination.metro[0].destination = 'missing-destination';
    assert.equal(parseTrafficScenario(wrongConnection), null);
    const policyCode = structuredClone(scenario);
    policyCode.configuration.coordination.policy = { kind: 'queue-threshold', threshold: 2, cooldownSeconds: 30, routes: ['route:bus-east'], code: 'unapproved.py' };
    assert.equal(parseTrafficScenario(policyCode), null);
    const wrongItinerary = structuredClone(scenario);
    wrongItinerary.configuration.coordination.travelers[0].destination = 'wrong-direction';
    assert.equal(parseTrafficScenario(wrongItinerary), null);
    const reservedActionId = structuredClone(scenario);
    reservedActionId.configuration.coordination.departures[0].id = 'feedback-route:bus-east-120';
    assert.equal(parseTrafficScenario(reservedActionId), null, 'user IDs cannot collide with generated feedback action IDs');
    const payload = { runId: `sim_${'a'.repeat(32)}`, scenarioId: `scenario_${'b'.repeat(32)}`, sourceKind: 'synthetic', modelValidation: 'not_calibrated', experimentId: `experiment_${'c'.repeat(32)}` };
    assert.ok(parseSimulationCanvasPayload(payload));
    assert.equal(parseSimulationCanvasPayload({ ...payload, experimentId: '../foreign' }), null);
    const geometry = { type: 'FeatureCollection', routes: { 'route:road': ['edge-1'] }, features: [{ type: 'Feature', id: 'edge-1', properties: { edgeId: 'edge-1' }, geometry: { type: 'LineString', coordinates: [[121.3, 31.19], [121.31, 31.19]] } }] };
    assert.ok(parseSimulationGeometry(geometry));
    assert.equal(parseSimulationGeometry({ ...geometry, routes: { 'route:road': { id: 'route:ridehail-west' } } }), null, 'reject the route-object overwrite observed in the real model task');
  }

  // Canvas presentation accepts bounded adapter data and safe resources
  {
    const { parseCanvasPresentationStructured, getCanvasPresentationFromToolResult } = await canvasContract();
    const parsed = parseCanvasPresentationStructured(base);
    assert.equal(parsed.ok, true);
    assert.deepEqual(getCanvasPresentationFromToolResult({ details: { canvas: base } }), base);
  }

  // Canvas presentation rejects unsafe paths, versions and oversized adapter data
  {
    const { parseCanvasPresentationStructured, CANVAS_MAX_JSON_BYTES } = await canvasContract();
    assert.equal(parseCanvasPresentationStructured({ ...base, resources: [{ scope: 'session-file', path: '../secret.pptx' }] }).ok, false);
    assert.equal(parseCanvasPresentationStructured({ ...base, version: '2.0' }).ok, false);
    assert.equal(parseCanvasPresentationStructured({ ...base, payload: { text: 'x'.repeat(CANVAS_MAX_JSON_BYTES) } }).ok, false);
    assert.equal(parseCanvasPresentationStructured({ ...base, revision: 0.5 }).ok, false);
  }

  // Canvas resource scopes and explicit context share the same guarded references
  {
    const { parseCanvasContextStructured, parseCanvasPresentationStructured } = await canvasContract();
    const citation = { scope: 'capability', moduleId: 'com.transportx.citation', resourceId: 'sv_report' };
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
    assert.equal(parseCanvasPresentationStructured({ ...base, resources: [{ scope: 'citation', resourceId: 'legacy', sha256: 'a'.repeat(64) }] }).ok, false);
  }

  // Geo and Video Canvas targets are validated by their domain contracts
  {
    const { parseGeoCanvasTarget, parseVideoCanvasTarget } = await import('../../src/contracts/canvas-media.ts');
    assert.deepEqual(parseGeoCanvasTarget({ kind: 'map-view', bounds: [121.39, 31.16, 121.53, 31.28] }), { kind: 'map-view', bounds: [121.39, 31.16, 121.53, 31.28] });
    assert.equal(parseGeoCanvasTarget({ kind: 'map-view', bounds: [181, 31.16, 182, 31.28] }), null);
    assert.deepEqual(parseVideoCanvasTarget({ kind: 'offset', seconds: 12 }), { kind: 'offset', seconds: 12 });
    assert.deepEqual(parseVideoCanvasTarget({ kind: 'timestamp', at: '2026-08-16T08:32:10+08:00' }), { kind: 'timestamp', at: '2026-08-16T08:32:10+08:00' });
    assert.equal(parseVideoCanvasTarget({ kind: 'offset', seconds: -1 }), null);
  }
});
