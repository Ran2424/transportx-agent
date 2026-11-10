// Real SUMO P0 acceptance. No mocked engine or model responses; missing runtime fails.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createJob, validateScenario, readJson, readIndex, readChunk, readPublished, verifyResult, sha256 } from './job.mjs';
import { stageRuntime, loadRuntime, inspectNativeProcess } from './runtime.mjs';
const require = createRequire(import.meta.url);
const { PythonRunner } = require('../../bin/python-runner.js');
const { ProcessRunner } = require('../../bin/process-runner.js');
const fixture = path.resolve('test/fixtures/simulation');
const script = path.resolve('modules/optional/traffic-simulation/scripts/compute.py');
const python = process.env.TAU_PYTHON_COMMAND;
const dependencies = process.env.TRANSPORTX_SIMULATION_DEPS;
if (!python || (!dependencies && !process.env.TRANSPORTX_SIMULATION_RUNTIME)) throw new Error('Set TAU_PYTHON_COMMAND and an explicit dependency directory or verified runtime');
const root = path.resolve(process.argv[2] || `tmp/simulation-p0-${Date.now()}`);
fs.mkdirSync(path.dirname(root), { recursive: true });
fs.mkdirSync(root);
const evidenceRoot = fs.realpathSync(root);
console.log('P0: inspecting and relocating native runtime');
const runtime = process.env.TRANSPORTX_SIMULATION_RUNTIME ? loadRuntime(process.env.TRANSPORTX_SIMULATION_RUNTIME) : await stageRuntime(dependencies, evidenceRoot);
const runner = new PythonRunner({ command: python, args: [] });
const environment = { PYTHONPATH: runtime.pythonPath, SUMO_HOME: path.dirname(path.dirname(runtime.sumo)) };
const network = path.join(evidenceRoot, 'network.net.xml');
const convertCommand = ['--node-files', path.join(fixture, 'nodes.nod.xml'), '--edge-files', path.join(fixture, 'edges.edg.xml'), '--output-file', network, '--no-turnarounds', 'true', '--xml-validation', 'never'];
const converted = await new ProcessRunner().run({ command: runtime.netconvert, args: [] }, convertCommand, { cwd: evidenceRoot, envMode: 'replace', env: environment, timeoutMs: 60000, maxBuffer: 65536 });
const evidence = { protocol: 'transportx-simulation-p0-evidence', version: 1, hardware: { architecture: os.arch(), os: os.version(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem() }, runtime: runtime.evidence,
  network: { sha256: sha256(fs.readFileSync(network)), command: [runtime.netconvert, ...convertCommand], stdout: converted.stdout, stderr: converted.stderr }, runs: [], conversionCases: [], failures: [] };
const prepare = (name, scenario, networkInput = network) => {
  const outputRoot = path.join(evidenceRoot, name);
  fs.mkdirSync(outputRoot);
  const job = createJob(scenario, { network: networkInput, inputRoot: evidenceRoot, outputRoot, sumo: runtime.sumo, runId: name });
  const file = path.join(evidenceRoot, `${name}-job.json`);
  fs.writeFileSync(file, JSON.stringify(job));
  return { job, file, outputRoot, hash: sha256(fs.readFileSync(file)) };
};
const absent = (pid) => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } };
const delay = () => new Promise((resolve) => setTimeout(resolve, 10));

