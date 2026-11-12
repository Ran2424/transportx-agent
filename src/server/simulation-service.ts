import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseTrafficScenario, parseSimulationCanvasTarget, parseSimulationGeometry, SIMULATION_MODULE_ID, SIMULATION_CANVAS_ADAPTER_ID, type TrafficScenario, type SimulationRunSummary, type SimulationQuery, type SimulationNetworkView, type ScenarioVariant, type SimulationExperiment } from '../contracts/simulation.js';
import type { CanvasPresentationV1 } from '../contracts/canvas.js';
import type { GeoClientContextV1 } from '../contracts/geo.js';
import type { ResolvedSessionPlan } from './session-assembly.js';
import { PythonRunner } from './python-runner.js';
import type { Executable } from './runtime-resolver.js';
import { executionOwner, executionOwnerKey, type OwnerSession } from './util/execution-owner.js';
import { writeJsonAtomic } from './util/json-storage.js';
import { containedFile } from './util/resource-path.js';
import { workspaceMetadataPath } from './workspace-store.js';
import { sha256File } from './asset-integrity.js';
import { inspectProcess, inspectRecordedProcess, type ProcessIdentity } from './process-inspection.js';
import { createSimulationJob, readSimulationJson, readSimulationIndex, readSimulationChunk, verifySimulationResult, type SimulationJob, simulationDigest } from './simulation-job.js';

export type SimulationSession = OwnerSession & { id: string; workspaceId: string | null; resolvedSessionPlan: ResolvedSessionPlan | null };
type ScenarioRecord = { schemaVersion: 1; scenarioId: string; owner: string; moduleVersion: string; document: TrafficScenario; networkSha256: string; geometrySha256: string; variant?: ScenarioVariant; inputContextSha256?: string };
type RunRecord = SimulationRunSummary & { schemaVersion: 1; owner: string; workspaceId: string; toolCallId: string; moduleVersion: string; jobId?: string; jobSha256?: string; resultSha256?: string; processes?: ProcessIdentity[] };
type ExperimentRecord = Omit<SimulationExperiment, 'comparison' | 'artifact'> & { schemaVersion: 1; owner: string; workspaceId: string; moduleVersion: string };
type RunRequest = { scenarioId?: unknown; toolCallId?: unknown; operationId?: unknown; experimentId?: unknown; slot?: unknown };
const fail = (code: string, message: string, status = 409) => Object.assign(new Error(message), { code, status });
const now = () => new Date().toISOString();
const safeRelative = (value: unknown): string => {
  if (typeof value !== 'string' || !value.length || value.length > 1000 || path.isAbsolute(value) || value.split(/[\\/]/).some((part) => !part || part === '.' || part === '..' || part === '.tau')) throw fail('traffic_input_invalid', 'Use a relative scenario path within the selected data asset or workspace.', 400);
  return value;
};

