import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseTrafficScenario, parseSimulationCanvasTarget, SIMULATION_MODULE_ID, SIMULATION_CANVAS_ADAPTER_ID, type TrafficScenario, type SimulationRunSummary, type SimulationQuery, type SimulationGeometry } from '../contracts/simulation.js';
import type { CanvasPresentationV1 } from '../contracts/canvas.js';
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
type ScenarioRecord = { schemaVersion: 1; scenarioId: string; owner: string; moduleVersion: string; document: TrafficScenario; networkSha256: string; geometrySha256: string };
type RunRecord = SimulationRunSummary & { schemaVersion: 1; owner: string; workspaceId: string; toolCallId: string; moduleVersion: string; jobId?: string; jobSha256?: string; resultSha256?: string; processes?: ProcessIdentity[] };
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
    if (!/^(sim|scenario)_[a-f0-9]{32}$/.test(id)) throw fail('traffic_reference_invalid', 'Invalid simulation reference.', 400);
    return path.join(this.directory(session), `${id}.json`);
  }
  private jobFile(session: SimulationSession, runId: string) { return this.file(session, runId).replace(/\.json$/, '.job.json'); }
  private load<T extends RunRecord | ScenarioRecord>(session: SimulationSession, id: string): T {
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
  async prepareScenario(session: SimulationSession, body: { inputPath?: unknown; assetId?: unknown }, signal?: AbortSignal) {
    const { plan, module } = this.plan(session, true);
    const asset = body.assetId === undefined ? undefined : plan.assets.find((item) => item.id === body.assetId && item.kind === 'data' && item.integrityStatus === 'verified');
    if (body.assetId !== undefined && !asset) throw fail('traffic_asset_unavailable', 'Select a verified data asset in this conversation.');
    const root = asset?.path || session.cwd;
    const source = containedFile(root, workspaceMetadataPath(root, safeRelative(body.inputPath)));
    if (fs.statSync(source).size > 256 * 1024) throw fail('traffic_input_budget', 'Scenario exceeds 256 KiB.');
    const document = parseTrafficScenario(readSimulationJson(source));
    if (!document) throw fail('traffic_input_invalid', 'Invalid scenario, units, service date or mapping.', 400);
    const config = document.configuration;
    if (config.durationSeconds > 600 || config.backgroundCount > 120 || (config.service?.travelers.length || 0) > 100) throw fail('traffic_input_budget', 'Measured profile allows at most 600 seconds, 120 background vehicles and 100 travelers.');
    const network = containedFile(root, workspaceMetadataPath(root, path.relative(root, path.resolve(path.dirname(source), safeRelative(document.network.path)))));
    if (fs.statSync(network).size > 2 * 1024 * 1024) throw fail('traffic_input_budget', 'Network exceeds 2 MiB.');
    const networkSha256 = sha256File(network);
    const scenarioId = `scenario_${simulationDigest(JSON.stringify([this.owner(session), module.version, document, networkSha256])).slice(0, 32)}`;
    if (fs.existsSync(this.file(session, scenarioId))) { const record = this.scenario(session, scenarioId); return this.scenarioSummary(record); }
    const runtime = module.nativeRuntimes.find((item) => item.kind === 'sumo');
    if (!runtime || runtime.kind !== 'sumo') throw fail('traffic_runtime_unavailable', 'No approved SUMO runtime matches this platform.');
    const output = this.artifact(session, 'scenarios', scenarioId);
    if (fs.existsSync(output)) throw fail('traffic_preparation_interrupted', 'Uncommitted preparation exists. Inspect its files before retrying.');
    fs.mkdirSync(output, { recursive: true });
    const frozenNetwork = path.join(output, 'network.net.xml'); fs.copyFileSync(network, frozenNetwork);
    writeJsonAtomic(path.join(output, 'scenario.json'), document);
    try {
      const { stdout } = await this.runner.run(containedFile(module.packageRoot, path.join(module.packageRoot, 'scripts/inspect_network.py')), [frozenNetwork, JSON.stringify(document.network.mapping), config.model, path.join(output, 'geometry.json')], { cwd: session.cwd, signal, envMode: 'replace', env: { PYTHONPATH: runtime.pythonPath }, timeoutMs: 120_000, maxBuffer: 32 * 1024 });
      const inspected = JSON.parse(stdout);
      if (inspected.protocol !== 'transportx-network-inspection' || inspected.networkSha256 !== networkSha256 || sha256File(network) !== networkSha256 || sha256File(frozenNetwork) !== networkSha256 || inspected.geometry?.sha256 !== sha256File(path.join(output, 'geometry.json'))) throw fail('traffic_preparation_changed', 'Network changed during preparation.');
      this.plan(session, true);
      const record: ScenarioRecord = { schemaVersion: 1, scenarioId, owner: this.owner(session), moduleVersion: module.version, document, networkSha256, geometrySha256: inspected.geometry.sha256 };
      writeJsonAtomic(this.file(session, scenarioId), record);
      return this.scenarioSummary(record);
    } catch (error) { fs.rmSync(output, { recursive: true, force: true }); throw error; }
  }
  private scenarioSummary(record: ScenarioRecord) { return { scenarioId: record.scenarioId, title: record.document.title, provenance: record.document.provenance, networkSha256: record.networkSha256 }; }
  private scenario(session: SimulationSession, id: string) {
    const record = this.load<ScenarioRecord>(session, id), root = this.artifact(session, 'scenarios', id);
    for (const [name, expected] of [['network.net.xml', record.networkSha256], ['geometry.json', record.geometrySha256]]) {
      if (sha256File(containedFile(root, workspaceMetadataPath(root, name))) !== expected) throw fail('traffic_scenario_changed', 'Frozen scenario input changed.');
    }
    if (JSON.stringify(readSimulationJson(containedFile(root, path.join(root, 'scenario.json')))) !== JSON.stringify(record.document)) throw fail('traffic_scenario_changed', 'Frozen scenario document changed.');
    return record;
  }
  prepareRun(session: SimulationSession, body: { scenarioId?: unknown; toolCallId?: unknown; operationId?: unknown }) {
    const scenario = this.scenario(session, String(body.scenarioId)); this.plan(session, true);
    if (typeof body.toolCallId !== 'string' || !body.toolCallId.length || body.toolCallId.length > 200) throw fail('traffic_call_invalid', 'A bounded Pi toolCallId is required.', 400);
    const call = path.join(this.directory(session), `call_${simulationDigest(body.toolCallId)}.json`);
    if (body.operationId || fs.existsSync(call)) {
      const runId = String(body.operationId || readSimulationJson<{ runId: string }>(call).runId);
      const record = this.load<RunRecord>(session, runId);
      if (record.scenarioId !== scenario.scenarioId || record.toolCallId !== body.toolCallId) throw fail('traffic_run_conflict', 'This Run is associated with different inputs or a different tool call.');
      return this.summary(this.reconcile(session, record));
    }
    const pointer = this.pointer(session.workspaceId);
    if (fs.existsSync(pointer)) throw fail('traffic_workspace_busy', 'An unfinished or unconfirmed Run owns this workspace. Query it before starting another.');
    const runId = `sim_${crypto.randomBytes(16).toString('hex')}`, timestamp = now();
    const record: RunRecord = { schemaVersion: 1, runId, scenarioId: scenario.scenarioId, owner: this.owner(session), workspaceId: session.workspaceId!, toolCallId: body.toolCallId, moduleVersion: scenario.moduleVersion, state: 'prepared', createdAt: timestamp, updatedAt: timestamp, latestComputedTime: null, availableFrameTime: null, sourceKind: scenario.document.provenance.kind, modelValidation: 'not_calibrated' };
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
  async run(session: SimulationSession, body: { scenarioId?: unknown; toolCallId?: unknown; operationId?: unknown }, signal: AbortSignal) {
    const summary = this.prepareRun(session, body), record = this.load<RunRecord>(session, summary.runId);
    if (record.state !== 'prepared') return summary;
    const scenario = this.scenario(session, record.scenarioId), { module } = this.plan(session, true);
    const runtime = module.nativeRuntimes.find((item) => item.kind === 'sumo');
    if (!runtime || runtime.kind !== 'sumo') throw fail('traffic_runtime_unavailable', 'Approved SUMO runtime is unavailable.');
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
    const root = this.artifact(session, 'runs', record.runId);
    fs.mkdirSync(root, { recursive: true });
    const job = createSimulationJob(scenario.document.configuration, { network: path.join(this.artifact(session, 'scenarios', record.scenarioId), 'network.net.xml'), inputRoot: session.cwd, outputRoot: root, sumo: runtime.sumo.path, projData: runtime.projData, runId: record.runId, implementationRoot: path.join(module.packageRoot, 'scripts'), implementationVersion: module.version, mapping: scenario.document.network.mapping, provenance: scenario.document.provenance });
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
  geometry(session: SimulationSession, runId: string): SimulationGeometry { const run = this.load<RunRecord>(session, runId); this.scenario(session, run.scenarioId); return readSimulationJson(path.join(this.artifact(session, 'scenarios', run.scenarioId), 'geometry.json')); }
  presentation(session: SimulationSession, runId: string): CanvasPresentationV1 {
    const record = this.load<RunRecord>(session, runId), scenario = this.scenario(session, record.scenarioId);
    if (!this.plan(session).module.canvasViews.some((view) => view.adapterId === SIMULATION_CANVAS_ADAPTER_ID && view.kind === 'simulation' && view.protocolVersion === '1.0')) throw fail('traffic_adapter_unavailable', 'Simulation adapter is not selected.');
    return { protocol: 'pi-canvas', version: '1.0', presentationId: `simulation:${runId}`, adapterId: SIMULATION_CANVAS_ADAPTER_ID, kind: 'simulation', viewId: `simulation:${runId}`, revision: 1, operation: 'present', title: scenario.document.title, resources: [{ scope: 'capability', moduleId: SIMULATION_MODULE_ID, resourceId: runId }], payload: { runId, scenarioId: record.scenarioId, sourceKind: record.sourceKind, modelValidation: 'not_calibrated' }, generatedAt: record.createdAt };
  }
  freezeContext(session: SimulationSession, runId: string, input: unknown) {
    const target = parseSimulationCanvasTarget(input);
    if (!target) throw fail('traffic_context_invalid', 'A fixed published time and optional objectId are required.', 400);
    const run = this.load<RunRecord>(session, runId), scenario = this.scenario(session, run.scenarioId), query = this.query(session, { runId, ...target });
    const { block } = this.chunk(session, runId, query.frameSequence);
    const frame = block.frames.find((item) => item.time === query.time) || block.start;
    return { runId, scenarioId: run.scenarioId, networkSha256: scenario.networkSha256, jobSha256: run.jobSha256, frameSha256: simulationDigest(JSON.stringify(frame)), query };
  }
  query(session: SimulationSession, body: { runId?: unknown; time?: unknown; objectId?: unknown; limit?: unknown }): SimulationQuery {
    const runId = String(body.runId), index = this.index(session, runId), requestedTime = body.time === undefined ? index.availableTime : body.time;
    if (typeof requestedTime !== 'number' || !Number.isFinite(requestedTime) || requestedTime < 0 || requestedTime > index.availableTime) throw fail('traffic_time_unavailable', 'Requested time has not been published.', 400);
    const sequence = index.chunks.reduce((found, item, i) => item.from <= requestedTime ? i : found, -1);
    const { block } = this.chunk(session, runId, sequence), frame = [...block.frames].reverse().find((item) => item.time <= requestedTime) || (block.start.time <= requestedTime ? block.start : undefined);
    if (!frame) throw fail('traffic_time_unavailable', 'No complete frame exists at this time.');
    const countsByState: Record<string, number> = {};
    for (const person of Object.values(frame.travelers || {})) countsByState[person.state] = (countsByState[person.state] || 0) + 1;
    const objectId = typeof body.objectId === 'string' && body.objectId.length <= 160 ? body.objectId : undefined;
    const events = index.chunks.slice(0, sequence + 1).flatMap((_entry, i) => this.chunk(session, runId, i).events);
    const routeVehicle = (id: string) => objectId === 'route:shuttle' ? id === 'bus-0' : objectId === 'route:ridehail' ? id === 'car-0' : objectId === 'route:road' && id.startsWith('road-');
    const relevant = events.filter((event) => event.time <= frame.time && (!objectId || event.objectId === objectId || event.nodeId === objectId || event.vehicle === objectId || event.service === objectId || event.travelers?.includes(objectId) || routeVehicle(event.objectId) || event.vehicle && routeVehicle(event.vehicle)));
    const limit = typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit >= 1 && body.limit <= 200 ? body.limit : 100;
    const result: SimulationQuery = { runId, requestedTime, time: frame.time, frameSequence: sequence, partial: !index.final, units: { time: 's', distance: 'm', speed: 'm/s' }, coordinateSystems: { position: 'sumo-network-xy', positionGeo: 'WGS84-longitude-latitude-degrees' }, countsByState, events: relevant.slice(-limit), truncated: relevant.length > limit };
    if (objectId) {
      if (frame.vehicles[objectId]) result.vehicle = { id: objectId, ...frame.vehicles[objectId] };
      else if (frame.travelers?.[objectId]) result.traveler = frame.travelers[objectId];
      else if (objectId.startsWith('route:')) {
        const edgeIds = this.geometry(session, runId).routes[objectId];
        if (!edgeIds) throw fail('traffic_object_unavailable', 'Route is unavailable.', 404);
        result.route = { id: objectId, edgeIds, vehicles: Object.entries(frame.vehicles).filter(([id, vehicle]) => edgeIds.includes(vehicle.edge) && (objectId === 'route:shuttle' ? id === 'bus-0' : objectId === 'route:ridehail' ? id === 'car-0' : id.startsWith('road-'))).map(([id]) => id) };
      }
      else if (frame.travelers && (objectId === 'node:hub' || objectId === 'node:relay')) result.node = { id: objectId, waiting: Object.values(frame.travelers).filter((person) => person.location === objectId.slice(5) && person.state === 'waiting').length, connecting: Object.values(frame.travelers).filter((person) => person.location === objectId.slice(5) && person.state === 'connecting').length };
      else throw fail('traffic_object_unavailable', 'Object does not exist in this published frame.', 404);
    }
    return result;
  }
}
