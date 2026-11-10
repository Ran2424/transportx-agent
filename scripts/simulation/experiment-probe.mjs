// Actual approved-package installation, Host ownership, paired Runs and engine failure.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ModuleInstaller } = require('../../bin/module-installer.js');
const { ModuleRegistry } = require('../../bin/module-registry.js');
const { AssetResolver } = require('../../bin/asset-resolver.js');
const { SessionAssembler } = require('../../bin/session-assembly.js');
const { SimulationService } = require('../../bin/simulation-service.js');
const { BUILTIN_MODULE_MANIFESTS } = require('../../bin/config.js');
const { sha256File } = require('../../bin/asset-integrity.js');
const { parseTrafficToolResult } = require('../../bin/contracts/simulation.js');
const python = process.env.TAU_PYTHON_COMMAND, packageRoot = process.env.TRANSPORTX_SIMULATION_MODULE;
assert.ok(python && packageRoot, 'Explicit Python and independently packaged module required');
const root = path.resolve(process.argv[2]); fs.mkdirSync(root);
const workspace = path.join(root, 'workspace'), histories = path.join(root, 'histories'); fs.mkdirSync(workspace); fs.mkdirSync(histories);
const installer = new ModuleInstaller(path.join(root, 'installed'));
installer.install(path.resolve(packageRoot)); installer.install(path.resolve('modules/optional/hongqiao-night-demo'));
const registry = new ModuleRegistry('3.24.2').load([...BUILTIN_MODULE_MANIFESTS, ...installer.sources()]);
const executable = { command: python, args: [], version: '3.10' };
const assembler = new SessionAssembler(registry, new AssetResolver(registry), '3.24.2', { command: process.execPath, args: [], version: '0.80.10' }, executable);
const sessionFile = path.join(histories, 'probe.jsonl'); fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'experiment-probe', cwd: workspace }) + '\n');
const session = { id: 'experiment-probe', workspaceId: 'experiment-workspace', cwd: workspace, sessionFile, resolvedSessionPlan: assembler.assemble('com.transportx.workbench', workspace) };
const notifications = [];
const options = { executable, root: path.join(root, 'executions'), sessionsDirectory: histories, verifyPlan: (plan, cwd) => assembler.verify(plan, cwd), notify: (_session, run, revision) => notifications.push({ at: Date.now(), ...run, revision }) };
const service = new SimulationService(options);
const baseline = await service.prepareScenario(session, { assetId: 'data:hongqiao-night-demo', inputPath: 'multimodal-baseline.json' });
const variant = await service.prepareScenario(session, { assetId: 'data:hongqiao-night-demo', inputPath: 'multimodal-threshold.json', parentScenarioId: baseline.scenarioId, interventions: ['policy'] });
assert.deepEqual(variant.variant, { parentScenarioId: baseline.scenarioId, interventions: ['policy'] });
assert.equal(baseline.networkSha256, variant.networkSha256);
const baselineGeometry = JSON.parse(fs.readFileSync(path.join(workspace, 'traffic-simulation/scenarios', baseline.scenarioId, 'geometry.json')));
assert.deepEqual(baselineGeometry.routes['route:road'], ['hub', 'out', 'relay', 'back']);
assert.ok(Object.values(baselineGeometry.routes).every(edges => Array.isArray(edges) && edges.every(edge => typeof edge === 'string')));
await assert.rejects(service.prepareScenario(session, { assetId: 'data:hongqiao-night-demo', inputPath: 'multimodal-threshold.json', parentScenarioId: baseline.scenarioId, interventions: ['departures'] }), { code: 'traffic_variant_unchanged' });
assert.throws(() => service.prepareExperiment(session, { baselineScenarioId: baseline.scenarioId, variantScenarioId: variant.scenarioId, seeds: [7, 11, 13, 17] }), /three/);
assert.throws(() => service.prepareExperiment(session, { baselineScenarioId: baseline.scenarioId, variantScenarioId: baseline.scenarioId, seeds: [7] }), /variant/);
const request = { baselineScenarioId: baseline.scenarioId, variantScenarioId: variant.scenarioId, seeds: [7, 11, 13] };
const planned = service.prepareExperiment(session, request);
assert.equal(planned.totalRuns, 6); assert.equal(planned.totalSimulatedSeconds, 3600);
assert.equal(service.prepareExperiment(session, request).experimentId, planned.experimentId);
assert.equal(planned.comparison.conclusionAvailable, false);
assert.throws(() => service.prepareRun(session, { experimentId: planned.experimentId, slot: 1, toolCallId: 'out-of-order' }), /preceding/);
const evidence = { protocol: 'transportx-simulation-experiment-probe', version: 1, scope: 'actual installer/assembler/Host/Python/SUMO; real Pi/Geo/Canvas task is separate', baseline, variant, planned, completed: null, failed: null, notifications };
for (const slot of planned.slots) {
  const input = { experimentId: planned.experimentId, slot: slot.slot, toolCallId: `paired-slot-${slot.slot}` };
  const prepared = service.prepareRun(session, input);
  assert.equal(service.prepareRun(session, input).runId, prepared.runId);
  const run = await service.run(session, { ...input, operationId: prepared.runId }, new AbortController().signal);
  assert.equal(run.termination, 'completed', JSON.stringify(run)); assert.equal(run.seed, slot.seed);
  assert.equal(run.experimentSlot, slot.slot); assert.equal(run.experimentId, planned.experimentId);
  assert.throws(() => service.prepareRun(session, { ...input, toolCallId: 'replacement-' + slot.slot }), /already owns/);
  const comparison = service.experiment(session, planned.experimentId);
  assert.equal(comparison.slots.filter(slot => slot.run).length, slot.slot + 1);
  assert.equal(comparison.comparison.conclusionAvailable, slot.slot === 5);
  assert.ok(parseTrafficToolResult({ protocol: 'transportx-traffic', version: 1, operation: 'experiment', experiment: comparison }));
  fs.writeFileSync(path.join(root, `slot-${slot.slot}.json`), JSON.stringify(comparison, null, 2));
  console.log(JSON.stringify({ slot: slot.slot, seed: slot.seed, runId: run.runId, metrics: run.metrics }));
}
const complete = service.experiment(session, planned.experimentId);
assert.equal(complete.comparison.completePairs, 3);
for (const artifact of [complete.artifact]) {
  assert.equal(sha256File(path.join(workspace, artifact.manifestPath)), artifact.manifestSha256);
  assert.equal(sha256File(path.join(workspace, artifact.reportPath)), artifact.reportSha256);
}
evidence.completed = complete;
fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));

