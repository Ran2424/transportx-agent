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
  const names = ['compute.py', 'engine.py', 'model.py', 'blocks.py'];
  if (fs.existsSync(path.join(trusted.implementationRoot, 'multimodal.py'))) names.push('multimodal.py');
  if (fs.existsSync(path.join(trusted.implementationRoot, 'rail.py'))) names.push('rail.py');
  const code = names.map((name) => ({ name, sha256: simulationDigest(fs.readFileSync(path.join(trusted.implementationRoot, name))) }));
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
  const rail = job.scenario.rail;
  const required = ['index.json', 'metrics.json', 'started.json', 'tripinfo.xml', ...(rail ? ['stops.xml'] : []), ...published.index.chunks.flatMap((entry) => [entry.path, entry.events.path])];
  if (new Set(result.files.map((file) => file.path)).size !== result.files.length || required.some((name) => !result.files.some((file) => file.path === name))) throw new Error('result_files_missing');
  if (JSON.stringify(readSimulationJson(path.join(root, 'metrics.json'))) !== JSON.stringify(result.metrics)) throw new Error('metrics_mismatch');
  const events = published.blocks.flatMap((entry) => entry.events);
  if (events.some((event, i) => event.sequence !== i) || events.length !== result.eventCount || !published.index.final || published.index.availableTime !== result.finalTime) throw new Error('result_coverage');
  const raw = fs.readFileSync(path.join(root, 'tripinfo.xml'), 'utf8');
  const trips = [...raw.matchAll(/<tripinfo\s+id="([^"]+)"[^>]*\bdepart="([^"]+)"[^>]*\barrival="([^"]+)"/g)], road = result.metrics.road;
  const rows = trips.filter(row => row[1] !== rail?.trainId);
  const plannedIds = Array.from({ length: job.scenario.backgroundCount }, (_value, i) => `road-${i}`);
  if (job.scenario.model === 'evacuation') plannedIds.push('bus-0', 'car-0');
  if (job.scenario.model === 'multimodal') plannedIds.push(...job.scenario.coordination!.fleet.map(vehicle => vehicle.id));
  if (!raw.includes('</tripinfos>') || road.planned !== plannedIds.length || rows.length !== road.planned || new Set(rows.map((row) => row[1])).size !== road.planned || rows.some((row) => !plannedIds.includes(row[1])) || rows.filter((row) => Number(row[2]) >= 0).length !== road.inserted || rows.filter((row) => Number(row[3]) >= 0).length !== road.arrived || road.planned !== road.inserted + road.pendingInsertion.length + road.notYetDue.length || rail && trips.length !== rows.length + 1) throw new Error('raw_counts_mismatch');
  const railDeparture = rail && events.find(event => event.type === 'metro_departed' && event.nodeId === rail.stops[rail.boardingStop].platformId);
  if (rail) {
    const stops = fs.readFileSync(path.join(root, 'stops.xml'), 'utf8');
    const physical = [...stops.matchAll(/<stopinfo\s+([^>]+)>/g)]
      .map(row => Object.fromEntries([...row[1].matchAll(/(\w+)="([^"]*)"/g)].map(attribute => [attribute[1], attribute[2]])))
      .filter(row => row.id === rail.trainId);
    const arrivalEvents = events.filter(event => event.type === 'metro_arrived');
    const departures = events.filter(event => event.type === 'metro_departed');
    if (!stops.includes('</stops>') || physical.length !== departures.length || physical.length > rail.stops.length) throw new Error('rail_stop_count_mismatch');
    for (const [i, observed] of physical.entries()) {
      const plan = rail.stops[i], arrival = arrivalEvents[i], departure = departures[i];
      if (observed.lane !== `${plan.edge}_${plan.lane}` || arrival?.nodeId !== plan.platformId || departure?.nodeId !== plan.platformId
          || arrival.observedTime !== Number(observed.started) || departure.observedTime !== Number(observed.ended)
          || departure.observedTime < plan.departure || departure.observedTime - arrival.observedTime < plan.minDwell) throw new Error('rail_stop_observation_mismatch');
    }
    const boarded = events.filter(event => event.type === 'metro_boarded');
    const capacity = job.scenario.coordination!.metro[0].capacity;
    if (boarded.length > capacity || boarded.length !== new Set(boarded.map(event => event.objectId)).size
        || boarded.some(event => !railDeparture || event.time !== railDeparture.time || event.observedTime !== railDeparture.observedTime || event.vehicle !== rail.trainId || event.service !== rail.serviceId)) throw new Error('rail_boarding_mismatch');
  }
  if (job.scenario.model !== 'road') {
    const last = published.blocks.at(-1)!.block.frames.at(-1)!;
    if (!last.travelers || !result.metrics.service) throw new Error('service_missing');
    const states: Record<string, number> = {};
    for (const person of Object.values(last.travelers)) states[person.state] = (states[person.state] || 0) + 1;
    const travelers = job.scenario.model === 'evacuation' ? job.scenario.service!.travelers : job.scenario.coordination!.travelers;
    if (travelers.some((person) => !last.travelers![person.id])) throw new Error('traveler_id_mismatch');
    const metrics = result.metrics.service;
    if (Object.values(last.travelers).length !== travelers.length || Object.entries(states).some(([key, count]) => metrics.states[key] !== count) || Object.keys(states).length !== Object.keys(metrics.states).length || (states.completed || 0) !== metrics.completedJourneys || new Set(events.filter((event) => event.type === 'boarded').map((event) => event.objectId)).size !== metrics.hubDepartures) throw new Error('service_counts_mismatch');
    if (job.scenario.model === 'multimodal') {
      const arrived = travelers.filter(person => person.time <= result.finalTime);
      const wait = arrived.reduce((sum, person) => sum + (last.travelers![person.id].hubDeparture ?? result.finalTime) - person.time, 0);
      const boarded = events.filter(event => event.type === 'boarded');
      if (boarded.length !== new Set(boarded.map(event => event.objectId)).size || metrics.arrivedTravelers !== arrived.length || metrics.hubWaitPersonSeconds !== wait || metrics.meanHubWaitSeconds !== (arrived.length ? wait / arrived.length : null)) throw new Error('service_wait_mismatch');
      const observed = [...raw.matchAll(/<tripinfo\s+([^>]+)>/g)].map(row => Object.fromEntries([...row[1].matchAll(/(\w+)="([^"]*)"/g)].map(attribute => [attribute[1], attribute[2]]))).filter(row => Number(row.depart) >= 0 && row.id !== rail?.trainId);
      const loss = observed.reduce((sum, row) => sum + Number(row.timeLoss), 0);
      if (!Number.isFinite(loss) || loss < 0 || road.timeLossVehicleSeconds !== loss || road.observedVehicleSeconds !== observed.reduce((sum, row) => sum + Number(row.duration), 0) || road.meanTimeLossSeconds !== (observed.length ? loss / observed.length : null)) throw new Error('road_time_loss_mismatch');
      if (['0.3.0', '0.4.0', '0.5.0', '0.6.0', '0.6.1'].includes(job.implementation.version) && (!metrics.waiting || !metrics.journeys || !metrics.fleet || !metrics.byRoute || !metrics.nodes)) throw new Error('service_statistics_missing');
      if (metrics.waiting) {
        const mean = (values: number[]) => values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null;
        const p90 = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.9) - 1] : null;
        const people = new Map(travelers.map(person => [person.id, { state: 'not_arrived', at: 0, waiting: 0 }]));
        const fleet = new Map(job.scenario.coordination!.fleet.map(vehicle => [vehicle.id, { trips: 0, boarded: 0, busy: 0, busyStart: null as number | null, departure: null as number | null, turnarounds: [] as number[] }]));
        const change = (id: string, state: string, time: number) => {
          const person = people.get(id);
          if (!person || time < person.at) throw new Error('service_event_state_invalid');
          if (['waiting', 'blocked', 'boarding', 'connecting'].includes(person.state)) person.waiting += time - person.at;
          person.state = state; person.at = time;
        };
        for (const event of events) {
          if (event.type === 'action_reserved') {
            for (const id of event.travelers || []) change(id, 'boarding', event.time);
            const vehicle = event.vehicle && fleet.get(event.vehicle);
            if (!vehicle || vehicle.busyStart !== null) throw new Error('fleet_reservation_conflict');
            vehicle.busyStart = event.time;
          }
          const state = ({ traveler_arrived: 'waiting', arrival_blocked: 'blocked', boarded: 'riding', transfer_ready: 'connecting', metro_boarded: 'external', journey_completed: 'completed' } as Record<string, string>)[event.type];
          if (state) change(event.objectId, state, event.time);
          if (event.type === 'alighted') {
            const route = job.scenario.coordination!.routes.find(route => route.id === event.routeId);
            if (!route) throw new Error('service_route_event_invalid');
            change(event.objectId, route.mode === 'bus' ? 'walking' : 'external', event.time);
          }
          if (event.type === 'boarded') {
            const vehicle = event.vehicle && fleet.get(event.vehicle);
            if (!vehicle || last.travelers![event.objectId].hubDeparture !== event.time) throw new Error('fleet_boarding_mismatch');
            vehicle.boarded++;
          }
          if (event.type === 'journey_completed' && last.travelers![event.objectId].completedAt !== event.time) throw new Error('journey_timestamp_mismatch');
          if (event.type === 'metro_boarded' && last.travelers![event.objectId].metroBoardedAt !== event.time) throw new Error('metro_timestamp_mismatch');
          const vehicle = fleet.get(event.objectId);
          if (vehicle && event.type === 'departure_observed') { vehicle.trips++; vehicle.departure = event.time; }
          if (vehicle && event.type === 'vehicle_available' && vehicle.busyStart !== null) {
            if (vehicle.departure === null) throw new Error('fleet_return_without_departure');
            vehicle.busy += event.time - vehicle.busyStart; vehicle.turnarounds.push(event.time - vehicle.departure); vehicle.busyStart = null; vehicle.departure = null;
          }
        }
        for (const [id, person] of people) {
          change(id, person.state, result.finalTime);
          if (last.travelers![id].waitSeconds !== person.waiting || last.travelers![id].state !== person.state) throw new Error('traveler_wait_event_mismatch');
        }
        const waits = arrived.map(person => people.get(person.id)!.waiting), completed = arrived.filter(person => last.travelers![person.id].state === 'completed').map(person => last.travelers![person.id].completedAt! - person.time), censored = arrived.map(person => (last.travelers![person.id].completedAt ?? result.finalTime) - person.time);
        if (metrics.waiting.allWaitPersonSeconds !== waits.reduce((sum, n) => sum + n, 0) || metrics.waiting.meanAllWaitSeconds !== mean(waits) || metrics.waiting.p90AllWaitSeconds !== p90(waits) || metrics.waiting.p90HubWaitSeconds !== p90(arrived.map(person => (last.travelers![person.id].hubDeparture ?? result.finalTime) - person.time)) || metrics.waiting.censoredPeople !== arrived.filter(person => last.travelers![person.id].hubDeparture === undefined).length) throw new Error('wait_distribution_mismatch');
        const journeys = metrics.journeys!;
        if (journeys.completedCount !== completed.length || journeys.arrivedCount !== arrived.length || journeys.meanCompletedSeconds !== mean(completed) || journeys.p90CompletedSeconds !== p90(completed) || journeys.meanCensoredSeconds !== mean(censored) || journeys.p90CensoredSeconds !== p90(censored)) throw new Error('journey_distribution_mismatch');
        const lastMisses = job.scenario.coordination!.travelers.filter(person => {
          const route = job.scenario.coordination!.routes.find(route => route.id === person.route)!;
          if (route.mode !== 'bus' || person.time > result.finalTime) return false;
          const lastDeparture = rail ? railDeparture?.observedTime ?? Infinity : Math.max(...job.scenario.coordination!.metro.filter(train => train.node === route.target && train.destination === person.destination).map(train => train.time));
          return lastDeparture <= result.finalTime && !events.some(event => event.type === 'metro_boarded' && event.objectId === person.id);
        });
        if (metrics.lastServiceMisses !== lastMisses.length || events.filter(event => event.type === 'last_connection_missed').length !== lastMisses.length || lastMisses.some(person => !events.some(event => event.type === 'last_connection_missed' && event.objectId === person.id))) throw new Error('last_service_misses_mismatch');
        for (const [id, observedFleet] of fleet) {
          const actual = metrics.fleet![id], busy = observedFleet.busy + (observedFleet.busyStart === null ? 0 : result.finalTime - observedFleet.busyStart);
          if (!actual || actual.loadFactor !== (observedFleet.trips ? observedFleet.boarded / (actual.capacity * observedFleet.trips) : null)) throw new Error('fleet_load_factor_mismatch');
          if (!actual || actual.capacity !== job.scenario.coordination!.fleet.find(vehicle => vehicle.id === id)!.capacity || actual.observedTrips !== observedFleet.trips || actual.passengersBoarded !== observedFleet.boarded || actual.busySeconds !== busy || actual.busyFraction !== busy / result.finalTime || JSON.stringify(actual.completedTurnaroundSeconds) !== JSON.stringify(observedFleet.turnarounds) || actual.meanCompletedTurnaroundSeconds !== mean(observedFleet.turnarounds) || actual.censoredTurnaroundSeconds !== (observedFleet.departure === null ? null : result.finalTime - observedFleet.departure)) throw new Error('fleet_utilization_mismatch');
        }
        for (const route of job.scenario.coordination!.routes) {
          const all = job.scenario.coordination!.travelers.filter(person => person.route === route.id), seen = all.filter(person => person.time <= result.finalTime), actual = metrics.byRoute![route.id];
          const routeStates: Record<string, number> = {};
          for (const person of all) routeStates[last.travelers![person.id].state] = (routeStates[last.travelers![person.id].state] || 0) + 1;
          const hub = seen.map(person => (last.travelers![person.id].hubDeparture ?? result.finalTime) - person.time), waiting = seen.map(person => people.get(person.id)!.waiting);
          if (!actual || actual.totalTravelers !== all.length || actual.arrivedTravelers !== seen.length || actual.completedJourneys !== (routeStates.completed || 0) || Object.keys(actual.states).length !== Object.keys(routeStates).length || Object.entries(routeStates).some(([state, count]) => actual.states[state] !== count) || actual.meanHubWaitSeconds !== mean(hub) || actual.p90HubWaitSeconds !== p90(hub) || actual.meanAllWaitSeconds !== mean(waiting) || actual.p90AllWaitSeconds !== p90(waiting)) throw new Error('route_statistics_mismatch');
        }
        for (const node of job.scenario.coordination!.nodes) {
          const actual = metrics.nodes![node.id];
          if (!actual || actual.waitingCapacity !== node.waitingCapacity || ['waiting', 'walking', 'connecting', 'blocked'].some(state => actual[state as 'waiting'] !== Object.values(last.travelers!).filter(person => person.state === state && person.location === (state === 'blocked' ? `upstream:${node.id}` : node.id)).length)) throw new Error('node_statistics_mismatch');
        }
        const duration = observed.reduce((sum, row) => sum + Number(row.duration), 0);
        if (road.meanObservedDurationSeconds !== (observed.length ? duration / observed.length : null) || road.meanTrafficWaitingSeconds !== mean(observed.map(row => Number(row.waitingTime))) || road.aggregateSpeedMetersPerSecond !== (duration ? observed.reduce((sum, row) => sum + Number(row.routeLength), 0) / duration : null)) throw new Error('road_statistics_mismatch');
      }
    }
  }
  return { result, ...published, events };
}