async function execute(prepared, stop) {
  const { job, file, outputRoot } = prepared;
  let outcome;
  const controller = new AbortController();
  const pending = runner.run(script, [file], { cwd: evidenceRoot, envMode: 'replace', env: environment, signal: controller.signal, timeoutMs: 65000, maxBuffer: 65536 }).then((value) => { outcome = { ok: true, ...value }; }, (error) => { outcome = { ok: false, error }; });
  let revision = 0, live = false, triggered = false, native, pythonMemory;
  const reads = [], latencies = [], memorySamples = [];
  while (!outcome) {
    if (fs.existsSync(path.join(outputRoot, 'index.json'))) {
      const started = performance.now();
      const index = readIndex(outputRoot, job.runId);
      if (index.revision !== revision) {
        revision = index.revision;
        const sequence = index.chunks.length - 1;
        const { block } = readChunk(outputRoot, index, sequence);
        reads.push(performance.now() - started);
        const frame = block.frames.at(-1);
        latencies.push(Date.now() - frame.generatedWallNs / 1e6);
        live ||= !index.final && !fs.existsSync(path.join(outputRoot, 'result.json'));
        // An unindexed, incomplete file must stay invisible even after index re-fetch.
        fs.writeFileSync(path.join(outputRoot, 'unpublished.json.part'), '{"incomplete":');
        assert.ok(!readIndex(outputRoot, job.runId).chunks.some((entry) => entry.path.includes('unpublished')));
        if (!stop && job.runId === 'representative' && !index.final && (memorySamples.length === 0 || index.revision % 10 === 0)) {
          const ids = readJson(path.join(outputRoot, 'started.json'));
          memorySamples.push({ computedTime: index.computedTime, native: await inspectNativeProcess(ids.sumoPid), python: await inspectNativeProcess(ids.pythonPid) });
        }
        if (!triggered && stop) {
          triggered = true;
          const ids = readJson(path.join(outputRoot, 'started.json'));
          native = await inspectNativeProcess(ids.sumoPid);
          pythonMemory = await inspectNativeProcess(ids.pythonPid);
          if (stop === 'cancel') controller.abort();
          else process.kill(ids.sumoPid, 'SIGKILL');
        }
      }
    }
    await delay();
  }
  await pending;
  assert.equal(runner.activeCount, 0);
  const started = readJson(path.join(outputRoot, 'started.json'));
  assert.ok(absent(started.sumoPid), 'SUMO descendant must really be absent');
  assert.ok(absent(started.pythonPid), 'Python must really be absent');
  assert.ok(!started.environmentKeys.includes('TRANSPORTX_TEST_PARENT_SECRET'));
  assert.ok(!started.environmentKeys.includes('TAU_SESSION_TOKEN'));
  const observation = { liveBeforeCompletion: live, readMilliseconds: reads, visibleDelayMilliseconds: latencies, memorySamples, native, pythonMemory };
  if (stop) {
    assert.ok(triggered && live, 'failure injection must happen after real incremental publication');
    assert.equal(outcome.ok, false);
    if (stop === 'cancel') assert.match(outcome.error.message, /cancelled/);
    assert.throws(() => verifyResult(outputRoot, job, prepared.hash));
    const partial = readPublished(outputRoot, job.runId);
    assert.ok(partial.index.chunks.length > 0 && !partial.index.final);
    const partialResult = fs.existsSync(path.join(outputRoot, 'result.json')) ? readJson(path.join(outputRoot, 'result.json')) : null;
    assert.equal(partialResult?.termination, stop === 'cancel' ? 'cancelled' : 'unknown');
    evidence.failures.push({ name: job.runId, stop, observation, error: outcome.error.message, result: partialResult, publishedThrough: partial.index.availableTime, pidsAbsent: true });
    return;
  }
  assert.ok(outcome.ok, outcome.error?.message);
  assert.ok(reads.length > 0 && Math.max(...reads) <= 50, 'P0 local read budget exceeded');
  assert.ok(Math.max(...latencies) <= 1000, 'P0 local visibility budget exceeded');
  const verified = verifyResult(outputRoot, job, prepared.hash);
  const roadMetrics = verified.result.metrics.road;
  assert.equal(roadMetrics.planned, job.scenario.backgroundCount + (job.scenario.model === 'evacuation' ? 2 : 0));
  assert.equal(roadMetrics.planned, roadMetrics.inserted + roadMetrics.pendingInsertion.length + roadMetrics.notYetDue.length);
  assert.equal(roadMetrics.inserted, roadMetrics.arrived + roadMetrics.activeOrUnfinished);
  // Every block is independently restorable without holding a preceding block.
  for (let sequence = 0; sequence < verified.index.chunks.length; sequence++) {
    const refreshed = readIndex(outputRoot, job.runId);
    const isolated = readChunk(outputRoot, refreshed, sequence);
    assert.equal(isolated.block.start.time, refreshed.chunks[sequence].from);
    assert.deepEqual(isolated.block.frames[0], isolated.block.start);
    assert.ok(isolated.events.every((event) => event.time >= refreshed.chunks[sequence].fromTime && event.time <= refreshed.chunks[sequence].toTime));
    for (const frame of isolated.block.frames) {
      if (!frame.travelers) continue;
      const people = Object.values(frame.travelers);
      assert.equal(people.length, job.scenario.service.travelers.length);
      const occupants = Object.entries(frame.fleet).flatMap(([vid, v]) => v.occupants.map((pid) => [pid, vid]));
      assert.equal(new Set(occupants.map(([pid]) => pid)).size, occupants.length);
      for (const [pid, vid] of occupants) assert.equal(frame.travelers[pid].location, vid);
    }
  }
  evidence.runs.push({ name: job.runId, jobSha256: prepared.hash, result: verified.result, observation, pidsAbsent: true });
  return verified;
}