// Kill an actual SUMO after complete publication; no replacement dispatch.
const fault = service.prepareExperiment(session, { ...request, seeds: [17] });
const faultInput = { experimentId: fault.experimentId, slot: 0, toolCallId: 'fault-slot' };
const accepted = service.prepareRun(session, faultInput);
const faultRoot = path.join(workspace, 'traffic-simulation/runs', accepted.runId);
let killed = false;
const timer = setInterval(() => {
  const index = path.join(faultRoot, 'index.json');
  if (!killed && fs.existsSync(index) && JSON.parse(fs.readFileSync(index)).chunks.length) {
    killed = true;
    process.kill(JSON.parse(fs.readFileSync(path.join(faultRoot, 'started.json'))).sumoPid, 'SIGKILL');
  }
}, 5);
let unknown;
try { unknown = await service.run(session, { ...faultInput, operationId: accepted.runId }, new AbortController().signal); }
finally { clearInterval(timer); }
assert.equal(killed, true); assert.equal(unknown.state, 'unknown');
const restored = new SimulationService(options);
const missing = restored.experiment(session, fault.experimentId);
assert.equal(missing.comparison.conclusionAvailable, false); assert.equal(missing.slots[0].run.state, 'unknown'); assert.equal(missing.slots[1].run, undefined);
assert.throws(() => restored.prepareRun(session, { experimentId: fault.experimentId, slot: 1, toolCallId: 'fault-next' }), /preceding/);
assert.throws(() => restored.prepareRun(session, { ...faultInput, toolCallId: 'fault-replacement' }), /already owns/);
assert.equal(restored.cancel(session, { runId: accepted.runId }).termination, 'cancelled');
const changed = await restored.run(session, { experimentId: fault.experimentId, slot: 1, toolCallId: 'after-explicit-stop' }, new AbortController().signal);
assert.equal(changed.termination, 'completed');
evidence.failed = restored.experiment(session, fault.experimentId);
assert.equal(evidence.failed.comparison.completePairs, 0); assert.equal(evidence.failed.comparison.conclusionAvailable, false);
assert.equal(evidence.failed.slots[0].run.termination, 'cancelled');
assert.equal(restored.list(session).length, 8, 'Six paired Runs plus two explicitly accounted fault-plan slots');
fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ evidence: path.join(root, 'evidence.json'), pairedRuns: 6, completePairs: 3, incompletePairRetained: true }));
