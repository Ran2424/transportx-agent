// Reuse the shipped Host/worker and the exact network from the physical probe.
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
const { parseTrafficScenario } = require('../../bin/contracts/simulation.js');
const [physicalRoot, moduleRoot, root] = process.argv.slice(2).map(p => path.resolve(p));
const python = process.env.TAU_PYTHON_COMMAND;
assert.ok(python, 'Set TAU_PYTHON_COMMAND explicitly');
const input = JSON.parse(fs.readFileSync(path.join(physicalRoot, 'physical-evidence.json'), 'utf8'));
const network = path.join(physicalRoot, 'corridor.net.xml');
assert.equal(sha256File(network), input.files['corridor.net.xml'].sha256);

fs.mkdirSync(root);
const workspace = path.join(root, 'workspace'), histories = path.join(root, 'histories');
fs.mkdirSync(workspace); fs.mkdirSync(histories);
const installer = new ModuleInstaller(path.join(root, 'installed'));
installer.install(moduleRoot);
const registry = new ModuleRegistry(PLATFORM_VERSION).load([...BUILTIN_MODULE_MANIFESTS, ...installer.sources()]);
const executable = { command: python, args: [], version: '3.10' };
const assembler = new SessionAssembler(registry, new AssetResolver(registry), PLATFORM_VERSION, { command: process.execPath, args: [], version: '0.80.10' }, executable);
const id = 'shanghai-osm-probe', sessionFile = path.join(histories, 'probe.jsonl');
fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id, cwd: workspace }) + '\n');
const session = { id, workspaceId: id, cwd: workspace, sessionFile, resolvedSessionPlan: assembler.assemble('com.transportx.workbench', workspace) };
const service = new SimulationService({ executable, root: path.join(root, 'executions'), sessionsDirectory: histories,
  verifyPlan: (plan, cwd) => assembler.verify(plan, cwd), notify: () => {} });