/** Domain journal only: existing session Jobs own scheduling and managed processes. */
export class SimulationService {
  private runner: PythonRunner;
  private running = new Map<string, AbortController>();
  constructor(private options: { executable: Executable; root: string; sessionsDirectory: string; verifyPlan(plan: ResolvedSessionPlan, cwd: string): ResolvedSessionPlan; notify(session: SimulationSession, run: SimulationRunSummary, revision: number): void }) { this.runner = new PythonRunner(options.executable); }
  get activeCount() { return this.runner.activeCount; }
  terminateAll() { return this.runner.terminateAll(); }
  cleanupOwner(session: OwnerSession) {
    const owner = executionOwnerKey(executionOwner(session, this.options.sessionsDirectory));
    const directory = path.join(this.options.root, 'workspaces');
    if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = path.join(directory, name);
      if (readSimulationJson<{ owner: string }>(file).owner === owner) fs.rmSync(file);
    }
  }
  assertTransferAllowed(session: OwnerSession) {
    const directory = path.join(this.options.root, executionOwnerKey(executionOwner(session, this.options.sessionsDirectory)));
    if (fs.existsSync(directory) && fs.readdirSync(directory).some((name) => /^(scenario|sim)_[a-f0-9]{32}\.json$/.test(name))) throw fail('traffic_transfer_unsupported', 'Simulation inputs and Runs remain bound to this workspace. Conversation transfer with Simulation resources is not supported yet.');
  }
  private owner(session: SimulationSession) { return executionOwnerKey(executionOwner(session, this.options.sessionsDirectory)); }
  private plan(session: SimulationSession, verify = false) {
    if (!session.resolvedSessionPlan || !session.workspaceId) throw fail('traffic_module_unavailable', 'A frozen session plan and workspace identity are required.');
    const plan = verify ? this.options.verifyPlan(session.resolvedSessionPlan, session.cwd) : session.resolvedSessionPlan;
    const module = plan.modules.find((item) => item.id === SIMULATION_MODULE_ID);
    if (!module) throw fail('traffic_module_unavailable', 'Select Traffic Simulation for this conversation.');
    return { plan, module };
  }
  private directory(session: SimulationSession) { return path.join(this.options.root, this.owner(session)); }
  private file(session: SimulationSession, id: string) {
    if (!/^(sim|scenario|experiment)_[a-f0-9]{32}$/.test(id)) throw fail('traffic_reference_invalid', 'Invalid simulation reference.', 400);
    return path.join(this.directory(session), `${id}.json`);
  }
  private jobFile(session: SimulationSession, runId: string) { return this.file(session, runId).replace(/\.json$/, '.job.json'); }
  private load<T extends RunRecord | ScenarioRecord | ExperimentRecord>(session: SimulationSession, id: string): T {
    let record: T;
    try { record = readSimulationJson<T>(this.file(session, id)); } catch { throw fail('traffic_reference_unavailable', 'Simulation reference is unavailable to this conversation.', 404); }
    if (record.schemaVersion !== 1 || record.owner !== this.owner(session) || record.moduleVersion !== this.plan(session).module.version) throw fail('traffic_owner_mismatch', 'Simulation owner or frozen module version differs.');
    if ('workspaceId' in record && record.workspaceId !== session.workspaceId) throw fail('traffic_owner_mismatch', 'Run belongs to a different workspace.');
    return record;
  }
  private save(session: SimulationSession, record: RunRecord) { record.updatedAt = now(); writeJsonAtomic(this.file(session, record.runId), record); }
  private artifact(session: SimulationSession, kind: 'scenarios' | 'runs', id: string) { this.file(session, id); return workspaceMetadataPath(session.cwd, `traffic-simulation/${kind}/${id}`); }
  private pointer(workspaceId: string | null) { if (!workspaceId) throw fail('traffic_owner_mismatch', 'Workspace identity is required.'); return path.join(this.options.root, 'workspaces', `${simulationDigest(workspaceId)}.json`); }
  private release(record: RunRecord) {
    const pointer = this.pointer(record.workspaceId);
    if (fs.existsSync(pointer) && readSimulationJson<{ runId: string }>(pointer).runId === record.runId) fs.rmSync(pointer);
  }
  private assertStopped(root: string, record: RunRecord) {
    const started = readSimulationJson<{ pythonPid: number; sumoPid: number }>(containedFile(root, path.join(root, 'started.json')));
    for (const pid of [started.pythonPid, started.sumoPid]) {
      const identity = record.processes?.find((item) => item.pid === pid);
      const observation = identity ? inspectRecordedProcess(identity, this.options.executable.command) : inspectProcess(pid, this.options.executable.command);
      if (!['exited', 'replaced'].includes(observation.state)) throw fail('process_stop_unconfirmed', 'Recorded Python or SUMO process exit is unconfirmed.', 503);
    }
  }
  private summary(record: RunRecord): SimulationRunSummary {
    const { schemaVersion: _schema, owner: _owner, workspaceId: _workspace, toolCallId: _call, moduleVersion: _module, jobId: _jobId, jobSha256: _job, resultSha256: _result, processes: _processes, ...summary } = record;
    return summary;
  }
  async prepareScenario(session: SimulationSession, body: { inputPath?: unknown; assetId?: unknown; parentScenarioId?: unknown; interventions?: unknown }, signal?: AbortSignal, inputContext?: GeoClientContextV1) {
    const { plan, module } = this.plan(session, true);
    const asset = body.assetId === undefined ? undefined : plan.assets.find((item) => item.id === body.assetId && item.kind === 'data' && item.integrityStatus === 'verified');
    if (body.assetId !== undefined && !asset) throw fail('traffic_asset_unavailable', 'Select a verified data asset in this conversation.');
    const root = asset?.path || session.cwd;
    const source = containedFile(root, workspaceMetadataPath(root, safeRelative(body.inputPath)));
    if (fs.statSync(source).size > 256 * 1024) throw fail('traffic_input_budget', 'Scenario exceeds 256 KiB.');
    const document = parseTrafficScenario(readSimulationJson(source));
    if (!document) throw fail('traffic_input_invalid', 'Invalid scenario, units, service date or mapping.', 400);
    const config = document.configuration;
    if (config.durationSeconds > 600 || config.backgroundCount > 120 || (config.service?.travelers.length || config.coordination?.travelers.length || 0) > 100) throw fail('traffic_input_budget', 'Measured profile allows at most 600 seconds, 120 background vehicles and 100 travelers.');
    if (config.coordination && [config.coordination.nodes.length, config.coordination.routes.length, config.coordination.fleet.length].some(count => count > 4)) throw fail('traffic_input_budget', 'The current multimodal profile supports at most four nodes, four routes and four fleet vehicles.');
    const network = containedFile(root, workspaceMetadataPath(root, path.relative(root, path.resolve(path.dirname(source), safeRelative(document.network.path)))));
    if (fs.statSync(network).size > 2 * 1024 * 1024) throw fail('traffic_input_budget', 'Network exceeds 2 MiB.');
    const networkSha256 = sha256File(network);
    let variant: ScenarioVariant | undefined;
    if (body.parentScenarioId !== undefined) {
      if (typeof body.parentScenarioId !== 'string' || !Array.isArray(body.interventions) || !body.interventions.length || body.interventions.length > 2 || new Set(body.interventions).size !== body.interventions.length || body.interventions.some(field => !['departures', 'policy', 'railTimetable'].includes(field)) || body.interventions.includes('railTimetable') && body.interventions.length !== 1) throw fail('traffic_variant_invalid', 'Declare the parent and exact changed service fields.', 400);
      const parent = this.scenario(session, body.parentScenarioId);
      if (parent.inputContextSha256) {
        const frozen = readSimulationJson<GeoClientContextV1>(path.join(this.artifact(session, 'scenarios', parent.scenarioId), 'input-context.json'));
        if (inputContext && !isDeepStrictEqual(inputContext, frozen)) throw fail('traffic_variant_incomparable', 'Variant Geo selection must equal its frozen parent.');
        inputContext = frozen;
      } else if (inputContext) throw fail('traffic_variant_incomparable', 'Do not add a different selection to a variant.');
      const expected = structuredClone(parent.document.configuration), actual = structuredClone(config);
      if (expected.model !== 'multimodal' || actual.model !== 'multimodal' || networkSha256 !== parent.networkSha256 || !isDeepStrictEqual(document.network.mapping, parent.document.network.mapping) || !isDeepStrictEqual(document.provenance, parent.document.provenance)) throw fail('traffic_variant_incomparable', 'Variants require the same frozen network, demand source and model.');
      for (const field of body.interventions as ScenarioVariant['interventions']) {
        if (field === 'railTimetable') {
          if (!expected.rail || !actual.rail || expected.rail.stops.length !== actual.rail.stops.length) throw fail('traffic_variant_incomparable', 'Choose the same physical metro service.');
          if (isDeepStrictEqual(expected.rail, actual.rail)) throw fail('traffic_variant_unchanged', 'Adjust a timetable value.');
          actual.rail.insertTime = expected.rail.insertTime;
          for (const [i, stop] of actual.rail.stops.entries()) {
            const { arrival, departure, minDwell } = expected.rail.stops[i];
            Object.assign(stop, { arrival, departure, minDwell });
          }
          actual.coordination!.metro[0].time = expected.coordination!.metro[0].time;
          continue;
        }
        if (isDeepStrictEqual(actual.coordination![field], expected.coordination![field])) throw fail('traffic_variant_unchanged', 'Each declared intervention must change its named input.');
        Object.assign(actual.coordination!, { [field]: expected.coordination![field] });
      }
      if (!isDeepStrictEqual(expected, actual)) throw fail('traffic_variant_incomparable', 'Demand, fleet, nodes, routes, dates, units and other common conditions must remain identical.');
      variant = { parentScenarioId: body.parentScenarioId, interventions: body.interventions as ScenarioVariant['interventions'] };
    } else if (body.interventions !== undefined) throw fail('traffic_variant_invalid', 'Interventions require a frozen parent.', 400);
    if (inputContext && !['viewport', 'rectangle'].includes(inputContext.mode)) throw fail('traffic_selection_unsupported', 'Use an existing viewport or rectangular Geo context for the synthetic service area.', 400);
    const inputContextSha256 = inputContext ? simulationDigest(JSON.stringify(inputContext)) : undefined;
    const scenarioId = `scenario_${simulationDigest(JSON.stringify([this.owner(session), module.version, document, networkSha256, ...(variant ? [variant] : []), ...(inputContextSha256 ? [inputContextSha256] : [])])).slice(0, 32)}`;
    if (fs.existsSync(this.file(session, scenarioId))) { const record = this.scenario(session, scenarioId); return this.scenarioSummary(record); }
    const runtime = module.nativeRuntimes.find((item) => item.kind === 'sumo');
    if (!runtime || runtime.kind !== 'sumo') throw fail('traffic_runtime_unavailable', 'No approved SUMO runtime matches this platform.');
    const output = this.artifact(session, 'scenarios', scenarioId);
    if (fs.existsSync(output)) throw fail('traffic_preparation_interrupted', 'Uncommitted preparation exists. Inspect its files before retrying.');
    fs.mkdirSync(output, { recursive: true });
    const frozenNetwork = path.join(output, 'network.net.xml'); fs.copyFileSync(network, frozenNetwork);
    writeJsonAtomic(path.join(output, 'scenario.json'), document);
    try {
      const coordination = config.coordination;
      const input = coordination ? { nodes: coordination.nodes, routes: coordination.routes, ...(config.rail ? { rail: config.rail, durationSeconds: config.durationSeconds, fleet: coordination.fleet, metro: coordination.metro } : {}) } : null;
      const { stdout } = await this.runner.run(containedFile(module.packageRoot, path.join(module.packageRoot, 'scripts/inspect_network.py')), [frozenNetwork, JSON.stringify(document.network.mapping), config.model, path.join(output, 'geometry.json'), JSON.stringify(input)], { cwd: session.cwd, signal, envMode: 'replace', env: { PYTHONPATH: runtime.pythonPath }, timeoutMs: 120_000, maxBuffer: 32 * 1024 });
      const inspected = JSON.parse(stdout);
      if (inspected.protocol !== 'transportx-network-inspection' || inspected.networkSha256 !== networkSha256 || sha256File(network) !== networkSha256 || sha256File(frozenNetwork) !== networkSha256 || inspected.geometry?.sha256 !== sha256File(path.join(output, 'geometry.json'))) throw fail('traffic_preparation_changed', 'Network changed during preparation.');
      const geometry = parseSimulationGeometry(readSimulationJson(path.join(output, 'geometry.json')));
      if (!geometry || !isDeepStrictEqual(geometry.routes['route:road'], document.network.mapping.roadRoute)) throw fail('traffic_geometry_invalid', 'Prepared geometry or route mappings are invalid.');
      if (config.coordination) {
        const nodeIds = [...config.coordination.nodes.map(node => node.id), ...(config.rail?.stops.map(stop => stop.platformId) ?? [])].sort();
        const routeIds = ['route:road', ...config.coordination.routes.map(route => route.id), ...(config.rail ? [config.rail.lineId] : [])].sort();
        if (!isDeepStrictEqual(geometry.features.filter(feature => feature.properties.nodeId).map(feature => feature.id).sort(), nodeIds)
            || !isDeepStrictEqual(Object.keys(geometry.routes).sort(), routeIds)
            || config.rail && !isDeepStrictEqual(geometry.routes[config.rail.lineId], config.rail.edges)) {
          throw fail('traffic_model_unsupported', 'This module did not prepare the declared service nodes and routes.');
        }
      }
      this.plan(session, true);
      if (inputContext) {
        const corners = inputContext.geometry?.type === 'Polygon' ? inputContext.geometry.coordinates[0] : undefined;
        const bounds = corners ? [Math.min(...corners.map(p => p[0])), Math.min(...corners.map(p => p[1])), Math.max(...corners.map(p => p[0])), Math.max(...corners.map(p => p[1]))] : inputContext.view.bounds;
        if (geometry.features.filter(feature => feature.properties.nodeId).some(feature => feature.geometry.type === 'Point' && (feature.geometry.coordinates[0] < bounds[0] || feature.geometry.coordinates[0] > bounds[2] || feature.geometry.coordinates[1] < bounds[1] || feature.geometry.coordinates[1] > bounds[3]))) throw fail('traffic_selection_outside', 'A declared service node lies outside the frozen Geo selection.', 400);
        writeJsonAtomic(path.join(output, 'input-context.json'), inputContext);
      }
      const record: ScenarioRecord = { schemaVersion: 1, scenarioId, owner: this.owner(session), moduleVersion: module.version, document, networkSha256, geometrySha256: inspected.geometry.sha256, ...(variant ? { variant } : {}), ...(inputContextSha256 ? { inputContextSha256 } : {}) };
      writeJsonAtomic(this.file(session, scenarioId), record);
      return this.scenarioSummary(record);
    } catch (error) { fs.rmSync(output, { recursive: true, force: true }); throw error; }
  }
  private scenarioSummary(record: ScenarioRecord) { return { scenarioId: record.scenarioId, title: record.document.title, provenance: record.document.provenance, networkSha256: record.networkSha256, ...(record.variant ? { variant: record.variant } : {}) }; }
  private scenario(session: SimulationSession, id: string) {
    const record = this.load<ScenarioRecord>(session, id), root = this.artifact(session, 'scenarios', id);
    for (const [name, expected] of [['network.net.xml', record.networkSha256], ['geometry.json', record.geometrySha256]]) {
      if (sha256File(containedFile(root, workspaceMetadataPath(root, name))) !== expected) throw fail('traffic_scenario_changed', 'Frozen scenario input changed.');
    }
    if (!parseSimulationGeometry(readSimulationJson(path.join(root, 'geometry.json')))) throw fail('traffic_geometry_invalid', 'Frozen geometry or route mappings are invalid; prepare a new scenario with the corrected module.');
    if (JSON.stringify(readSimulationJson(containedFile(root, path.join(root, 'scenario.json')))) !== JSON.stringify(record.document)) throw fail('traffic_scenario_changed', 'Frozen scenario document changed.');
    if (record.inputContextSha256 && simulationDigest(JSON.stringify(readSimulationJson(containedFile(root, path.join(root, 'input-context.json'))))) !== record.inputContextSha256) throw fail('traffic_scenario_changed', 'Frozen Geo context changed.');
    return record;
  }
  prepareExperiment(session: SimulationSession, body: { baselineScenarioId?: unknown; variantScenarioId?: unknown; seeds?: unknown }): SimulationExperiment {
    const baseline = this.scenario(session, String(body.baselineScenarioId)), variant = this.scenario(session, String(body.variantScenarioId));
    this.plan(session, true);
    if (variant.variant?.parentScenarioId !== baseline.scenarioId || baseline.document.configuration.model !== 'multimodal') throw fail('traffic_experiment_incomparable', 'Select a frozen baseline and its declared multimodal variant.');
    if (!Array.isArray(body.seeds) || !body.seeds.length || body.seeds.length > 3 || new Set(body.seeds).size !== body.seeds.length || body.seeds.some(seed => typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 2147483647)) throw fail('traffic_experiment_budget', 'Choose one to three distinct integer seeds.', 400);
    const seeds = body.seeds as number[], totalRuns = seeds.length * 2, totalSimulatedSeconds = seeds.length * (baseline.document.configuration.durationSeconds + variant.document.configuration.durationSeconds);
    if (totalSimulatedSeconds > 3600) throw fail('traffic_experiment_budget', 'The complete experiment exceeds 3600 simulated seconds.', 400);
    const experimentId = `experiment_${simulationDigest(JSON.stringify([this.owner(session), baseline.scenarioId, variant.scenarioId, seeds])).slice(0, 32)}`;
    if (!fs.existsSync(this.file(session, experimentId))) {
      const record: ExperimentRecord = { schemaVersion: 1, owner: this.owner(session), moduleVersion: baseline.moduleVersion, workspaceId: session.workspaceId!, experimentId, createdAt: now(), baselineScenarioId: baseline.scenarioId, variantScenarioId: variant.scenarioId, seeds, totalRuns, totalSimulatedSeconds, maxOutputBytes: totalRuns * 64 * 1024 * 1024,
        slots: seeds.flatMap((seed, pair) => [{ slot: pair * 2, seed, role: 'baseline' as const, scenarioId: baseline.scenarioId }, { slot: pair * 2 + 1, seed, role: 'variant' as const, scenarioId: variant.scenarioId }]) };
      writeJsonAtomic(this.file(session, experimentId), record);
    }
    return this.experiment(session, experimentId);
  }
  experiment(session: SimulationSession, experimentId: string, materialize = true): SimulationExperiment {
    const record = this.load<ExperimentRecord>(session, experimentId), baseline = this.scenario(session, record.baselineScenarioId), variant = this.scenario(session, record.variantScenarioId);
    const runs = this.list(session), slots = record.slots.map(slot => ({ ...slot, ...(runs.find(run => run.experimentId === experimentId && run.experimentSlot === slot.slot) ? { run: runs.find(run => run.experimentId === experimentId && run.experimentSlot === slot.slot)! } : {}) }));
    const pairs: SimulationExperiment['comparison']['pairs'] = record.seeds.map((seed, i) => {
      const base = slots[i * 2].run, changed = slots[i * 2 + 1].run;
      const pair = { seed, ...(base ? { baselineRunId: base.runId } : {}), ...(changed ? { variantRunId: changed.runId } : {}) };
      if (base?.termination !== 'completed' || changed?.termination !== 'completed' || base.state !== 'ended' || changed.state !== 'ended') return { ...pair, status: 'incomplete' };
      const a = base.metrics!, b = changed.metrics!;
      if (typeof a.service?.meanHubWaitSeconds !== 'number' || typeof b.service?.meanHubWaitSeconds !== 'number' || typeof a.road.meanTimeLossSeconds !== 'number' || typeof b.road.meanTimeLossSeconds !== 'number') throw fail('traffic_experiment_metrics_missing', 'Paired metrics are unavailable; no benefit conclusion is permitted.');
      if (!!a.service.waiting !== !!b.service.waiting) throw fail('traffic_experiment_metrics_missing', 'Metric definitions differ across the pair.');
      const waiting = a.service.waiting && b.service.waiting ? { meanAllWaitSeconds: b.service.waiting.meanAllWaitSeconds! - a.service.waiting.meanAllWaitSeconds!, p90AllWaitSeconds: b.service.waiting.p90AllWaitSeconds! - a.service.waiting.p90AllWaitSeconds!, p90HubWaitSeconds: b.service.waiting.p90HubWaitSeconds! - a.service.waiting.p90HubWaitSeconds!, meanCensoredJourneySeconds: b.service.journeys!.meanCensoredSeconds! - a.service.journeys!.meanCensoredSeconds!, dispatchedTrips: b.service.dispatchedTrips - a.service.dispatchedTrips, fleetBusyVehicleSeconds: Object.values(b.service.fleet!).reduce((sum, v) => sum + v.busySeconds, 0) - Object.values(a.service.fleet!).reduce((sum, v) => sum + v.busySeconds, 0) } : {};
      return { ...pair, status: 'complete', delta: { completedJourneys: b.service.completedJourneys - a.service.completedJourneys, meanHubWaitSeconds: b.service.meanHubWaitSeconds - a.service.meanHubWaitSeconds, meanRoadTimeLossSeconds: b.road.meanTimeLossSeconds - a.road.meanTimeLossSeconds, ...waiting, ...(a.service.lastServiceMisses === undefined || b.service.lastServiceMisses === undefined ? {} : { lastServiceMisses: b.service.lastServiceMisses - a.service.lastServiceMisses }) } };
    });
    const completePairs = pairs.filter(pair => pair.status === 'complete').length;
    const value: SimulationExperiment = { experimentId, createdAt: record.createdAt, baselineScenarioId: record.baselineScenarioId, variantScenarioId: record.variantScenarioId, seeds: record.seeds, totalRuns: record.totalRuns, totalSimulatedSeconds: record.totalSimulatedSeconds, maxOutputBytes: record.maxOutputBytes, slots, comparison: { plannedPairs: pairs.length, completePairs, conclusionAvailable: completePairs === pairs.length, pairs } };
    // Immutable snapshots retain incomplete/unknown samples and exact Run references.
    const bindings = slots.map(slot => {
      if (!slot.run) return { slot: slot.slot, status: 'not_dispatched' };
      const run = this.load<RunRecord>(session, slot.run.runId);
      const jobFile = this.jobFile(session, run.runId);
      const job = run.jobSha256 && fs.existsSync(jobFile) && sha256File(jobFile) === run.jobSha256 ? readSimulationJson<SimulationJob>(jobFile) : undefined;
      return { slot: slot.slot, runId: run.runId, jobSha256: run.jobSha256, resultSha256: run.resultSha256, implementation: job?.implementation, resultPath: `traffic-simulation/runs/${run.runId}/result.json`, networkSha256: job?.network.sha256 };
    });
    const inputContext = baseline.inputContextSha256 ? readSimulationJson<GeoClientContextV1>(path.join(this.artifact(session, 'scenarios', baseline.scenarioId), 'input-context.json')) : undefined;
    const native = this.plan(session).module.nativeRuntimes.find(runtime => runtime.kind === 'sumo');
    const runtimeIdentity = native?.kind === 'sumo' ? { engine: 'SUMO', version: native.version, platform: native.platform, arch: native.arch, sumoSha256: native.sumo.sha256, packageIntegritySha256: native.integrityFile.sha256, pythonVersion: session.resolvedSessionPlan?.runtime.pythonVersion } : undefined;
    const snapshot = { protocol: 'transportx-simulation-comparison', version: 1, analysisVersion: 'traffic-comparison-v2', ...value, source: baseline.document.provenance, modelValidation: 'not_calibrated', moduleVersion: record.moduleVersion, runtime: runtimeIdentity, interventions: variant.variant, inputContext, inputContextSha256: baseline.inputContextSha256, networkSha256: baseline.networkSha256, bindings, units: { completedJourneys: 'person', meanHubWaitSeconds: 's', meanAllWaitSeconds: 's', p90AllWaitSeconds: 's', meanCensoredJourneySeconds: 's', meanRoadTimeLossSeconds: 's', lastServiceMisses: 'person', dispatchedTrips: 'trip', fleetBusyVehicleSeconds: 'vehicle*s' }, difference: 'variant minus baseline; no real-world causal claim', denominator: 'hub wait includes all arrivals through finalTime, censored when not departed; road time loss includes all inserted vehicles, unfinished retained and pending insertion separately reported', conditions: baseline.document.configuration, variants: variant.document.configuration };
    const bytes = JSON.stringify(snapshot, null, 2) + '\n', hash = simulationDigest(bytes);
    const relative = `traffic-simulation/experiments/${experimentId}`, directory = workspaceMetadataPath(session.cwd, relative);
    const manifestPath = `${relative}/comparison-${hash}.json`, reportPath = `${relative}/report-${hash}.md`;
    if (!materialize && (!fs.existsSync(workspaceMetadataPath(session.cwd, manifestPath)) || !fs.existsSync(workspaceMetadataPath(session.cwd, reportPath)))) return value;
    if (materialize) fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(workspaceMetadataPath(session.cwd, manifestPath))) fs.writeFileSync(workspaceMetadataPath(session.cwd, manifestPath), bytes);
    if (sha256File(workspaceMetadataPath(session.cwd, manifestPath)) !== hash) throw fail('traffic_comparison_changed', 'Existing comparison snapshot changed.');
    const lines = [`# 合成交通实验比较`, ``, `实验：${experimentId}；来源：${baseline.document.provenance.kind}；未校准，不用于推断真实虹桥收益。`, ``, `完整配对 ${completePairs}/${pairs.length}；计划 ${record.totalRuns} 个 Run、${record.totalSimulatedSeconds} 仿真秒。${completePairs === pairs.length ? '以下为相同种子的合成差值。' : '存在未完成样本，禁止给出正常收益结论；不自动补跑。'}`, ``, `差值为变体减基线。枢纽候车均值包含所有已到达旅客，未离站者截于末时刻；道路损失包括所有实际插入车辆，未完成和待插入数量见清单。`, ``, `| 种子 | 状态 | 完成全链差值（人） | 枢纽候车均值差值（秒） | 道路损失均值差值（秒） |`, `| --- | --- | --- | --- | --- |`, ...pairs.map(pair => `| ${pair.seed} | ${pair.status} | ${pair.delta?.completedJourneys ?? '—'} | ${pair.delta?.meanHubWaitSeconds.toFixed(3) ?? '—'} | ${pair.delta?.meanRoadTimeLossSeconds.toFixed(3) ?? '—'} |`), ``, `## Run 与证据`, ``, ...slots.map(slot => `- ${slot.role}, seed=${slot.seed}: ${slot.run ? `${slot.run.runId}，${slot.run.state}/${slot.run.termination || 'unconfirmed'}，场景 ${slot.scenarioId}` : `尚未派发，场景 ${slot.scenarioId}`}`), ``, `冻结比较清单：[comparison-${hash}.json](./comparison-${hash}.json)，SHA-256 ${hash}。配置、指标分母、全部状态与未完成样本以此清单为准。`, ``];
    if (pairs.some(pair => pair.delta?.meanAllWaitSeconds !== undefined)) lines.push('', '## 等待、出行及资源差值', '', '全程等待含枢纽与接续候车、上游受阻及登乘，排除步行和在途；未完成者计入已发生等待。P90 使用最近秩。截尾出行耗时保留全部到达者，不是完整出行时间预测。车队占用为预留登乘至实际返场可用的车秒，未返场者截于终点。', '', '| 种子 | 全程等待均值差（s） | 全程等待 P90 差（s） | 截尾出行均值差（s） | 错过末班差（人） | 实际趟次差 | 车队占用差（车秒） |', '| --- | --- | --- | --- | --- | --- | --- |', ...pairs.map(pair => `| ${pair.seed} | ${pair.delta?.meanAllWaitSeconds?.toFixed(3) ?? '—'} | ${pair.delta?.p90AllWaitSeconds?.toFixed(3) ?? '—'} | ${pair.delta?.meanCensoredJourneySeconds?.toFixed(3) ?? '—'} | ${pair.delta?.lastServiceMisses ?? '—'} | ${pair.delta?.dispatchedTrips ?? '—'} | ${pair.delta?.fleetBusyVehicleSeconds ?? '—'} |`), '', '分线路/方向/方式、节点积压、条件于完成者的耗时及每车周转/载客率详见冻结清单各 Run.metrics。道路 timeLoss 与 traffic waiting 排除计划停站；运行时长及总距离/总时长包含计划停站，不能直接作为纯道路拥堵程度。', '');
    lines.push('[SUMO TripInfo 指标定义](https://sumo.dlr.de/docs/Simulation/Output/TripInfo.html)', '');
    const report = lines.join('\n');
    if (!fs.existsSync(workspaceMetadataPath(session.cwd, reportPath))) fs.writeFileSync(workspaceMetadataPath(session.cwd, reportPath), report);
    if (sha256File(workspaceMetadataPath(session.cwd, reportPath)) !== simulationDigest(report)) throw fail('traffic_comparison_changed', 'Existing report snapshot changed.');
    value.artifact = { manifestPath, manifestSha256: hash, reportPath, reportSha256: simulationDigest(report) };
    return value;
  }
  prepareRun(session: SimulationSession, body: RunRequest) {
    let experiment: ExperimentRecord | undefined, slot: ExperimentRecord['slots'][number] | undefined;
    if (body.experimentId !== undefined) {
      if (typeof body.experimentId !== 'string' || !Number.isInteger(body.slot) || body.scenarioId !== undefined) throw fail('traffic_experiment_slot_invalid', 'Supply one experiment and its next slot.', 400);
      experiment = this.load<ExperimentRecord>(session, body.experimentId);
      slot = experiment.slots.find(slot => slot.slot === body.slot);
      if (!slot) throw fail('traffic_experiment_slot_invalid', 'Slot is outside the frozen experiment.', 400);
      const runs = this.list(session);
      const existing = runs.find(run => run.experimentId === experiment!.experimentId && run.experimentSlot === slot!.slot);
      if (existing && body.operationId !== undefined && body.operationId !== existing.runId) throw fail('traffic_run_conflict', 'Operation ID differs from the Run already bound to this slot.');
      if (existing && this.load<RunRecord>(session, existing.runId).toolCallId !== body.toolCallId) throw fail('traffic_experiment_slot_exists', `This slot already owns ${existing.runId}; query that Run instead of dispatching it again.`);
      if (experiment.slots.some(prior => prior.slot < slot!.slot && !runs.some(run => run.experimentId === experiment!.experimentId && run.experimentSlot === prior.slot && run.state === 'ended'))) throw fail('traffic_experiment_sequence', 'Confirm every preceding slot before executing this slot.');
      body = { ...body, scenarioId: slot.scenarioId, ...(existing ? { operationId: existing.runId } : {}) };
    } else if (body.slot !== undefined) throw fail('traffic_experiment_slot_invalid', 'Slot requires an experiment.', 400);
    const scenario = this.scenario(session, String(body.scenarioId)); this.plan(session, true);
    if (typeof body.toolCallId !== 'string' || !body.toolCallId.length || body.toolCallId.length > 200) throw fail('traffic_call_invalid', 'A bounded Pi toolCallId is required.', 400);
    const call = path.join(this.directory(session), `call_${simulationDigest(body.toolCallId)}.json`);
    if (body.operationId || fs.existsSync(call)) {
      const runId = String(body.operationId || readSimulationJson<{ runId: string }>(call).runId);
      const record = this.load<RunRecord>(session, runId);
      if (record.scenarioId !== scenario.scenarioId || record.toolCallId !== body.toolCallId || record.experimentId !== experiment?.experimentId || record.experimentSlot !== slot?.slot) throw fail('traffic_run_conflict', 'This Run is associated with different inputs or a different tool call.');
      return this.summary(this.reconcile(session, record));
    }
    const pointer = this.pointer(session.workspaceId);
    if (fs.existsSync(pointer)) throw fail('traffic_workspace_busy', 'An unfinished or unconfirmed Run owns this workspace. Query it before starting another.');
    const runId = `sim_${crypto.randomBytes(16).toString('hex')}`, timestamp = now();
    const record: RunRecord = { schemaVersion: 1, runId, scenarioId: scenario.scenarioId, owner: this.owner(session), workspaceId: session.workspaceId!, toolCallId: body.toolCallId, moduleVersion: scenario.moduleVersion, state: 'prepared', createdAt: timestamp, updatedAt: timestamp, latestComputedTime: null, availableFrameTime: null, sourceKind: scenario.document.provenance.kind, modelValidation: 'not_calibrated', ...(experiment && slot ? { experimentId: experiment.experimentId, experimentSlot: slot.slot, seed: slot.seed } : {}) };
    this.save(session, record);
    writeJsonAtomic(pointer, { owner: record.owner, runId });
    writeJsonAtomic(call, { runId });
    this.options.notify(session, this.summary(record), 0);
    return this.summary(record);
  }
  private reconcile(session: SimulationSession, record: RunRecord) {
    if (record.state === 'prepared' || record.termination === 'cancelled' || this.running.has(record.runId)) return record;
    const root = this.artifact(session, 'runs', record.runId);
    try {
      const jobFile = this.jobFile(session, record.runId), job = readSimulationJson<SimulationJob>(jobFile);
      if (!record.jobSha256 || sha256File(jobFile) !== record.jobSha256) throw new Error('job_integrity');
      if (record.resultSha256 && sha256File(path.join(root, 'result.json')) !== record.resultSha256) throw new Error('committed_result_changed');
      const { result } = verifySimulationResult(root, job, record.jobSha256);
      this.assertStopped(root, record);
      if (record.state === 'ended' && record.termination === 'completed' && record.resultSha256) return record;
      record.resultSha256 = sha256File(path.join(root, 'result.json'));
      record.state = 'ended'; record.termination = 'completed'; record.metrics = result.metrics; record.latestComputedTime = result.finalTime; record.availableFrameTime = result.finalTime; delete record.error;
      this.save(session, record); this.release(record);
    } catch {
      record.state = 'unknown'; delete record.termination; delete record.metrics; record.error ||= { code: 'traffic_result_unknown', message: 'No final commit is confirmed. Preserve this Run and query it; do not dispatch a replacement automatically.' }; this.save(session, record);
      if (!fs.existsSync(this.pointer(record.workspaceId))) writeJsonAtomic(this.pointer(record.workspaceId), { owner: record.owner, runId: record.runId });
    }
    return record;
  }
  queryExecution(session: SimulationSession, reference: { runId?: unknown; lookupToolCallId?: unknown }) {
    if (!!reference.runId === !!reference.lookupToolCallId) throw fail('traffic_reference_invalid', 'Supply one runId or lookupToolCallId.', 400);
    const runId = reference.runId || (typeof reference.lookupToolCallId === 'string' && reference.lookupToolCallId.length <= 200 ? readSimulationJson<{ runId: string }>(path.join(this.directory(session), `call_${simulationDigest(reference.lookupToolCallId)}.json`)).runId : '');
    return this.summary(this.reconcile(session, this.load<RunRecord>(session, String(runId))));
  }
  bindJob(session: SimulationSession, runId: string, jobId: string) {
    const record = this.load<RunRecord>(session, runId);
    if (record.state !== 'prepared' || record.jobId && record.jobId !== jobId) throw fail('traffic_job_conflict', 'Run is already associated with another Job.');
    record.jobId = jobId; this.save(session, record);
  }
  cancel(session: SimulationSession, reference: { runId?: unknown; lookupToolCallId?: unknown }) {
    const summary = this.queryExecution(session, reference), record = this.load<RunRecord>(session, summary.runId);
    if (record.state === 'prepared') { record.state = 'ended'; record.termination = 'cancelled'; this.save(session, record); this.release(record); }
    const controller = this.running.get(record.runId);
    if (controller) { record.cancellationRequested = true; this.save(session, record); controller.abort(); }
    else if (record.state === 'unknown') {
      record.cancellationRequested = true;
      try { this.assertStopped(this.artifact(session, 'runs', record.runId), record); record.state = 'ended'; record.termination = 'cancelled'; }
      catch { /* Existing workspace process recovery must confirm a still-live or unobserved process. */ }
      this.save(session, record);
      if (record.state === 'ended') this.release(record);
    }
    return this.summary(record);
  }
  async run(session: SimulationSession, body: RunRequest, signal: AbortSignal) {
    const summary = this.prepareRun(session, body), record = this.load<RunRecord>(session, summary.runId);
    if (record.state !== 'prepared') return summary;
    const scenario = this.scenario(session, record.scenarioId), { module } = this.plan(session, true);
    const runtime = module.nativeRuntimes.find((item) => item.kind === 'sumo');
    if (!runtime || runtime.kind !== 'sumo') throw fail('traffic_runtime_unavailable', 'Approved SUMO runtime is unavailable.');
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
    const root = this.artifact(session, 'runs', record.runId);
    fs.mkdirSync(root, { recursive: true });
    const job = createSimulationJob({ ...scenario.document.configuration, ...(record.seed === undefined ? {} : { seed: record.seed }) }, { network: path.join(this.artifact(session, 'scenarios', record.scenarioId), 'network.net.xml'), inputRoot: session.cwd, outputRoot: root, sumo: runtime.sumo.path, projData: runtime.projData, runId: record.runId, implementationRoot: path.join(module.packageRoot, 'scripts'), implementationVersion: module.version, mapping: scenario.document.network.mapping, provenance: scenario.document.provenance });
    const jobFile = this.jobFile(session, record.runId);
    writeJsonAtomic(jobFile, job); record.jobSha256 = sha256File(jobFile);
    record.state = 'running'; this.save(session, record); this.running.set(record.runId, controller);
    let revision = -1;
    const observe = () => {
      try {
        if (!record.processes && fs.existsSync(path.join(root, 'started.json'))) {
          const started = readSimulationJson<{ pythonPid: number; sumoPid: number }>(path.join(root, 'started.json'));
          const observations = [started.pythonPid, started.sumoPid].map((pid) => inspectProcess(pid, this.options.executable.command));
          if (observations.every((item) => item.state === 'running')) { record.processes = observations.flatMap((item) => item.state === 'running' ? [item.identity] : []); this.save(session, record); }
        }
        const index = readSimulationIndex(root, record.runId);
        if (index.networkSha256 !== job.network.sha256) throw new Error('index_network_mismatch');
        if (index.revision > revision) { revision = index.revision; record.latestComputedTime = index.computedTime; record.availableFrameTime = index.availableTime; this.save(session, record); this.options.notify(session, this.summary(record), revision); }
      } catch { /* No complete block is available yet; final validation remains authoritative. */ }
    };
    const timer = setInterval(observe, 100);
    try {
      await this.runner.run(containedFile(module.packageRoot, path.join(module.packageRoot, 'scripts/compute.py')), [jobFile], { cwd: session.cwd, signal: combined, timeoutMs: 65_000, envMode: 'replace', env: { PYTHONPATH: runtime.pythonPath }, processWeight: 2, maxBuffer: 64 * 1024 });
      record.state = 'finalizing'; this.save(session, record); this.plan(session, true); this.scenario(session, record.scenarioId);
      const { result } = verifySimulationResult(root, job, record.jobSha256!);
      this.assertStopped(root, record);
      record.resultSha256 = sha256File(path.join(root, 'result.json'));
      record.state = 'ended'; record.termination = 'completed'; record.metrics = result.metrics; record.latestComputedTime = result.finalTime; record.availableFrameTime = result.finalTime;
      this.save(session, record); this.release(record);
    } catch (error) {
      observe();
      const problem = error as Error & { code?: string };
      record.state = 'unknown'; record.error = { code: problem.code || 'traffic_result_unknown', message: problem.message.slice(0, 1500) };
      // Startup cancellation may precede result.json. Only recorded native PID
      // absence confirms stop; a concurrent complete candidate still wins.
      if (combined.aborted) try {
        this.assertStopped(root, record);
        try {
          this.plan(session, true); this.scenario(session, record.scenarioId);
          const { result } = verifySimulationResult(root, job, record.jobSha256!);
          record.resultSha256 = sha256File(path.join(root, 'result.json')); record.metrics = result.metrics;
          record.latestComputedTime = result.finalTime; record.availableFrameTime = result.finalTime;
          record.termination = 'completed'; delete record.error;
        } catch { record.termination = 'cancelled'; }
        record.state = 'ended';
      } catch { /* Unknown retains the workspace reservation. */ }
      this.save(session, record);
      if (record.state === 'ended') this.release(record);
    } finally { clearInterval(timer); this.running.delete(record.runId); }
    this.options.notify(session, this.summary(record), Math.max(0, revision));
    return this.summary(record);
  }
  list(session: SimulationSession) {
    this.plan(session);
    const directory = this.directory(session);
    return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => /^sim_[a-f0-9]{32}\.json$/.test(name)).map((name) => this.summary(this.reconcile(session, this.load<RunRecord>(session, name.slice(0, -5))))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
  }
  index(session: SimulationSession, runId: string) {
    const record = this.load<RunRecord>(session, runId), scenario = this.scenario(session, record.scenarioId), root = this.artifact(session, 'runs', runId), index = readSimulationIndex(root, runId);
    if (index.networkSha256 !== scenario.networkSha256) throw fail('traffic_index_changed', 'Index differs from the frozen network.');
    if (record.resultSha256) {
      if (sha256File(containedFile(root, path.join(root, 'result.json'))) !== record.resultSha256) throw fail('traffic_result_changed', 'Committed result manifest changed.');
      const manifest = readSimulationJson<{ files: Array<{ path: string; sha256: string }> }>(path.join(root, 'result.json'));
      if (manifest.files.find((file) => file.path === 'index.json')?.sha256 !== sha256File(path.join(root, 'index.json'))) throw fail('traffic_index_changed', 'Committed result index changed.');
    }
    return index;
  }
  availableIndex(session: SimulationSession, runId: string) {
    this.load<RunRecord>(session, runId);
    try { return this.index(session, runId); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  chunk(session: SimulationSession, runId: string, sequence: number) { return readSimulationChunk(this.artifact(session, 'runs', runId), this.index(session, runId), sequence); }
  geometry(session: SimulationSession, runId: string): SimulationNetworkView {
    const run = this.load<RunRecord>(session, runId), scenario = this.scenario(session, run.scenarioId);
    const geometry = parseSimulationGeometry(readSimulationJson(path.join(this.artifact(session, 'scenarios', run.scenarioId), 'geometry.json')));
    if (!geometry) throw fail('traffic_geometry_invalid', 'Frozen geometry is invalid.');
    const serviceRoutes = scenario.document.configuration.coordination?.routes.map(({ id, mode, origin, target }) => ({ id, mode, origin, target })) ?? [];
    const nodes = new Set(geometry.features.flatMap(feature => feature.properties.nodeId ? [feature.properties.nodeId] : []));
    if (serviceRoutes.some(route => !geometry.routes[route.id] || !nodes.has(route.origin) || !nodes.has(route.target))) {
      throw fail('traffic_geometry_invalid', 'Frozen service routes or stations do not match the geometry.');
    }
    const { rail, startTime, serviceDate, durationSeconds } = scenario.document.configuration;
    return { ...geometry, serviceRoutes, ...(rail ? { rail, startTime, serviceDate, durationSeconds } : {}) };
  }
  presentation(session: SimulationSession, runId: string): CanvasPresentationV1 {
    const record = this.load<RunRecord>(session, runId), scenario = this.scenario(session, record.scenarioId);
    if (!this.plan(session).module.canvasViews.some((view) => view.adapterId === SIMULATION_CANVAS_ADAPTER_ID && view.kind === 'simulation' && view.protocolVersion === '1.0')) throw fail('traffic_adapter_unavailable', 'Simulation adapter is not selected.');
    return { protocol: 'pi-canvas', version: '1.0', presentationId: `simulation:${runId}`, adapterId: SIMULATION_CANVAS_ADAPTER_ID, kind: 'simulation', viewId: `simulation:${runId}`, revision: 1, operation: 'present', title: `${scenario.document.title}${record.experimentId ? ` · seed ${record.seed}` : ''}`, resources: [{ scope: 'capability', moduleId: SIMULATION_MODULE_ID, resourceId: runId }], payload: { runId, scenarioId: record.scenarioId, sourceKind: record.sourceKind, modelValidation: 'not_calibrated', ...(record.experimentId ? { experimentId: record.experimentId } : {}) }, generatedAt: record.createdAt };
  }
  freezeContext(session: SimulationSession, runId: string, input: unknown) {
    const target = parseSimulationCanvasTarget(input);
    if (!target) throw fail('traffic_context_invalid', 'A fixed published time and optional objectId are required.', 400);
    const run = this.load<RunRecord>(session, runId), scenario = this.scenario(session, run.scenarioId), query = this.query(session, { runId, ...target });
    const { block } = this.chunk(session, runId, query.frameSequence);
    const frame = block.frames.find((item) => item.time === query.time) || block.start;
    return { runId, scenarioId: run.scenarioId, networkSha256: scenario.networkSha256, jobSha256: run.jobSha256, frameSha256: simulationDigest(JSON.stringify(frame)), query, ...(run.experimentId ? { experimentId: run.experimentId, experimentSlot: run.experimentSlot, seed: run.seed } : {}) };
  }
  query(session: SimulationSession, body: { runId?: unknown; time?: unknown; objectId?: unknown; limit?: unknown; eventSequence?: unknown }): SimulationQuery {
    const runId = String(body.runId), index = this.index(session, runId), requestedTime = body.time === undefined ? index.availableTime : body.time;
    if (typeof requestedTime !== 'number' || !Number.isFinite(requestedTime) || requestedTime < 0 || requestedTime > index.availableTime) throw fail('traffic_time_unavailable', 'Requested time has not been published.', 400);
    const sequence = index.chunks.reduce((found, item, i) => item.from <= requestedTime ? i : found, -1);
    const root = this.artifact(session, 'runs', runId);
    const current = readSimulationChunk(root, index, sequence), block = current.block;
    const frame = [...block.frames].reverse().find(item => item.time <= requestedTime) || (block.start.time <= requestedTime ? block.start : undefined);
    if (!frame) throw fail('traffic_time_unavailable', 'No complete frame exists at this time.');
    const countsByState: Record<string, number> = {};
    for (const person of Object.values(frame.travelers || {})) countsByState[person.state] = (countsByState[person.state] || 0) + 1;
    const objectId = typeof body.objectId === 'string' && body.objectId.length <= 160 ? body.objectId : undefined;
    const events = index.chunks.slice(0, sequence).flatMap((_entry, i) => readSimulationChunk(root, index, i).events).concat(current.events);
    const routeVehicle = (id: string) => objectId === 'route:shuttle' ? id === 'bus-0' : objectId === 'route:ridehail' ? id === 'car-0' : objectId === 'route:road' && id.startsWith('road-');
    const relevant = events.filter((event) => event.time <= requestedTime && (!objectId || event.objectId === objectId || event.nodeId === objectId || event.routeId === objectId || event.vehicle === objectId || event.service === objectId || event.travelers?.includes(objectId) || routeVehicle(event.objectId) || event.vehicle && routeVehicle(event.vehicle)));
    const event = body.eventSequence === undefined ? undefined : relevant.find((item) => item.sequence === body.eventSequence && item.time === requestedTime);
    if (body.eventSequence !== undefined && !event) throw fail('traffic_event_unavailable', 'The selected event does not match this Run, time and object.', 404);
    const limit = typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit >= 1 && body.limit <= 200 ? body.limit : 100;
    const throughFrame = events.filter(item => item.time <= frame.time);
    const insertedVehicles = new Set(throughFrame.filter(item => item.type === 'vehicle_inserted').map(item => item.objectId)).size;
    const missedConnections = new Set(throughFrame.filter(item => item.type === 'connection_missed').map(item => item.objectId)).size;
    const result: SimulationQuery = { runId, requestedTime, time: frame.time, frameSequence: sequence, partial: !index.final, units: { time: 's', distance: 'm', speed: 'm/s' }, coordinateSystems: { position: 'sumo-network-xy', positionGeo: 'WGS84-longitude-latitude-degrees' }, countsByState, insertedVehicles, ...(frame.travelers ? { missedConnections } : {}), events: relevant.slice(-limit), ...(event ? { event } : {}), truncated: relevant.length > limit };
    const railEvents = events.filter(item => item.time <= requestedTime && (item.type === 'metro_arrived' || item.type === 'metro_departed'));
    if (railEvents.length) result.railEvents = railEvents;
    if (objectId) {
      if (frame.vehicles[objectId] || frame.fleet?.[objectId]) {
        if (frame.vehicles[objectId]) result.vehicle = { id: objectId, ...frame.vehicles[objectId] };
        if (frame.fleet?.[objectId]) result.fleet = { id: objectId, ...frame.fleet[objectId] };
      }
      else if (frame.travelers?.[objectId]) result.traveler = frame.travelers[objectId];
      else if (objectId.startsWith('route:')) {
        const geometry = this.geometry(session, runId), edgeIds = geometry.routes[objectId];
        if (!edgeIds) throw fail('traffic_object_unavailable', 'Route is unavailable.', 404);
        result.route = { id: objectId, edgeIds, vehicles: Object.keys(frame.vehicles).filter((id) => routeVehicle(id) || frame.fleet?.[id]?.route === objectId || geometry.rail?.lineId === objectId && geometry.rail.trainId === id) };
        const run = this.load<RunRecord>(session, runId), service = this.scenario(session, run.scenarioId).document.configuration.coordination;
        if (service?.routes.some(route => route.id === objectId)) result.route.departures = service.departures.filter(item => item.route === objectId).map(({ id, time, vehicle }) => ({ id, time, vehicle }));
        const people = Object.values(frame.travelers || {}).filter(person => 'route' in person && person.route === objectId);
        if (people.length) result.route.countsByState = people.reduce((counts, person) => { counts[person.state] = (counts[person.state] || 0) + 1; return counts; }, {} as Record<string, number>);
      }
      else if (objectId.startsWith('node:')) {
        const record = this.load<RunRecord>(session, runId), { coordination: service, rail } = this.scenario(session, record.scenarioId).document.configuration;
        const node = service?.nodes.find(node => node.id === objectId);
        if (node) result.node = { id: objectId, waiting: Object.values(frame.travelers || {}).filter(p => p.location === objectId && p.state === 'waiting').length, connecting: Object.values(frame.travelers || {}).filter(p => p.location === objectId && p.state === 'connecting').length, walking: Object.values(frame.travelers || {}).filter(p => p.location === objectId && p.state === 'walking').length, blocked: Object.values(frame.travelers || {}).filter(p => p.location === `upstream:${objectId}` && p.state === 'blocked').length, waitingCapacity: node.waitingCapacity, reservedBerths: Object.values(frame.fleet || {}).filter(v => ['boarding', 'commanded', 'outbound', 'return_commanded'].includes(v.state) && service!.routes.some(route => route.id === v.route && route.target === objectId)).length, metro: service?.metro.filter(item => item.node === objectId).map(({ id, time, capacity }) => ({ id, time, capacity })) };
        else if (frame.travelers && ['node:hub', 'node:relay'].includes(objectId)) result.node = { id: objectId, waiting: Object.values(frame.travelers).filter(p => p.location === objectId.slice(5) && p.state === 'waiting').length, connecting: Object.values(frame.travelers).filter(p => p.location === objectId.slice(5) && p.state === 'connecting').length };
        else if (rail?.stops.some(stop => stop.platformId === objectId)) result.platformId = objectId;
        else throw fail('traffic_object_unavailable', 'Node does not exist in this scenario.', 404);
      }
      else if (!event) {
        const record = this.load<RunRecord>(session, runId);
        if (this.scenario(session, record.scenarioId).document.configuration.rail?.trainId !== objectId) throw fail('traffic_object_unavailable', 'Object does not exist in this published frame.', 404);
      }
    }
    return result;
  }
}
