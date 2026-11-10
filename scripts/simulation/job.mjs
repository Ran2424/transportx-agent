// P0 executable draft, deliberately separate from future model-facing tool schemas.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isWithin } = require('../../bin/util/path.js');
export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function validateScenario(value) {
  const fields = ['schemaVersion', 'model', 'networkVersion', 'serviceDate', 'timezone', 'startTime', 'durationSeconds', 'seed', 'stepSeconds', 'decisionSeconds', 'sampleSeconds', 'blockSeconds', 'units', 'backgroundCount', 'service'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) throw new Error('scenario_fields');
  if (value.schemaVersion !== 1 || !['road', 'evacuation'].includes(value.model) || typeof value.networkVersion !== 'string' || !/^synthetic-loop\/v[1-9]\d*$/.test(value.networkVersion)) throw new Error('scenario_version');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.serviceDate) || !Number.isFinite(Date.parse(`${value.serviceDate}T00:00:00Z`)) || new Date(`${value.serviceDate}T00:00:00Z`).toISOString().slice(0, 10) !== value.serviceDate) throw new Error('service_date');
  // P0 supports only its fixed offset fixture; DST zones require an explicit ambiguity rule before support.
  if (value.timezone !== 'Asia/Shanghai' || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value.startTime)) throw new Error('clock_invalid');
  for (const [key, min, max] of [['durationSeconds', 1, 3600], ['seed', 0, 2147483647], ['backgroundCount', 0, 1000]]) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) throw new Error(`${key}_invalid`);
  }
  if (value.stepSeconds !== 1 || value.decisionSeconds !== 1 || value.sampleSeconds !== 2 || value.blockSeconds !== 10) throw new Error('sampling_unsupported');
  const units = value.units;
  if (!units || Object.keys(units).sort().join() !== 'distance,speed,time' || units.time !== 's' || units.distance !== 'm' || units.speed !== 'm/s') throw new Error('units_invalid');
  if ((value.model === 'road') === ('service' in value)) throw new Error('service_model_mismatch');
  if (value.model === 'evacuation') {
    const service = value.service;
    if (!service || Object.keys(service).sort().join() !== 'boardingSeconds,busCapacity,departures,externalSeconds,metro,transferSeconds,travelers') throw new Error('service_fields');
    for (const key of ['busCapacity', 'boardingSeconds', 'transferSeconds', 'externalSeconds']) {
      if (!Number.isInteger(service[key]) || service[key] < 1 || service[key] > 1000) throw new Error('service_number');
    }
    for (const [name, fields] of [['departures', 'id,time,vehicle'], ['metro', 'capacity,id,time'], ['travelers', 'destination,id,mode,time']]) {
      const rows = service[name];
      if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw new Error('service_rows');
      const ids = new Set();
      for (const row of rows) {
        if (!row || Object.keys(row).sort().join() !== fields || !Number.isInteger(row.time) || row.time < 0 || row.time > 7200) throw new Error('service_row');
        if (typeof row.id !== 'string' || !/^[A-Za-z0-9-]+$/.test(row.id) || ids.has(row.id)) throw new Error('service_id');
        ids.add(row.id);
        if (name === 'departures' && row.vehicle !== 'bus-0') throw new Error('service_vehicle');
        if (name === 'metro' && (!Number.isInteger(row.capacity) || row.capacity < 1 || row.capacity > 1000)) throw new Error('metro_capacity');
        if (name === 'travelers' && !((row.mode === 'bus' && row.destination === 'east') || (row.mode === 'ridehail' && row.destination === 'west'))) throw new Error('itinerary_unsupported');
      }
    }
  }
  return structuredClone(value);
}

export function createJob(request, trusted) {
  const scenario = validateScenario(request);
  const network = path.resolve(trusted.network);
  for (let cursor = network; ; cursor = path.dirname(cursor)) {
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('input_symlink');
    if (path.dirname(cursor) === cursor) break;
  }
  const root = fs.realpathSync(trusted.inputRoot);
  if (!isWithin(root, fs.realpathSync(network))) throw new Error('input_outside_root');
  const bytes = fs.readFileSync(network);
  if (bytes.length > 2 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY|<include\b|\b(?:file|href)\s*=/i.test(bytes.toString('utf8'))) throw new Error('network_indirect_reference');
  const hash = sha256(bytes);
  return {
    protocol: 'transportx-simulation-job', version: 1, runId: trusted.runId,
    implementation: { version: 'p0.1', sha256: sha256(JSON.stringify(['compute.py', 'engine.py', 'model.py', 'blocks.py'].map((name) => ({ name, sha256: sha256(fs.readFileSync(fileURLToPath(new URL(name, import.meta.url)))) })))) },
    scenario,
    network: { path: fs.realpathSync(network), sha256: hash, version: scenario.networkVersion },
    mapping: { version: 1, networkVersion: scenario.networkVersion, networkSha256: hash, edges: { hub: 'hub', outbound: 'out', relay: 'relay', inbound: 'back' } },
    execution: { outputRoot: fs.realpathSync(trusted.outputRoot), sumo: fs.realpathSync(trusted.sumo), wallSeconds: 60, maxOutputBytes: 64 * 1024 * 1024 },
  };
}

