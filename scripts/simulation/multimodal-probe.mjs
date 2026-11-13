// Actual SUMO motion plus independently checked service/event conservation.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createJob, readJson, verifyResult, sha256 } from './job.mjs';
const require = createRequire(import.meta.url);
const { PythonRunner } = require('../../bin/python-runner.js');
const { validateModulePackage } = require('../../bin/module-installer.js');
const { parseTrafficScenario } = require('../../bin/contracts/simulation.js');
const python = process.env.TAU_PYTHON_COMMAND, moduleRoot = process.env.TRANSPORTX_SIMULATION_MODULE;
const demoRoot = process.env.TRANSPORTX_SIMULATION_DEMO_MODULE;
assert.ok(python && moduleRoot && demoRoot, 'Set TAU_PYTHON_COMMAND, TRANSPORTX_SIMULATION_MODULE and TRANSPORTX_SIMULATION_DEMO_MODULE.');
const manifest = readJson(path.join(moduleRoot, 'manifest.json'));
validateModulePackage(moduleRoot, manifest);
const runtime = manifest.contributes.nativeRuntimes.find(value => value.kind === 'sumo');
const root = path.resolve(process.argv[2]); fs.mkdirSync(root);
const data = path.join(demoRoot, 'assets/night-demo');
const network = path.join(root, 'network.net.xml'); fs.copyFileSync(path.join(data, 'network.net.xml'), network);
const runner = new PythonRunner({ command: python, args: [] });
const evidence = { protocol: 'transportx-multimodal-probe', version: 1, scope: 'P2 technical model proof, actual SUMO and typed job; product/native-model acceptance remains separate', runs: [] };
const profiles = ['multimodal-baseline', 'multimodal-threshold'];
if (process.env.SIMULATION_REPRESENTATIVE === '1') profiles.push('representative');
for (const name of profiles) {
  const source = readJson(path.join(data, (name === 'representative' ? 'multimodal-baseline' : name) + '.json'));
  if (name === 'representative') {
    const template = source.configuration.coordination.travelers;
    source.configuration.backgroundCount = 120;
    source.configuration.coordination.travelers = Array.from({ length: 100 }, (_, i) => ({ ...template[i % template.length], id: `representative-${i}`, time: i }));
  }
  const document = parseTrafficScenario(source);
  assert.ok(document, name);
  const outputRoot = path.join(root, name); fs.mkdirSync(outputRoot);
  const job = createJob(document.configuration, { network, inputRoot: root, outputRoot, sumo: path.resolve(moduleRoot, runtime.executables.sumo.path), projData: path.resolve(moduleRoot, runtime.projData), runId: name });
  const jobFile = path.join(root, name + '-job.json'); fs.writeFileSync(jobFile, JSON.stringify(job));
  await runner.run(path.resolve('modules/capabilities/traffic-simulation/scripts/compute.py'), [jobFile], { cwd: root, envMode: 'replace', env: { PYTHONPATH: path.resolve(moduleRoot, runtime.pythonPath) }, timeoutMs: 65_000, processWeight: 2, maxBuffer: 65536 });
  const verified = verifyResult(outputRoot, job, sha256(fs.readFileSync(jobFile)));
  const { result, events, blocks } = verified;
  assert.equal(result.metrics.service.totalTravelers, document.configuration.coordination.travelers.length);
  assert.equal(result.metrics.road.planned, document.configuration.backgroundCount + document.configuration.coordination.fleet.length);
  const people = new Map(document.configuration.coordination.travelers.map(person => [person.id, person]));
  for (const { block } of blocks) for (const frame of block.frames) {
    assert.equal(Object.keys(frame.travelers).length, people.size);
    const occupied = Object.values(frame.fleet).flatMap(vehicle => vehicle.occupants);
    assert.equal(occupied.length, new Set(occupied).size);
    assert.deepEqual(occupied.sort(), Object.entries(frame.travelers).filter(([, person]) => ['riding', 'boarding'].includes(person.state)).map(([id]) => id).sort());
    for (const node of document.configuration.coordination.nodes) assert.ok(Object.values(frame.travelers).filter(person => person.location === node.id && ['waiting', 'walking', 'connecting'].includes(person.state)).length <= node.waitingCapacity);
  }
  const boarded = events.filter(event => event.type === 'boarded');
  assert.equal(boarded.length, new Set(boarded.map(event => event.objectId)).size);
  assert.ok(events.some(event => event.type === 'arrival_blocked'), 'Full pickup queues retain blocked upstream demand');
  for (const event of boarded) {
    const accepted = events.find(candidate => candidate.type === 'engine_accepted' && candidate.action === 'dispatch' && candidate.trip === event.trip && candidate.objectId === event.vehicle);
    assert.ok(accepted && accepted.time < event.time, 'Engine command and observed departure remain separate');
    assert.ok(event.time >= people.get(event.objectId).time, 'No boarding before arrival');
  }
  const last = blocks.at(-1).block.frames.at(-1);
  const arrived = [...people.values()].filter(person => person.time <= last.time);
  const wait = arrived.reduce((sum, person) => sum + (last.travelers[person.id].hubDeparture ?? last.time) - person.time, 0);
  assert.equal(result.metrics.service.hubWaitPersonSeconds, wait);
  assert.equal(result.metrics.service.meanHubWaitSeconds, wait / arrived.length);
  for (const train of document.configuration.coordination.metro) {
    const served = events.filter(event => event.type === 'metro_boarded' && event.service === train.id);
    assert.ok(served.length <= train.capacity);
    for (const event of served) {
      const alight = events.find(candidate => candidate.type === 'alighted' && candidate.objectId === event.objectId);
      const route = document.configuration.coordination.routes.find(route => route.id === event.routeId);
      assert.ok(alight && alight.time + route.transferSeconds <= train.time, 'Actual arrival plus walking must meet the departure cutoff');
    }
  }
  for (const event of events.filter(event => event.type === 'policy_observed')) {
    assert.equal(event.observedTime, event.time);
    assert.ok(event.queueCount >= document.configuration.coordination.policy.threshold);
    const eligible = [...people.values()].filter(person => person.route === event.routeId && person.time <= event.time && !boarded.some(board => board.objectId === person.id && board.time <= event.time));
    assert.ok(event.queueCount <= eligible.length, 'Feedback never reads future demand');
  }
  const started = readJson(path.join(outputRoot, 'started.json'));
  for (const pid of [started.pythonPid, started.sumoPid]) assert.throws(() => process.kill(pid, 0), 'Native processes actually stopped');
  evidence.runs.push({ name, runId: job.runId, jobSha256: sha256(fs.readFileSync(jobFile)), result, eventTypes: [...new Set(events.map(event => event.type))], observedFeedback: events.filter(event => event.type === 'policy_observed') });
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ name, completedJourneys: result.metrics.service.completedJourneys, meanAllWaitSeconds: result.metrics.service.waiting?.meanAllWaitSeconds, p90AllWaitSeconds: result.metrics.service.waiting?.p90AllWaitSeconds, lastServiceMisses: result.metrics.service.lastServiceMisses, wallSeconds: result.timings.wallSeconds }));
}
