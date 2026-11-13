// Same-Run physical metro, actual engine stops and a frozen timetable Variant.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ModuleInstaller } = require('../../bin/module-installer.js');
const { ModuleRegistry } = require('../../bin/module-registry.js');
const { AssetResolver } = require('../../bin/asset-resolver.js');
const { SessionAssembler } = require('../../bin/session-assembly.js');
const { SimulationService } = require('../../bin/simulation-service.js');
const { BUILTIN_MODULE_MANIFESTS, PLATFORM_VERSION } = require('../../bin/config.js');
const { sha256File } = require('../../bin/asset-integrity.js');
const [physicalRoot, historicalScenario, packageRoot, output] = process.argv.slice(2, 6).map(item => path.resolve(item));
const useBuiltin = process.argv[6] === '--builtin';
const python = process.env.TAU_PYTHON_COMMAND;
assert.ok(python, 'Set TAU_PYTHON_COMMAND explicitly');
const source = JSON.parse(fs.readFileSync(path.join(physicalRoot, 'physical-evidence.json')));
const network = path.join(physicalRoot, 'corridor.net.xml');
assert.equal(sha256File(network), source.files['corridor.net.xml'].sha256);
fs.mkdirSync(output);
const cwd = path.join(output, 'workspace'), histories = path.join(output, 'histories');
fs.mkdirSync(cwd); fs.mkdirSync(histories);
const installer = new ModuleInstaller(path.join(output, 'modules'));
const demoRoot = process.env.TRANSPORTX_SIMULATION_DEMO_MODULE;
if (useBuiltin && demoRoot) installer.install(path.resolve(demoRoot));
if (!useBuiltin) installer.install(packageRoot);
const registry = new ModuleRegistry(PLATFORM_VERSION).load([...BUILTIN_MODULE_MANIFESTS, ...installer.sources()]);
const executable = { command: python, args: [], version: '3.10' };
const assembler = new SessionAssembler(registry, new AssetResolver(registry), PLATFORM_VERSION, { command: process.execPath, args: [], version: '0.80.10' }, executable);
const id = 'physical-metro-probe', sessionFile = path.join(histories, 'probe.jsonl');
fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id, cwd }) + '\n');
const simulationId = 'com.transportx.traffic-simulation';
const defaultPlan = assembler.assemble('com.transportx.workbench', cwd);
let resolvedSessionPlan = defaultPlan;
if (useBuiltin) {
  const builtin = registry.get(simulationId);
  assert.equal(builtin?.origin, 'builtin');
  assert.equal(builtin.packageRoot, packageRoot);
  assert.ok(!defaultPlan.modules.some(module => module.id === simulationId));
  assert.ok(!defaultPlan.modules.some(module => module.id === 'com.transportx.hongqiao-night-demo'));
  resolvedSessionPlan = assembler.assemble('com.transportx.workbench', cwd, {
    ...defaultPlan.profile, modules: { selectionMode: 'explicit', selected: [{ id: simulationId, version: builtin.manifest.version }] },
  });
}
const session = { id, workspaceId: id, cwd, sessionFile, resolvedSessionPlan };
const host = new SimulationService({ executable, root: path.join(output, 'executions'), sessionsDirectory: histories,
  verifyPlan: (plan, directory) => assembler.verify(plan, directory), notify: () => {} });
const baseline = JSON.parse(fs.readFileSync(historicalScenario));
const rail = source.paths.rail;
baseline.title = '上海 OSM 公交与实体地铁接续（合成班表）';
baseline.provenance.description = '上海 OSM 固定网络。公交、实体地铁停站、需求、班次与站台均为合成测试。';
baseline.configuration.rail = {
  mode: 'physical', lineId: 'route:metro-shanghai', trainId: 'train-shanghai', serviceId: 'metro-service',
  insertTime: 35, startPosition: 100, edges: rail.edges, boardingStop: 1, stops: [
    { platformId: 'node:platform-origin', edge: rail.edges[0], position: 155, arrival: 47, departure: 55 },
    { platformId: 'node:platform-transfer', edge: rail.edges[1], position: 900, arrival: 111, departure: 390 },
    { platformId: 'node:platform-terminal', edge: rail.edges.at(-1), position: rail.stop[2], arrival: 530, departure: 538 },
  ].map(stop => ({ ...stop, lane: 0, minDwell: 8 })),
};
fs.copyFileSync(network, path.join(cwd, 'corridor.net.xml'));

