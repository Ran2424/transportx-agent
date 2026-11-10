import { asRecord } from './common.ts';
import { parseMultimodalService, type MultimodalService, type MultimodalTraveler } from './simulation-multimodal.ts';

export const SIMULATION_MODULE_ID = 'com.transportx.traffic-simulation';
export const SIMULATION_CANVAS_ADAPTER_ID = 'com.transportx.traffic-simulation.canvas';
export type SimulationTraveler = { id: string; time: number; mode: 'bus' | 'ridehail'; destination: 'east' | 'west' };
export type SimulationServices = {
  busCapacity: number; boardingSeconds: number; transferSeconds: number; externalSeconds: number;
  departures: Array<{ id: string; time: number; vehicle: 'bus-0' }>;
  metro: Array<{ id: string; time: number; capacity: number }>;
  travelers: SimulationTraveler[];
};
export type SimulationConfiguration = {
  schemaVersion: 1; model: 'road' | 'evacuation' | 'multimodal'; networkVersion: string;
  serviceDate: string; timezone: 'Asia/Shanghai'; startTime: string;
  durationSeconds: number; seed: number; stepSeconds: 1; decisionSeconds: 1; sampleSeconds: 2; blockSeconds: 10;
  units: { time: 's'; distance: 'm'; speed: 'm/s' }; backgroundCount: number; service?: SimulationServices; coordination?: MultimodalService;
};
export type SimulationMapping = { version: 1; roadRoute: string[]; edges?: { hub: string; outbound: string; relay: string; inbound: string } };
export type TrafficScenario = {
  schemaVersion: 1; title: string;
  provenance: { kind: 'synthetic' | 'assumed' | 'observed' | 'operating-plan'; description: string; validDate: string; modelValidation: 'not_calibrated' };
  network: { path: string; version: string; mapping: SimulationMapping };
  configuration: SimulationConfiguration;
};
export type ScenarioVariant = { parentScenarioId: string; interventions: Array<'departures' | 'policy'> };
const integer = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const keys = (value: unknown, allowed: string[]) => { const record = asRecord(value); return !!record && Object.keys(record).every((key) => allowed.includes(key)); };
const sameKeys = (value: unknown, expected: string[]) => { const record = asRecord(value); return !!record && Object.keys(record).sort().join() === [...expected].sort().join(); };
const text = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const date = (value: unknown): value is string => text(value, 10) && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function parseSimulationConfiguration(input: unknown): SimulationConfiguration | null {
  const value = asRecord(input);
  if (!value || !keys(value, ['schemaVersion', 'model', 'networkVersion', 'serviceDate', 'timezone', 'startTime', 'durationSeconds', 'seed', 'stepSeconds', 'decisionSeconds', 'sampleSeconds', 'blockSeconds', 'units', 'backgroundCount', 'service', 'coordination'])) return null;
  if (value.schemaVersion !== 1 || !['road', 'evacuation', 'multimodal'].includes(String(value.model)) || !text(value.networkVersion, 160)) return null;
  if (!date(value.serviceDate) || value.timezone !== 'Asia/Shanghai' || typeof value.startTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value.startTime)) return null;
  if (!integer(value.durationSeconds, 1, 3600) || !integer(value.seed, 0, 2147483647) || !integer(value.backgroundCount, 0, 1000)) return null;
  if (value.stepSeconds !== 1 || value.decisionSeconds !== 1 || value.sampleSeconds !== 2 || value.blockSeconds !== 10) return null;
  const units = asRecord(value.units);
  if (!units || !sameKeys(units, ['time', 'distance', 'speed']) || units.time !== 's' || units.distance !== 'm' || units.speed !== 'm/s') return null;
  if ((value.model === 'evacuation') !== ('service' in value) || (value.model === 'multimodal') !== ('coordination' in value)) return null;
  if (value.model === 'multimodal' && !parseMultimodalService(value.coordination)) return null;
  if (value.model === 'evacuation') {
    const service = asRecord(value.service);
    if (!service || !sameKeys(service, ['busCapacity', 'boardingSeconds', 'transferSeconds', 'externalSeconds', 'departures', 'metro', 'travelers'])) return null;
    for (const key of ['busCapacity', 'boardingSeconds', 'transferSeconds', 'externalSeconds']) if (!integer(service[key], 1, 1000)) return null;
    const ids = new Set<string>();
    for (const [name, fields] of [['departures', ['id', 'time', 'vehicle']], ['metro', ['id', 'time', 'capacity']], ['travelers', ['id', 'time', 'mode', 'destination']]] as const) {
      const rows = service[name];
      if (!Array.isArray(rows) || !rows.length || rows.length > 1000) return null;
      for (const item of rows) {
        const row = asRecord(item);
        if (!row || !sameKeys(row, [...fields]) || !integer(row.time, 0, 7200) || !text(row.id, 160) || !/^[A-Za-z0-9-]+$/.test(row.id) || /^(bus-0|car-0|ridehail-first|road-\d+)$/.test(row.id) || ids.has(row.id)) return null;
        ids.add(row.id);
        if (name === 'departures' && row.vehicle !== 'bus-0' || name === 'metro' && !integer(row.capacity, 1, 1000)) return null;
        if (name === 'travelers' && !((row.mode === 'bus' && row.destination === 'east') || (row.mode === 'ridehail' && row.destination === 'west'))) return null;
      }
    }
  }
  return value as unknown as SimulationConfiguration;
}