const oldMarker = process.env.TRANSPORTX_TEST_PARENT_SECRET;
const oldToken = process.env.TAU_SESSION_TOKEN;
process.env.TRANSPORTX_TEST_PARENT_SECRET = 'must-not-reach-python-or-sumo';
process.env.TAU_SESSION_TOKEN = 'p0-injected-test-token';
try {
  console.log('P0: real road and hand-checkable evacuation');
  const roadInput = readJson(path.join(fixture, 'road.json'));
  const road = await execute(prepare('road', roadInput));
  assert.equal(road.result.metrics.road.inserted, 3);
  assert.equal(road.result.metrics.road.arrived, 3);
  assert.equal(road.result.metrics.road.pendingInsertion.length, 0);
  assert.equal(road.result.metrics.service, undefined);
  const serviceInput = readJson(path.join(fixture, 'evacuation.json'));
  const evacuation = await execute(prepare('evacuation', serviceInput));
  const event = (kind, id) => evacuation.events.find((entry) => entry.type === kind && entry.objectId === id);
  assert.deepEqual(evacuation.result.metrics.service.states, { completed: 2, connecting: 3, not_arrived: 1 });
  assert.equal(evacuation.result.metrics.service.hubDepartures, 5);
  assert.equal(evacuation.result.metrics.service.missedConnections, 3);
  assert.equal(event('traveler_arrived', 'a').time, 0);
  assert.equal(event('traveler_arrived', 'b').time, 5);
  assert.deepEqual(event('action_reserved', 'bus-a').travelers, ['a', 'b']);
  assert.equal(event('action_rejected', 'bus-b').reason, 'vehicle_reserved');
  assert.equal(event('action_rejected', 'bus-empty').reason, 'no_matching_demand');
  assert.ok(event('engine_accepted', 'bus-0').time < event('departure_observed', 'bus-0').time);
  assert.deepEqual(event('action_reserved', 'bus-c').travelers, ['c', 'e']);
  assert.ok(event('vehicle_available', 'bus-0').time < event('action_reserved', 'bus-c').time);
  assert.equal(event('connection_missed', 'b').reason, 'capacity');
  assert.equal(event('connection_missed', 'c').reason, 'last_service_closed');
  assert.ok(event('journey_completed', 'd').time > event('alighted', 'd').time);
  assert.equal(Date.parse(`${serviceInput.serviceDate}T${serviceInput.startTime}+08:00`) + 65 * 1000, Date.parse('2026-11-11T00:00:35+08:00'));

  console.log('P0: determinism, input boundaries and independent output verification');
  const repeat = await execute(prepare('repeat', serviceInput));
  assert.deepEqual(repeat.events, evacuation.events);
  assert.deepEqual(repeat.result.metrics, evacuation.result.metrics);
  for (const entry of readJson(path.join(fixture, 'conversion-cases.json'))) {
    const input = { ...structuredClone(roadInput), ...entry.patch };
    if (entry.delete) delete input[entry.delete];
    assert.throws(() => validateScenario(input), undefined, entry.name);
    const prepared = prepare(`invalid-${entry.name}`, roadInput);
    prepared.job.scenario = input;
    fs.writeFileSync(prepared.file, JSON.stringify(prepared.job));
    await assert.rejects(runner.run(script, [prepared.file], { cwd: evidenceRoot, envMode: 'replace', env: environment, timeoutMs: 5000 }), /simulation_input_invalid/);
    assert.ok(!fs.existsSync(path.join(prepared.outputRoot, 'started.json')));
    evidence.conversionCases.push({ name: entry.name, nodeRejected: true, pythonRejectedBeforeEngine: true });
  }
  const invalidMap = prepare('invalid-mapping', roadInput);
  invalidMap.job.mapping.roadRoute[0] = 'missing';
  fs.writeFileSync(invalidMap.file, JSON.stringify(invalidMap.job));
  await assert.rejects(runner.run(script, [invalidMap.file], { cwd: evidenceRoot, envMode: 'replace', env: environment, timeoutMs: 5000 }), /mapping_invalid/);
  assert.ok(!fs.existsSync(path.join(invalidMap.outputRoot, 'started.json')));
  const indirect = path.join(evidenceRoot, 'indirect.net.xml');
  fs.writeFileSync(indirect, '<net><include href="../outside.xml"/></net>');
  assert.throws(() => createJob(roadInput, { network: indirect, inputRoot: evidenceRoot }), /network_indirect_reference/);
  const linked = path.join(evidenceRoot, 'linked.net.xml');
  fs.symlinkSync(network, linked);
  assert.throws(() => createJob(roadInput, { network: linked, inputRoot: evidenceRoot }), /input_symlink/);
  evidence.conversionCases.push({ name: 'id-mapping', pythonRejectedBeforeEngine: true }, { name: 'xml-indirect-reference', nodeRejectedBeforeEngine: true }, { name: 'symlink', nodeRejectedBeforeEngine: true });
  const victim = path.join(evidenceRoot, 'road', road.index.chunks[0].path);
  const original = fs.readFileSync(victim);
  fs.writeFileSync(victim, Buffer.from(original.toString().replace('transportx-simulation-block', 'transportx-simulation-blocX')));
  assert.throws(() => verifyResult(path.dirname(victim), { runId: 'road', network: { sha256: evidence.network.sha256 }, scenario: roadInput }, evidence.runs[0].jobSha256), /chunk_hash/);
  fs.writeFileSync(victim, original);
  const noManifest = path.join(evidenceRoot, 'zero-exit-is-not-success');
  fs.mkdirSync(noManifest);
  await runner.run('-c', ['pass'], { cwd: evidenceRoot, envMode: 'replace', env: environment });
  assert.throws(() => verifyResult(noManifest, { runId: 'nothing' }, ''));
  const changedService = structuredClone(serviceInput);
  changedService.service.metro[0].capacity = 2;
  const variant = await execute(prepare('capacity-variant', changedService));
  assert.equal(variant.result.networkSha256, evacuation.result.networkSha256);
  assert.equal(variant.result.metrics.service.completedJourneys, 3);
  const cutoffInput = structuredClone(changedService);
  const cutoffTime = event('transfer_ready', 'a').time;
  cutoffInput.service.metro[0].time = cutoffTime;
  const cutoff = await execute(prepare('cutoff-equality', cutoffInput));
  assert.equal(cutoff.events.find((entry) => entry.type === 'metro_boarded' && entry.objectId === 'a').time, cutoffTime);
  assert.equal(cutoff.events.find((entry) => entry.type === 'transfer_ready' && entry.objectId === 'a').time, cutoffTime);
  const newEdges = path.join(evidenceRoot, 'edges-v2.edg.xml'), newNetwork = path.join(evidenceRoot, 'network-v2.net.xml');
  fs.writeFileSync(newEdges, fs.readFileSync(path.join(fixture, 'edges.edg.xml'), 'utf8').replace('speed="10"', 'speed="8"'));
  await new ProcessRunner().run({ command: runtime.netconvert, args: [] }, ['--node-files', path.join(fixture, 'nodes.nod.xml'), '--edge-files', newEdges, '--output-file', newNetwork, '--no-turnarounds', 'true', '--xml-validation', 'never'], { cwd: evidenceRoot, envMode: 'replace', env: environment, timeoutMs: 60000, maxBuffer: 65536 });
  const newScenario = { ...roadInput, networkVersion: 'synthetic-loop/v2' };
  const newJob = prepare('network-v2', newScenario, newNetwork);
  assert.equal(newJob.job.mapping.networkVersion, 'synthetic-loop/v2');
  assert.notEqual(newJob.job.mapping.networkSha256, evidence.network.sha256);
  await execute(newJob);

  console.log('P0: representative workload, real cancellation and engine fault');
  const representative = structuredClone(serviceInput);
  representative.durationSeconds = 600;
  representative.backgroundCount = 120;
  representative.service.travelers = Array.from({ length: 100 }, (_, i) => ({ id: `person-${i}`, time: i, mode: i % 5 === 0 ? 'ridehail' : 'bus', destination: i % 5 === 0 ? 'west' : 'east' }));
  const scale = await execute(prepare('representative', representative));
  assert.ok(evidence.runs.at(-1).observation.liveBeforeCompletion);
  assert.ok(scale.result.writtenBlockBytes < 64 * 1024 * 1024);
  const long = structuredClone(representative);
  long.durationSeconds = 3600;
  await execute(prepare('cancelled', long), 'cancel');
  await execute(prepare('engine-fault', long), 'fault');
  evidence.status = 'probe assertions passed; phase gate review required';
} finally {
  if (oldMarker === undefined) delete process.env.TRANSPORTX_TEST_PARENT_SECRET;
  else process.env.TRANSPORTX_TEST_PARENT_SECRET = oldMarker;
  if (oldToken === undefined) delete process.env.TAU_SESSION_TOKEN;
  else process.env.TAU_SESSION_TOKEN = oldToken;
  await runner.terminateAll();
  fs.writeFileSync(path.join(evidenceRoot, 'evidence.json'), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify({ evidence: path.join(evidenceRoot, 'evidence.json'), runs: evidence.runs.length, conversionCases: evidence.conversionCases.length, failures: evidence.failures.length, status: evidence.status }, null, 2));