async function execute(name, scenario, parentScenarioId) {
  const inputPath = name + '.json';
  fs.writeFileSync(path.join(cwd, inputPath), JSON.stringify(scenario, null, 2));
  const prepared = await host.prepareScenario(session, { inputPath, ...(parentScenarioId ? { parentScenarioId, interventions: ['railTimetable'] } : {}) });
  const run = await host.run(session, { scenarioId: prepared.scenarioId, toolCallId: name }, new AbortController().signal);
  assert.equal(run.termination, 'completed', JSON.stringify(run.error));
  const index = host.index(session, run.runId), plan = scenario.configuration.rail;
  const chunks = index.chunks.map((_, i) => host.chunk(session, run.runId, i));
  assert.ok(chunks.some(chunk => chunk.block.frames.some(frame =>
    frame.vehicles[plan.trainId]?.mode === 'metro' && frame.vehicles['bus-shanghai'] && Object.keys(frame.vehicles).some(id => id.startsWith('road-')))));
  const events = chunks.flatMap(chunk => chunk.events);
  const departures = events.filter(e => e.type === 'metro_departed');
  const arrivals = events.filter(e => e.type === 'metro_arrived');
  assert.equal(departures.length, 3); assert.equal(arrivals.length, 3);
  const departure = departures[1], arrival = arrivals[1];
  const boarded = events.filter(e => e.type === 'metro_boarded');
  assert.equal(boarded.length, 3);
  assert.equal(run.metrics.service.completedJourneys, 3);
  assert.equal(run.metrics.service.lastServiceMisses, 1);
  assert.ok(boarded.every(e => e.observedTime === departure.observedTime && e.time === departure.time));
  const geometry = host.geometry(session, run.runId);
  assert.deepEqual(geometry.rail, plan);
  const query = host.query(session, { runId: run.runId, time: departure.time, objectId: departure.nodeId, eventSequence: departure.sequence });
  assert.equal(query.event.observedTime, departure.observedTime);
  assert.equal(query.platformId, departure.nodeId);
  return { prepared, run, arrival, departure, arrivals, departures, boarded, query };
}

const a = await execute('metro-baseline', baseline);
const shifted = structuredClone(baseline);
shifted.configuration.rail.stops[1].departure++;
shifted.configuration.coordination.metro[0].time++;
const b = await execute('metro-plus-one', shifted, a.prepared.scenarioId);
const late = structuredClone(baseline);
late.configuration.rail.insertTime = 345;
Object.assign(late.configuration.rail.stops[0], { arrival: 350, departure: 358 });
late.configuration.rail.stops[1].arrival = 370;
const c = await execute('metro-late', late, a.prepared.scenarioId);
assert.equal(a.departure.observedTime, 390);
assert.equal(b.departure.observedTime, 391);
assert.ok(c.arrival.observedTime > 390 && c.departure.observedTime - c.arrival.observedTime === 8);
const module = resolvedSessionPlan.modules.find(item => item.id === simulationId);
const evidence = { baseline: a, plusOne: b, late: c, networkSha256: sha256File(network),
  module: { origin: module.origin, version: module.version, packageRoot: module.packageRoot, defaultSelected: defaultPlan.modules.some(item => item.id === simulationId) } };
fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries({ baseline: a, plusOne: b, late: c }).map(([key, value]) => [key, {
  runId: value.run.runId, actualArrival: value.arrival.observedTime, actualDeparture: value.departure.observedTime,
}]))));