export function parseTrafficScenario(input: unknown): TrafficScenario | null {
  const value = asRecord(input), network = asRecord(value?.network), provenance = asRecord(value?.provenance), mapping = asRecord(network?.mapping);
  if (!value || !sameKeys(value, ['schemaVersion', 'title', 'provenance', 'network', 'configuration']) || value.schemaVersion !== 1 || !text(value.title, 300)) return null;
  if (!provenance || !sameKeys(provenance, ['kind', 'description', 'validDate', 'modelValidation']) || !['synthetic', 'assumed', 'observed', 'operating-plan'].includes(String(provenance.kind)) || !text(provenance.description, 2000) || !date(provenance.validDate) || provenance.modelValidation !== 'not_calibrated') return null;
  const configuration = parseSimulationConfiguration(value.configuration);
  if (!configuration || provenance.validDate !== configuration.serviceDate || !network || !sameKeys(network, ['path', 'version', 'mapping']) || !text(network.path, 1000) || network.version !== configuration.networkVersion || !mapping || !keys(mapping, ['version', 'roadRoute', 'edges']) || mapping.version !== 1 || !Array.isArray(mapping.roadRoute) || mapping.roadRoute.length < 1 || mapping.roadRoute.length > 100 || mapping.roadRoute.some((id) => !text(id, 160))) return null;
  if (configuration.model === 'evacuation') {
    const edges = asRecord(mapping.edges);
    if (!edges || !sameKeys(edges, ['hub', 'outbound', 'relay', 'inbound']) || Object.values(edges).some((id) => !text(id, 160)) || new Set(Object.values(edges)).size !== 4) return null;
  } else if (mapping.edges !== undefined) return null;
  return value as unknown as TrafficScenario;
}

export type SimulationRunState = 'prepared' | 'running' | 'finalizing' | 'ended' | 'unknown';
export type SimulationCanvasPayload = { runId: string; scenarioId: string; sourceKind: TrafficScenario['provenance']['kind']; modelValidation: 'not_calibrated'; experimentId?: string };
export function parseSimulationCanvasPayload(value: unknown): SimulationCanvasPayload | null {
  const input = asRecord(value);
  if (!input || !keys(input, ['runId', 'scenarioId', 'sourceKind', 'modelValidation', 'experimentId']) || typeof input.runId !== 'string' || !/^sim_[a-f0-9]{32}$/.test(input.runId) || typeof input.scenarioId !== 'string' || !/^scenario_[a-f0-9]{32}$/.test(input.scenarioId) || !['synthetic', 'assumed', 'observed', 'operating-plan'].includes(String(input.sourceKind)) || input.modelValidation !== 'not_calibrated' || input.experimentId !== undefined && !/^experiment_[a-f0-9]{32}$/.test(String(input.experimentId))) return null;
  return input as SimulationCanvasPayload;
}
export function parseSimulationCanvasTarget(value: unknown): { time: number; objectId?: string } | null {
  const input = asRecord(value);
  if (!input || !keys(input, ['time', 'objectId']) || typeof input.time !== 'number' || !Number.isFinite(input.time) || input.time < 0 || input.time > 3600 || input.objectId !== undefined && !text(input.objectId, 160)) return null;
  return { time: input.time, ...(typeof input.objectId === 'string' ? { objectId: input.objectId } : {}) };
}

