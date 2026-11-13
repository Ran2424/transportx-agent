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
    const { parseTrafficScenario, parseSimulationCanvasPayload, parseSimulationCanvasTarget, parseSimulationGeometry } = await import('../../src/contracts/simulation.ts');
    const scenario = {
      schemaVersion: 1, title: 'Synthetic contract test',
      provenance: { kind: 'synthetic', description: 'Contract test', validDate: '2026-01-01', modelValidation: 'not_calibrated' },
      network: { path: 'network.net.xml', version: 'test', mapping: { version: 1, roadRoute: ['pickup', 'transfer'] } },
      configuration: {
        schemaVersion: 1, model: 'multimodal', networkVersion: 'test', serviceDate: '2026-01-01',
        timezone: 'Asia/Shanghai', startTime: '23:00:00', durationSeconds: 600, seed: 1, backgroundCount: 0,
        stepSeconds: 1, decisionSeconds: 1, sampleSeconds: 2, blockSeconds: 10,
        units: { time: 's', distance: 'm', speed: 'm/s' },
        coordination: {
          version: 2, boardingSeconds: 5,
          nodes: [
            { id: 'node:pickup', role: 'pickup', edge: 'pickup', waitingCapacity: 10, berths: [{ lane: 0, position: 20 }, { lane: 1, position: 20 }] },
            { id: 'node:transfer', role: 'transfer', edge: 'transfer', waitingCapacity: 10, berths: [{ lane: 0, position: 20 }] },
          ],
          routes: [{ id: 'route:bus-east', mode: 'bus', origin: 'node:pickup', target: 'node:transfer', destination: 'east', outbound: ['pickup', 'transfer'], inbound: ['transfer', 'pickup'], transferSeconds: 20, externalSeconds: 60 }],
          fleet: [
            { id: 'bus-a', mode: 'bus', capacity: 4, home: 'node:pickup', berth: 0 },
            { id: 'bus-b', mode: 'bus', capacity: 4, home: 'node:pickup', berth: 1 },
          ],
          travelers: [{ id: 'traveler-a', time: 0, origin: 'node:pickup', destination: 'east', route: 'route:bus-east' }],
          departures: [{ id: 'departure-a', time: 10, vehicle: 'bus-a', route: 'route:bus-east' }],
          metro: [{ id: 'metro-a', time: 100, node: 'node:transfer', destination: 'east', capacity: 4, externalSeconds: 60 }],
          policy: { kind: 'fixed' },
        },
      },
    };
    assert.ok(parseTrafficScenario(scenario));
    const berthConflict = structuredClone(scenario);
    berthConflict.configuration.coordination.fleet[1].berth = berthConflict.configuration.coordination.fleet[0].berth;
    assert.equal(parseTrafficScenario(berthConflict), null);
    const wrongConnection = structuredClone(scenario);
    wrongConnection.configuration.coordination.metro[0].destination = 'missing-destination';
    assert.equal(parseTrafficScenario(wrongConnection), null);
    const policyCode = structuredClone(scenario);
    const queuePolicy = { kind: 'queue-threshold', threshold: 2, cooldownSeconds: 30, routes: ['route:bus-east'] };
    policyCode.configuration.coordination.policy = queuePolicy;
    assert.ok(parseTrafficScenario(policyCode));
    assert.equal(parseTrafficScenario({
      ...policyCode,
      configuration: { ...policyCode.configuration, coordination: { ...policyCode.configuration.coordination, policy: { ...queuePolicy, code: 'unapproved.py' } } },
    }), null);
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
    const typed = { ...geometry, features: [{ ...geometry.features[0], properties: { edgeId: 'edge-1', networkType: 'highway.primary' } }] };
    assert.deepEqual(parseSimulationGeometry(typed), typed);
    assert.equal(parseSimulationGeometry({ ...geometry, features: [{ ...typed.features[0], properties: { edgeId: 'edge-1', networkType: 2 } }] }), null);
    assert.deepEqual(parseSimulationCanvasTarget({ time: 1, objectId: 'bus-shanghai', eventSequence: 4 }), { time: 1, objectId: 'bus-shanghai', eventSequence: 4 });
    assert.equal(parseSimulationCanvasTarget({ time: 1, eventSequence: 4.5 }), null);
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