export function readIndex(outputRoot, expectedRunId) {
  if (fs.statSync(path.join(outputRoot, 'index.json')).size > 512 * 1024) throw new Error('index_budget');
  const index = readJson(path.join(outputRoot, 'index.json'));
  if (index.protocol !== 'transportx-simulation-index' || index.version !== 1 || index.runId !== expectedRunId || !Array.isArray(index.chunks) || index.chunks.length > 360) throw new Error('index_identity');
  return index;
}

export function readChunk(outputRoot, index, sequence) {
  const entry = index.chunks[sequence];
  const read = (entry) => {
    if (!/^((block|events)-\d+\.json)$/.test(entry.path) || entry.bytes > 2 * 1024 * 1024) throw new Error('chunk_budget');
    const target = path.join(outputRoot, entry.path);
    if (fs.lstatSync(target).isSymbolicLink() || !isWithin(fs.realpathSync(outputRoot), fs.realpathSync(target))) throw new Error('chunk_path');
    if (fs.statSync(target).size !== entry.bytes) throw new Error('chunk_size');
    const bytes = fs.readFileSync(target);
    if (sha256(bytes) !== entry.sha256) throw new Error('chunk_hash');
    return JSON.parse(bytes);
  };
  const block = read(entry), events = read(entry.events);
  if (block.protocol !== 'transportx-simulation-block' || block.version !== 1 || block.runId !== index.runId || block.sequence !== sequence || block.networkSha256 !== index.networkSha256 || block.start.time !== entry.from || events.length !== entry.eventCount || block.eventStart !== entry.eventStart) throw new Error('chunk_identity');
  return { block, events };
}

export function readPublished(outputRoot, expectedRunId) {
  const index = readIndex(outputRoot, expectedRunId);
  return { index, blocks: index.chunks.map((_entry, sequence) => readChunk(outputRoot, index, sequence)) };
}

export function verifyResult(root, job, jobSha256) {
  const runId = job.runId;
  if (fs.statSync(path.join(root, 'result.json')).size > 2 * 1024 * 1024) throw new Error('result_budget');
  const result = readJson(path.join(root, 'result.json'));
  const published = readPublished(root, runId);
  if (result.protocol !== 'transportx-simulation-result' || result.version !== 1 || result.runId !== runId || result.termination !== 'completed' || result.finalTime !== result.durationSeconds || !result.engineExited || result.networkSha256 !== published.index.networkSha256 || result.networkSha256 !== job.network.sha256 || result.durationSeconds !== job.scenario.durationSeconds || result.jobSha256 !== jobSha256) throw new Error('result_unconfirmed');
  for (const file of result.files) {
    if (!/^[a-z][a-z0-9.-]*$/.test(file.path)) throw new Error('result_path');
    const target = path.join(root, file.path);
    if (fs.lstatSync(target).isSymbolicLink() || fs.statSync(target).size !== file.bytes || sha256(fs.readFileSync(target)) !== file.sha256) throw new Error('result_integrity');
  }
  const required = ['index.json', 'metrics.json', 'started.json', 'tripinfo.xml', ...published.index.chunks.flatMap((entry) => [entry.path, entry.events.path])];
  if (new Set(result.files.map((file) => file.path)).size !== result.files.length || required.some((name) => !result.files.some((file) => file.path === name))) throw new Error('result_files_missing');
  if (JSON.stringify(readJson(path.join(root, 'metrics.json'))) !== JSON.stringify(result.metrics)) throw new Error('metrics_mismatch');
  const events = published.blocks.flatMap((entry) => entry.events);
  if (events.some((event, i) => event.sequence !== i) || events.length !== result.eventCount || !published.index.final || published.index.availableTime !== result.finalTime) throw new Error('result_coverage');
  const raw = fs.readFileSync(path.join(root, 'tripinfo.xml'), 'utf8');
  const rows = [...raw.matchAll(/<tripinfo\s+id="([^"]+)"[^>]*\bdepart="([^"]+)"[^>]*\barrival="([^"]+)"/g)];
  const road = result.metrics.road;
  const plannedIds = Array.from({ length: job.scenario.backgroundCount }, (_value, i) => `road-${i}`);
  if (job.scenario.model === 'evacuation') plannedIds.push('bus-0', 'car-0');
  if (!raw.includes('</tripinfos>') || road.planned !== plannedIds.length || rows.length !== road.planned || new Set(rows.map((row) => row[1])).size !== road.planned || rows.some((row) => !plannedIds.includes(row[1])) || rows.filter((row) => Number(row[2]) >= 0).length !== road.inserted || rows.filter((row) => Number(row[3]) >= 0).length !== road.arrived || road.planned !== road.inserted + road.pendingInsertion.length + road.notYetDue.length) throw new Error('raw_counts_mismatch');
  if (job.scenario.model === 'evacuation') {
    const last = published.blocks.at(-1).block.frames.at(-1);
    const states = {};
    for (const person of Object.values(last.travelers)) states[person.state] = (states[person.state] || 0) + 1;
    if (job.scenario.service.travelers.some((person) => !last.travelers[person.id])) throw new Error('traveler_id_mismatch');
    const metrics = result.metrics.service;
    if (Object.values(last.travelers).length !== job.scenario.service.travelers.length || Object.entries(states).some(([key, count]) => metrics.states[key] !== count) || Object.keys(states).length !== Object.keys(metrics.states).length || (states.completed || 0) !== metrics.completedJourneys || new Set(events.filter((event) => event.type === 'boarded').map((event) => event.objectId)).size !== metrics.hubDepartures) throw new Error('service_counts_mismatch');
  }
  return { result, ...published, events };
}