const [origin, target, routeId, destination] = ['node:pickup', 'node:transfer', 'route:bus', 'destination:metro'];
const road = input.paths.road, [startEdge, startLane, startPos] = road.start, [endEdge, endLane, endPos] = road.stop;
const version = `osm-shanghai/${input.files['shanghai-south.osm.xml'].sha256.slice(0, 12)}`;
const date = '2026-11-11', metroTime = 390, walkingSeconds = 45;
const externalSeconds = Number(input.physical.vehicles['metro-0'].duration);
const scenario = {
  schemaVersion: 1, title: '上海南站—龙漕路 OSM 约 3 km（合成运营测试）',
  provenance: { kind: 'synthetic', validDate: date, modelValidation: 'not_calibrated',
    description: `${input.attribution}；路网来自固定 OSM 快照，班次、接续、容量与需求为合成测试条件。地铁在 TransportX 中为有限班次接续，物理地铁轨迹由独立 SUMO 运行验证。` },
  network: { path: 'corridor.net.xml', version, mapping: { version: 1, roadRoute: road.edges } },
  configuration: { schemaVersion: 1, model: 'multimodal', networkVersion: version, serviceDate: date, timezone: 'Asia/Shanghai', startTime: '23:50:00',
    durationSeconds: 600, seed: 7, stepSeconds: 1, decisionSeconds: 1, sampleSeconds: 2, blockSeconds: 10, backgroundCount: 12,
    units: { time: 's', distance: 'm', speed: 'm/s' },
    coordination: { version: 2, boardingSeconds: 2, policy: { kind: 'fixed' },
      nodes: [
        { id: origin, role: 'pickup', edge: startEdge, waitingCapacity: 4, berths: [{ lane: startLane, position: startPos }] },
        { id: target, role: 'transfer', edge: endEdge, waitingCapacity: 4, berths: [{ lane: endLane, position: endPos }] },
      ],
      routes: [{ id: routeId, mode: 'bus', origin, target, destination, outbound: road.edges, inbound: input.paths.return.edges, transferSeconds: walkingSeconds, externalSeconds }],
      fleet: [{ id: 'bus-shanghai', mode: 'bus', capacity: 4, home: origin, berth: 0 }],
      travelers: Array.from({ length: 4 }, (_, i) => ({ id: `person-${i}`, time: 0, origin, destination, route: routeId })),
      departures: [{ id: 'bus-service', time: 5, vehicle: 'bus-shanghai', route: routeId }],
      metro: [{ id: 'metro-service', time: metroTime, node: target, destination, capacity: 3, externalSeconds }],
    },
  },
};
assert.ok(parseTrafficScenario(scenario));
fs.copyFileSync(network, path.join(workspace, 'corridor.net.xml'));
fs.writeFileSync(path.join(workspace, 'scenario.json'), JSON.stringify(scenario, null, 2) + '\n');
const prepared = await service.prepareScenario(session, { inputPath: 'scenario.json' });
assert.equal(prepared.networkSha256, input.files['corridor.net.xml'].sha256);
const run = await service.run(session, { scenarioId: prepared.scenarioId, toolCallId: 'osm-shanghai-3km' }, new AbortController().signal);
fs.writeFileSync(path.join(root, 'run.json'), JSON.stringify(run, null, 2) + '\n');
assert.equal(run.termination, 'completed', JSON.stringify(run.error));
const index = service.index(session, run.runId);
assert.equal(index.final, true); assert.equal(index.availableTime, 600);
const events = index.chunks.flatMap((_, i) => service.chunk(session, run.runId, i).events);
const alighted = events.filter(e => e.type === 'alighted');
const boarded = events.filter(e => e.type === 'metro_boarded');
const failed = events.filter(e => e.type === 'last_connection_missed');
fs.writeFileSync(path.join(root, 'transfer-events.json'), JSON.stringify({ alighted, boarded, failed }, null, 2) + '\n');
assert.equal(run.metrics.road.inserted, 13);
assert.equal(run.metrics.service.dispatchedTrips, 1);
assert.equal(alighted.length, 4); assert.equal(boarded.length, 3); assert.equal(failed.length, 1);
assert.ok(boarded.every(e => e.time === metroTime && alighted.some(a => a.objectId === e.objectId && a.time + walkingSeconds <= e.time)));
assert.deepEqual(run.metrics.service.states, { completed: 3, connecting: 1 });
assert.equal(run.metrics.service.completedJourneys, 3);
const atBoarding = service.query(session, { runId: run.runId, time: metroTime, objectId: target });
assert.equal(atBoarding.node.connecting, 1);
const completed = events.filter(e => e.type === 'journey_completed');
assert.equal(completed.length, 3);
assert.ok(completed.every(e => e.time === metroTime + externalSeconds && boarded.some(b => b.objectId === e.objectId)));
const geometry = service.geometry(session, run.runId);
assert.deepEqual(geometry.routes['route:road'], road.edges);
assert.deepEqual(geometry.serviceRoutes, [{ id: routeId, mode: 'bus', origin, target }]);
assert.deepEqual(atBoarding.node.metro, [{ id: 'metro-service', time: metroTime, capacity: 3 }]);
const routeAtBoarding = service.query(session, { runId: run.runId, time: metroTime, objectId: routeId });
assert.deepEqual(routeAtBoarding.route.departures, [{ id: 'bus-service', time: 5, vehicle: 'bus-shanghai' }]);
assert.equal(atBoarding.missedConnections, 1);
assert.equal(service.presentation(session, run.runId).kind, 'simulation');
const files = ['result.json', 'index.json', 'tripinfo.xml'].map(name => {
  const relative = `traffic-simulation/runs/${run.runId}/${name}`;
  return { path: relative, sha256: sha256File(path.join(workspace, relative)) };
});
fs.writeFileSync(path.join(root, 'host-evidence.json'), JSON.stringify({
  scope: 'Actual Host/Python/TraCI/SUMO; no live Pi or browser. Metro is a bounded timetable handoff in this Run.',
  prepared, run, files, alighted, boarded, failed, completed, atBoarding, routeAtBoarding, serviceRoutes: geometry.serviceRoutes, networkGeometryFeatures: geometry.features.length,
}, null, 2) + '\n');
console.log(JSON.stringify({ runId: run.runId, termination: run.termination, alightedAt: alighted[0].time, metroBoarded: boarded.length,
  lastConnectionMissed: failed.length, completedJourneys: run.metrics.service.completedJourneys, finalTime: index.availableTime }));
