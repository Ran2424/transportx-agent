import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { projectCanvas } from '../src/web/platform/canvas/canvas-state.ts';

const generatedAt = '2026-11-14T00:00:00Z';
const runId = 'sim_' + '0'.repeat(32), scenarioId = 'scenario_' + '1'.repeat(32);
const calculation = { protocol: 'pi-canvas', version: '1.0', presentationId: 'run-fixture', adapterId: 'com.transportx.traffic-simulation.canvas', kind: 'simulation', viewId: 'simulation:' + runId, revision: 1, operation: 'present', title: 'Simulation', resources: [{ scope: 'capability', moduleId: 'com.transportx.traffic-simulation', resourceId: runId }], payload: { runId, scenarioId, sourceKind: 'synthetic', modelValidation: 'not_calibrated' }, generatedAt };
const entries = Array.from({ length: 2000 }, (_, id) => ({ id: String(id), message: { role: 'assistant', content: 'fixture', timestamp: id } }));
entries.push({ id: 'tool-entry', message: { role: 'toolResult', toolCallId: 'call_fixture', details: { canvas: calculation } } });
const durations = Array.from({ length: 60 }, () => {
  const started = performance.now();
  const projected = projectCanvas(entries, []);
  assert.equal(projected.views.length, 1);
  assert.equal(projected.views[0].id, calculation.viewId);
  return performance.now() - started;
}).sort((a, b) => a - b);
console.log(JSON.stringify({ entries: entries.length, projections: durations.length, medianMs: +durations[30].toFixed(3), p95Ms: +durations[56].toFixed(3) }));
