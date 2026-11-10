import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isWithin } from './util/path.js';
import { parseSimulationConfiguration, type SimulationConfiguration, type SimulationMapping, type SimulationIndex, type SimulationBlock, type SimulationEvent, type SimulationComputeResult, type SimulationFile, type TrafficScenario } from '../contracts/simulation.js';

export const simulationDigest = (bytes: string | Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
export const readSimulationJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;
export type SimulationJob = {
  protocol: 'transportx-simulation-job'; version: 2; runId: string; implementation: { version: string; sha256: string };
  scenario: SimulationConfiguration; network: { path: string; sha256: string; version: string };
  provenance: TrafficScenario['provenance'];
  mapping: SimulationMapping & { networkVersion: string; networkSha256: string };
  execution: { outputRoot: string; sumo: string; wallSeconds: number; maxOutputBytes: number; projData?: string };
};
export function createSimulationJob(request: unknown, trusted: { network: string; inputRoot: string; outputRoot: string; sumo: string; projData?: string; runId: string; implementationRoot: string; implementationVersion: string; mapping: SimulationMapping; provenance: TrafficScenario['provenance'] }): SimulationJob {
  const scenario = parseSimulationConfiguration(request);
  if (!scenario) throw new Error('simulation_configuration_invalid');
  const network = path.resolve(trusted.network);
  for (let current = network; ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('input_symlink');
    if (path.dirname(current) === current) break;
  }
  if (!isWithin(fs.realpathSync(trusted.inputRoot), fs.realpathSync(network))) throw new Error('input_outside_root');
  const bytes = fs.readFileSync(network);
  if (bytes.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY|<include\b|\b(?:file|href)\s*=/i.test(bytes.toString('utf8'))) throw new Error('network_indirect_reference');
  const hash = simulationDigest(bytes);
  const code = ['compute.py', 'engine.py', 'model.py', 'blocks.py'].map((name) => ({ name, sha256: simulationDigest(fs.readFileSync(path.join(trusted.implementationRoot, name))) }));
  return {
    protocol: 'transportx-simulation-job', version: 2, runId: trusted.runId,
    implementation: { version: trusted.implementationVersion, sha256: simulationDigest(JSON.stringify(code)) }, scenario, provenance: trusted.provenance,
    network: { path: fs.realpathSync(network), sha256: hash, version: scenario.networkVersion },
    mapping: { ...trusted.mapping, networkVersion: scenario.networkVersion, networkSha256: hash },
    execution: { outputRoot: fs.realpathSync(trusted.outputRoot), sumo: fs.realpathSync(trusted.sumo), wallSeconds: 60, maxOutputBytes: 64 * 1024 * 1024, ...(trusted.projData ? { projData: fs.realpathSync(trusted.projData) } : {}) },
  };
}

export function readSimulationIndex(root: string, runId: string): SimulationIndex {
  const file = path.join(root, 'index.json');
  if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 512 * 1024) throw new Error('index_budget_or_path');
  const index = readSimulationJson<SimulationIndex>(file);
  if (index.protocol !== 'transportx-simulation-index' || index.version !== 1 || index.runId !== runId || !Array.isArray(index.chunks) || index.chunks.length > 360 || index.revision !== index.chunks.length) throw new Error('index_identity');
  if (index.chunks.reduce((sum, chunk, i) => { if (chunk.sequence !== i || !Number.isInteger(chunk.bytes) || !Number.isInteger(chunk.events?.bytes) || chunk.bytes < 1 || chunk.bytes > 2 * 1024 * 1024 || chunk.events.bytes < 1 || chunk.events.bytes > 2 * 1024 * 1024) throw new Error('index_chunk_budget'); return sum + chunk.bytes + chunk.events.bytes; }, 0) > 64 * 1024 * 1024) throw new Error('index_total_budget');
  return index;
}
export function readSimulationChunk(root: string, index: SimulationIndex, sequence: number) {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence >= index.chunks.length) throw new Error('chunk_unavailable');
  const entry = index.chunks[sequence];
  const read = <T>(file: SimulationFile): T => {
    if (!/^(block|events)-\d+\.json$/.test(file.path) || !Number.isInteger(file.bytes) || file.bytes < 1 || file.bytes > 2 * 1024 * 1024) throw new Error('chunk_budget');
    const target = path.join(root, file.path);
    if (fs.lstatSync(target).isSymbolicLink() || !isWithin(fs.realpathSync(root), fs.realpathSync(target))) throw new Error('chunk_path');
    if (fs.statSync(target).size !== file.bytes) throw new Error('chunk_size');
    const bytes = fs.readFileSync(target);
    if (simulationDigest(bytes) !== file.sha256) throw new Error('chunk_hash');
    return JSON.parse(bytes.toString('utf8')) as T;
  };
  const block = read<SimulationBlock>(entry), events = read<SimulationEvent[]>(entry.events);
  if (block.protocol !== 'transportx-simulation-block' || block.version !== 1 || block.runId !== index.runId || block.sequence !== sequence || block.networkSha256 !== index.networkSha256 || block.start.time !== entry.from || !Array.isArray(events) || events.length !== entry.eventCount || block.eventStart !== entry.eventStart || !Array.isArray(block.frames) || block.frames.length > 11 || !block.frames.length) throw new Error('chunk_identity');
  return { block, events };
}
export function readSimulationPublished(root: string, runId: string) {
  const index = readSimulationIndex(root, runId);
  return { index, blocks: index.chunks.map((_entry, sequence) => readSimulationChunk(root, index, sequence)) };
}
export function verifySimulationResult(root: string, job: SimulationJob, jobSha256: string) {
  if (fs.statSync(path.join(root, 'result.json')).size > 2 * 1024 * 1024) throw new Error('result_budget');
  const result = readSimulationJson<SimulationComputeResult>(path.join(root, 'result.json'));
  const published = readSimulationPublished(root, job.runId);
  if (result.protocol !== 'transportx-simulation-result' || result.version !== 1 || result.runId !== job.runId || result.termination !== 'completed' || result.finalTime !== result.durationSeconds || !result.engineExited || result.engineExitCode !== 0 || result.networkSha256 !== published.index.networkSha256 || result.networkSha256 !== job.network.sha256 || result.durationSeconds !== job.scenario.durationSeconds || result.jobSha256 !== jobSha256 || result.source !== job.provenance.kind || result.calibration !== 'not_calibrated' || !Array.isArray(result.files) || result.files.length > 800) throw new Error('result_unconfirmed');
  let bytesTotal = 0;
  for (const file of result.files) {
    if (!/^[a-z][a-z0-9.-]*$/.test(file.path) || !Number.isInteger(file.bytes) || file.bytes < 0) throw new Error('result_path');
    bytesTotal += file.bytes;
    if (bytesTotal > job.execution.maxOutputBytes) throw new Error('result_budget');
    const target = path.join(root, file.path);
    if (fs.lstatSync(target).isSymbolicLink() || fs.statSync(target).size !== file.bytes || simulationDigest(fs.readFileSync(target)) !== file.sha256) throw new Error('result_integrity');
  }
  const required = ['index.json', 'metrics.json', 'started.json', 'tripinfo.xml', ...published.index.chunks.flatMap((entry) => [entry.path, entry.events.path])];
  if (new Set(result.files.map((file) => file.path)).size !== result.files.length || required.some((name) => !result.files.some((file) => file.path === name))) throw new Error('result_files_missing');
  if (JSON.stringify(readSimulationJson(path.join(root, 'metrics.json'))) !== JSON.stringify(result.metrics)) throw new Error('metrics_mismatch');
  const events = published.blocks.flatMap((entry) => entry.events);
  if (events.some((event, i) => event.sequence !== i) || events.length !== result.eventCount || !published.index.final || published.index.availableTime !== result.finalTime) throw new Error('result_coverage');
  const raw = fs.readFileSync(path.join(root, 'tripinfo.xml'), 'utf8');
  const rows = [...raw.matchAll(/<tripinfo\s+id="([^"]+)"[^>]*\bdepart="([^"]+)"[^>]*\barrival="([^"]+)"/g)], road = result.metrics.road;
  const plannedIds = Array.from({ length: job.scenario.backgroundCount }, (_value, i) => `road-${i}`);
  if (job.scenario.model === 'evacuation') plannedIds.push('bus-0', 'car-0');
  if (!raw.includes('</tripinfos>') || road.planned !== plannedIds.length || rows.length !== road.planned || new Set(rows.map((row) => row[1])).size !== road.planned || rows.some((row) => !plannedIds.includes(row[1])) || rows.filter((row) => Number(row[2]) >= 0).length !== road.inserted || rows.filter((row) => Number(row[3]) >= 0).length !== road.arrived || road.planned !== road.inserted + road.pendingInsertion.length + road.notYetDue.length) throw new Error('raw_counts_mismatch');
  if (job.scenario.model === 'evacuation') {
    const last = published.blocks.at(-1)!.block.frames.at(-1)!;
    if (!last.travelers || !result.metrics.service) throw new Error('service_missing');
    const states: Record<string, number> = {};
    for (const person of Object.values(last.travelers)) states[person.state] = (states[person.state] || 0) + 1;
    if (job.scenario.service!.travelers.some((person) => !last.travelers![person.id])) throw new Error('traveler_id_mismatch');
    const metrics = result.metrics.service;
    if (Object.values(last.travelers).length !== job.scenario.service!.travelers.length || Object.entries(states).some(([key, count]) => metrics.states[key] !== count) || Object.keys(states).length !== Object.keys(metrics.states).length || (states.completed || 0) !== metrics.completedJourneys || new Set(events.filter((event) => event.type === 'boarded').map((event) => event.objectId)).size !== metrics.hubDepartures) throw new Error('service_counts_mismatch');
  }
  return { result, ...published, events };
}