export type SimulationVehicleState = { edge: string; lane: string; edgeRole?: string | null; position: [number, number]; positionGeo?: [number, number]; lanePositionMeters?: number; speed: number; stopped: boolean };
export type SimulationTravelerState = (SimulationTraveler | MultimodalTraveler) & { state: string; location: string | null; ready?: number; hubDeparture?: number; completedAt?: number; waitSeconds?: number; metroBoardedAt?: number };
export type SimulationFleetState = { state: string; occupants: string[]; trip: string | null; ready?: number; route?: string | null; home?: string; capacity?: number; targetBerth?: number; observedTrips?: number; passengersBoarded?: number; busySeconds?: number; busyStart?: number; departureTime?: number; turnarounds?: number[] };
export type SimulationFrame = { time: number; generatedWallNs: number; vehicles: Record<string, SimulationVehicleState>; travelers?: Record<string, SimulationTravelerState>; fleet?: Record<string, SimulationFleetState> };
export type SimulationEvent = { sequence: number; time: number; type: string; objectId: string; nodeId?: string; routeId?: string; vehicle?: string | null; trip?: string | null; reason?: string; travelers?: string[]; service?: string; action?: string; observedTime?: number; queueCount?: number; longestWaitSeconds?: number };
export type SimulationFile = { path: string; bytes: number; sha256: string };
export type SimulationChunk = SimulationFile & { sequence: number; from: number; fromTime: number; toTime: number; availableTime: number; eventStart: number; eventCount: number; events: SimulationFile; publishedWallNs: number };
export type SimulationIndex = { protocol: 'transportx-simulation-index'; version: 1; runId: string; networkSha256: string; revision: number; availableTime: number; computedTime: number; final: boolean; chunks: SimulationChunk[] };
export type SimulationBlock = { protocol: 'transportx-simulation-block'; version: 1; runId: string; sequence: number; networkSha256: string; start: SimulationFrame; frames: SimulationFrame[]; eventStart: number; sampleSeconds: number; coordinateSystem: string };
export type SimulationMetrics = {
  road: { planned: number; inserted: number; arrived: number; activeOrUnfinished: number; pendingInsertion: string[]; notYetDue: string[]; peakActive: number; meanTimeLossSeconds?: number | null; timeLossVehicleSeconds?: number; observedVehicleSeconds?: number; meanObservedDurationSeconds?: number | null; meanTrafficWaitingSeconds?: number | null; aggregateSpeedMetersPerSecond?: number | null };
  service?: {
    totalTravelers: number; states: Record<string, number>; missedConnections: number; lastServiceMisses?: number; dispatchedTrips: number; unit: string; units?: Record<string, 'person' | 'trip' | 's' | 'person*s' | 'fraction'>; window: string; hubDepartures: number; completedJourneys: number; arrivedTravelers?: number; hubWaitPersonSeconds?: number; meanHubWaitSeconds?: number | null; fleetDefinition?: string;
    waiting?: { allWaitPersonSeconds: number; meanAllWaitSeconds: number | null; p90AllWaitSeconds: number | null; p90HubWaitSeconds: number | null; censoredPeople: number; definition: string };
    journeys?: { completedCount: number; arrivedCount: number; meanCompletedSeconds: number | null; p90CompletedSeconds: number | null; meanCensoredSeconds: number | null; p90CensoredSeconds: number | null; definition: string };
    byRoute?: Record<string, { totalTravelers: number; arrivedTravelers: number; states: Record<string, number>; completedJourneys: number; meanHubWaitSeconds: number | null; p90HubWaitSeconds: number | null; meanAllWaitSeconds: number | null; p90AllWaitSeconds: number | null }>;
    nodes?: Record<string, { waiting: number; walking: number; connecting: number; blocked: number; waitingCapacity: number }>;
    fleet?: Record<string, { capacity: number; observedTrips: number; passengersBoarded: number; busySeconds: number; busyFraction: number | null; loadFactor: number | null; completedTurnaroundSeconds: number[]; meanCompletedTurnaroundSeconds: number | null; censoredTurnaroundSeconds: number | null }>;
  };
};
export type SimulationComputeResult = {
  protocol: 'transportx-simulation-result'; version: 1; runId: string; jobSha256: string; networkSha256: string; durationSeconds: number;
  finalTime: number; termination: 'completed' | 'cancelled' | 'failed' | 'unknown'; failure: string | null; engineExited: boolean; engineExitCode: number | null;
  eventCount: number; producedEventCount: number; diagnostics: string[]; metrics: SimulationMetrics; files: SimulationFile[];
  timings: Record<string, number>; maxBufferedBlockBytes: number; writtenBlockBytes: number; pythonPeakTracedBytes: number;
  source: string; calibration: string;
};

export type SimulationGeometry = { type: 'FeatureCollection'; routes: Record<string, string[]>; features: Array<{ type: 'Feature'; id: string; properties: { edgeId?: string; nodeId?: string }; geometry: { type: 'LineString'; coordinates: [number, number][] } | { type: 'Point'; coordinates: [number, number] } }> };
export function parseSimulationGeometry(value: unknown): SimulationGeometry | null {
  const input = asRecord(value), routes = asRecord(input?.routes);
  if (!input || !sameKeys(input, ['type', 'routes', 'features']) || input.type !== 'FeatureCollection' || !routes || Object.keys(routes).length < 1 || Object.keys(routes).length > 9 || Object.entries(routes).some(([id, edges]) => !text(id, 160) || !Array.isArray(edges) || edges.length < 1 || edges.length > 100 || edges.some(edge => !text(edge, 160))) || !Array.isArray(input.features) || input.features.length < 1 || input.features.length > 5000) return null;
  const ids = new Set<string>(), edgeIds = new Set<string>();
  const point = (value: unknown) => Array.isArray(value) && value.length === 2 && value.every(n => typeof n === 'number' && Number.isFinite(n)) && value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90;
  for (const value of input.features) {
    const feature = asRecord(value), properties = asRecord(feature?.properties), geometry = asRecord(feature?.geometry);
    if (!feature || feature.type !== 'Feature' || !text(feature.id, 160) || ids.has(feature.id) || !properties || !keys(properties, ['edgeId', 'nodeId']) || !geometry) return null;
    ids.add(feature.id);
    if (geometry.type === 'Point') { if (properties.nodeId !== feature.id || properties.edgeId !== undefined || !point(geometry.coordinates)) return null; }
    else if (geometry.type === 'LineString') {
      if (properties.edgeId !== feature.id || properties.nodeId !== undefined || !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2 || geometry.coordinates.length > 10000 || geometry.coordinates.some(p => !point(p))) return null;
      edgeIds.add(feature.id);
    } else return null;
  }
  if (Object.values(routes).some(edges => (edges as string[]).some(id => !edgeIds.has(id)))) return null;
  return input as unknown as SimulationGeometry;
}
export type SimulationRunSummary = { runId: string; scenarioId: string; state: SimulationRunState; termination?: 'completed' | 'cancelled' | 'failed'; createdAt: string; updatedAt: string; latestComputedTime: number | null; availableFrameTime: number | null; sourceKind: TrafficScenario['provenance']['kind']; modelValidation: 'not_calibrated'; metrics?: SimulationMetrics; error?: { code: string; message: string }; cancellationRequested?: boolean; seed?: number; experimentId?: string; experimentSlot?: number };
export type SimulationExperiment = {
  experimentId: string; createdAt: string; baselineScenarioId: string; variantScenarioId: string; seeds: number[];
  totalRuns: number; totalSimulatedSeconds: number; maxOutputBytes: number;
  slots: Array<{ slot: number; seed: number; role: 'baseline' | 'variant'; scenarioId: string; run?: SimulationRunSummary }>;
  comparison: { plannedPairs: number; completePairs: number; conclusionAvailable: boolean; pairs: Array<{ seed: number; status: 'complete' | 'incomplete'; baselineRunId?: string; variantRunId?: string; delta?: { completedJourneys: number; meanHubWaitSeconds: number; meanRoadTimeLossSeconds: number; meanAllWaitSeconds?: number; p90AllWaitSeconds?: number; p90HubWaitSeconds?: number; meanCensoredJourneySeconds?: number; dispatchedTrips?: number; fleetBusyVehicleSeconds?: number; lastServiceMisses?: number } }> };
  artifact?: { manifestPath: string; manifestSha256: string; reportPath: string; reportSha256: string };
};
export type SimulationQuery = { runId: string; requestedTime: number; time: number; frameSequence: number; partial: boolean; units: SimulationConfiguration['units']; coordinateSystems: { position: 'sumo-network-xy'; positionGeo: 'WGS84-longitude-latitude-degrees' }; countsByState: Record<string, number>; vehicle?: SimulationVehicleState & { id: string }; fleet?: SimulationFleetState & { id: string }; traveler?: SimulationTravelerState; node?: { id: string; waiting: number; connecting: number; blocked?: number; walking?: number; waitingCapacity?: number; reservedBerths?: number }; route?: { id: string; edgeIds: string[]; vehicles: string[]; countsByState?: Record<string, number> }; events: SimulationEvent[]; truncated: boolean };
export type TrafficToolResult = { protocol: 'transportx-traffic'; version: 1; operation: 'prepare' | 'run' | 'execution' | 'query' | 'experiment'; scenario?: { scenarioId: string; title: string; provenance: TrafficScenario['provenance']; networkSha256: string; variant?: ScenarioVariant }; run?: SimulationRunSummary; query?: SimulationQuery; experiment?: SimulationExperiment };
export function parseTrafficToolResult(value: unknown): TrafficToolResult | null {
  const input = asRecord(value);
  if (!input || input.protocol !== 'transportx-traffic' || input.version !== 1 || !['prepare', 'run', 'execution', 'query', 'experiment'].includes(String(input.operation))) return null;
  if (input.operation === 'experiment') {
    const experiment = asRecord(input.experiment);
    if (!experiment || !/^experiment_[a-f0-9]{32}$/.test(String(experiment.experimentId)) || !Array.isArray(experiment.slots) || experiment.slots.length < 2 || experiment.slots.length > 6 || experiment.slots.some(value => { const slot = asRecord(value); return !slot || !integer(slot.slot, 0, 5) || !integer(slot.seed, 0, 2147483647) || !['baseline', 'variant'].includes(String(slot.role)) || !/^scenario_[a-f0-9]{32}$/.test(String(slot.scenarioId)) || slot.run !== undefined && !parseTrafficToolResult({ protocol: 'transportx-traffic', version: 1, operation: 'execution', run: slot.run }); })) return null;
    return input as unknown as TrafficToolResult;
  }
  const scenario = asRecord(input.scenario), run = asRecord(input.run), query = asRecord(input.query);
  if (input.operation === 'prepare' && (!scenario || typeof scenario.scenarioId !== 'string' || !/^scenario_[a-f0-9]{32}$/.test(scenario.scenarioId) || !text(scenario.title, 300) || !/^[a-f0-9]{64}$/.test(String(scenario.networkSha256)))) return null;
  if (input.operation !== 'prepare' && (!run || !parseSimulationCanvasPayload({ runId: run.runId, scenarioId: run.scenarioId, sourceKind: run.sourceKind, modelValidation: run.modelValidation }) || !['prepared', 'running', 'finalizing', 'ended', 'unknown'].includes(String(run.state)) || !text(run.createdAt, 64) || !Number.isFinite(Date.parse(run.createdAt)) || !text(run.updatedAt, 64) || !Number.isFinite(Date.parse(run.updatedAt)) || [run.latestComputedTime, run.availableFrameTime].some((time) => time !== null && !integer(time, 0, 3600)) || run.state === 'ended' && !['completed', 'cancelled', 'failed'].includes(String(run.termination)))) return null;
  const counts = asRecord(query?.countsByState);
  if (input.operation === 'query' && (!query || query.runId !== run?.runId || !integer(query.time, 0, 3600) || typeof query.requestedTime !== 'number' || !Number.isFinite(query.requestedTime) || query.requestedTime < (query.time as number) || !integer(query.frameSequence, 0, 359) || typeof query.partial !== 'boolean' || !counts || Object.values(counts).some((count) => !integer(count, 0, 1000)) || !Array.isArray(query.events) || query.events.length > 200 || query.events.some((event) => { const item = asRecord(event); return !item || !integer(item.sequence, 0, 1000000) || !integer(item.time, 0, query.time as number) || !text(item.objectId, 160) || !text(item.type, 160); }))) return null;
  return input as unknown as TrafficToolResult;
}
