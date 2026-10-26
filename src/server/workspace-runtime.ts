import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { WORKSPACE_ID, CONVERSATION_ID } from '../contracts/index.js';
import { acquireWriteLease, readJsonObject, writeJsonAtomic } from './util/json-storage.js';
import { toPosixPath, isWithin } from './util/path.js';
import { platformDataRoot } from './host-platform.js';
import { workspaceMetadataPath } from './workspace-store.js';
import { currentBootId, inspectProcess, inspectRecordedProcess, stopRecordedProcess, type ProcessIdentity } from './process-inspection.js';

type RuntimeProcess = { id: string; kind: 'pi' | 'managed'; state: 'starting' | 'running' | 'stopped'; pid: number | null; identity: ProcessIdentity | null };
type RuntimeRecord = {
  schemaVersion: 1; generation: string; workspaceId: string; conversationId: string | null; directory: string;
  host: ProcessIdentity; phase: 'starting' | 'running' | 'stopping' | 'stop-unconfirmed' | 'stopped';
  processes: RuntimeProcess[]; createdAt: string; updatedAt: string; logDirectory: string;
};
const leases = new Map<string, WorkspaceRuntimeLease>();
const failure = (message: string, code = 'process_stop_unconfirmed') => Object.assign(new Error(message), { code, status: 409 });
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function identity(value: unknown): value is ProcessIdentity {
  const record = value as ProcessIdentity | null;
  return !!record && Object.keys(record).every((key) => ['pid', 'startedAt', 'executableSha256', 'bootId'].includes(key)) && Number.isSafeInteger(record.pid) && record.pid > 0 && typeof record.startedAt === 'string' && !!record.startedAt && sha(record.executableSha256) && sha(record.bootId);
}
function readRuntime(file: string): RuntimeRecord | null {
  if (!fs.existsSync(file)) return null;
  if (fs.lstatSync(file).isSymbolicLink()) throw failure('Runtime coordination metadata cannot be a symbolic link.', 'metadata_corrupt');
  const record = readJsonObject(file) as unknown as RuntimeRecord;
  if (!Object.keys(record).every((key) => ['schemaVersion', 'generation', 'workspaceId', 'conversationId', 'directory', 'host', 'phase', 'processes', 'createdAt', 'updatedAt', 'logDirectory'].includes(key)) || record.schemaVersion !== 1 || typeof record.generation !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.generation) || !WORKSPACE_ID.test(record.workspaceId) || record.conversationId !== null && !CONVERSATION_ID.test(record.conversationId) || typeof record.directory !== 'string' || typeof record.logDirectory !== 'string' || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string' || !identity(record.host) || !['starting', 'running', 'stopping', 'stop-unconfirmed', 'stopped'].includes(record.phase) || !Array.isArray(record.processes) || new Set(record.processes.map((item) => item?.id)).size !== record.processes.length || !record.processes.every((item) => item && Object.keys(item).every((key) => ['id', 'kind', 'state', 'pid', 'identity'].includes(key)) && typeof item.id === 'string' && !!item.id && ['pi', 'managed'].includes(item.kind) && ['starting', 'running', 'stopped'].includes(item.state) && (item.pid === null || Number.isSafeInteger(item.pid) && item.pid > 0) && (item.identity === null ? item.state !== 'running' : identity(item.identity) && item.identity.pid === item.pid))) throw failure('Workspace runtime record is corrupt; inspect its backup and log.', 'metadata_corrupt');
  if (record.phase === 'stopped' && record.processes.some((item) => item.state !== 'stopped')) throw failure('Stopped runtime still contains unconfirmed processes.', 'metadata_corrupt');
  return record;
}
function files(directory: string, coordination: string) {
  const canonical = fs.existsSync(directory) ? fs.realpathSync(directory) : path.join(fs.realpathSync(path.dirname(directory)), path.basename(directory));
  const key = crypto.createHash('sha256').update(toPosixPath(canonical)).digest('hex');
  return { directory: canonical, target: workspaceMetadataPath(coordination, key), file: workspaceMetadataPath(coordination, `${key}.json`) };
}

export class WorkspaceRuntimeLease {
  private active = true;
  constructor(readonly directory: string, private file: string, private record: RuntimeRecord, private release: ReturnType<typeof acquireWriteLease>, private pythonCommand: string) {}
  get generation() { return this.record.generation; }
  private change(update: (record: RuntimeRecord) => void) {
    this.release.assertOwned();
    if (!this.active || leases.get(this.directory) !== this) throw failure('Runtime generation is no longer active.', 'workspace_revision_conflict');
    const current = readRuntime(this.file);
    if (current?.generation !== this.generation) throw failure('Runtime generation changed.', 'workspace_revision_conflict');
    const next = structuredClone(this.record); update(next); next.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.file, next); this.record = next;
  }
  processIntent(kind: RuntimeProcess['kind']) {
    const id = crypto.randomUUID();
    this.change((record) => record.processes.push({ id, kind, state: 'starting', pid: null, identity: null }));
    return {
      started: (child: ChildProcess) => {
        if (!child.pid) return;
        this.change((record) => { record.processes.find((item) => item.id === id)!.pid = child.pid!; });
        const observed = inspectProcess(child.pid, this.pythonCommand);
        if (observed.state === 'unknown') throw failure(observed.reason);
        this.change((record) => {
          const item = record.processes.find((item) => item.id === id)!;
          item.state = observed.state === 'running' ? 'running' : 'stopped';
          item.identity = observed.state === 'running' ? observed.identity : null;
        });
      },
      stopped: () => this.change((record) => { record.processes.find((item) => item.id === id)!.state = 'stopped'; }),
    };
  }
  running() { this.change((record) => { record.phase = 'running'; }); }
  stopping() { this.change((record) => { record.phase = 'stopping'; }); }
  unconfirmed() { this.change((record) => { record.phase = 'stop-unconfirmed'; }); }
  private recordStopped() {
    this.change((record) => {
      if (record.processes.some((item) => item.state !== 'stopped')) throw failure('Pi or managed process stop is not confirmed.');
      record.phase = 'stopped';
    });
  }
  private releaseStopped() { this.active = false; leases.delete(this.directory); this.release(); }
  finish() { this.recordStopped(); this.releaseStopped(); }
  async finishWithCommit<T>(commit: () => Promise<T>) {
    this.change((record) => { if (record.processes.some((item) => item.state !== 'stopped')) throw failure('Pi or managed process stop is not confirmed.'); record.phase = 'stopping'; });
    const result = await commit();
    this.recordStopped();
    this.releaseStopped(); return result;
  }
}

/** RMW leases remain short; this independent lease covers the entire Pi/job lifetime. */
export class WorkspaceRuntimeGate {
  private queues = new Map<string, Promise<unknown>>();
  // The optional location isolates tests. Production does not derive this from per-Host overrides.
  constructor(private pythonCommand: string, private logDirectory: string, private coordinationDirectory = path.join(platformDataRoot(process.platform, {}, os.userInfo().homedir), 'runtime-guards')) {}
  serialize<T>(directory: string, execute: () => Promise<T>): Promise<T> {
    const key = files(directory, this.coordinationDirectory).directory, previous = this.queues.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(execute); this.queues.set(key, operation);
    operation.finally(() => { if (this.queues.get(key) === operation) this.queues.delete(key); }).catch(() => {});
    return operation;
  }
  take(directory: string, workspaceId: string, conversationId: string) {
    if (!CONVERSATION_ID.test(conversationId)) throw failure('Invalid conversation identity.', 'workspace_identity_conflict');
    return this.acquire(directory, workspaceId, conversationId);
  }
  takeMaintenance(directory: string, workspaceId: string) { return this.acquire(directory, workspaceId, null); }
  takeDeletion(directory: string, workspaceId: string) {
    if (isWithin(directory, this.coordinationDirectory)) throw failure('Deletion cannot contain its runtime coordination directory.', 'workspace_identity_conflict');
    return this.acquire(directory, workspaceId, null, true);
  }
  private acquire(directory: string, workspaceId: string, conversationId: string | null, allowMissing = false) {
    if (!WORKSPACE_ID.test(workspaceId)) throw failure('Invalid workspace identity.', 'workspace_identity_conflict');
    if ((!allowMissing && !fs.existsSync(directory)) || fs.existsSync(directory) && !fs.statSync(directory).isDirectory()) throw failure('Workspace directory is missing.', 'workspace_missing');
    const location = files(directory, this.coordinationDirectory);
    if (leases.has(location.directory)) throw failure('Another conversation owns this workspace runtime.', 'workspace_busy');
    fs.mkdirSync(this.coordinationDirectory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.coordinationDirectory).isSymbolicLink()) throw failure('Runtime coordination root is not canonical.', 'metadata_corrupt');
    const coordinator = acquireWriteLease(workspaceMetadataPath(this.coordinationDirectory, 'coordinator'));
    let release: ReturnType<typeof acquireWriteLease>;
    try {
      for (const entry of fs.readdirSync(this.coordinationDirectory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(entry)) {
          const backup = /^([a-f0-9]{64}\.json)\.bak$/.exec(entry);
          if (backup && !fs.existsSync(workspaceMetadataPath(this.coordinationDirectory, backup[1]))) throw failure('A runtime record is missing while its backup survives. Restore its verified coordination record.', 'metadata_corrupt');
          if (!backup && !/^(?:coordinator|[a-f0-9]{64})\.transportx-lock$/.test(entry) && !/^[a-f0-9]{64}\.json(?:\.bak)?\.[a-f0-9-]{36}\.tmp$/.test(entry)) throw failure('Runtime coordination contains unknown metadata.', 'metadata_corrupt');
          continue;
        }
        const other = readRuntime(workspaceMetadataPath(this.coordinationDirectory, entry));
        if (!other || `${crypto.createHash('sha256').update(other.directory).digest('hex')}.json` !== entry) throw failure('Runtime coordination index is corrupt.', 'metadata_corrupt');
        if (other.directory === toPosixPath(location.directory)) continue;
        if (other.phase !== 'stopped' && (isWithin(other.directory, location.directory) || isWithin(location.directory, other.directory))) throw failure('An overlapping workspace runtime has not confirmed its stop.', 'workspace_busy');
      }
      try { release = acquireWriteLease(location.target); }
      catch (error) { throw Object.assign(error as Error, { code: 'workspace_busy' }); }
      try {
      const previous = readRuntime(location.file);
      if (previous && (previous.directory !== toPosixPath(location.directory) || previous.workspaceId !== workspaceId)) throw failure('Runtime workspace identity changed.', 'workspace_identity_conflict');
      if (previous && previous.phase !== 'stopped') throw Object.assign(failure('Previous Host/Pi/job stop is unconfirmed; open runtime diagnostics.'), { generation: previous.generation });
      const host = inspectProcess(process.pid, this.pythonCommand);
      if (host.state !== 'running') throw failure(host.state === 'unknown' ? host.reason : 'Host identity is unavailable.');
      const at = new Date().toISOString();
      const record: RuntimeRecord = { schemaVersion: 1, generation: crypto.randomUUID(), directory: toPosixPath(location.directory), workspaceId, conversationId, host: host.identity, phase: 'starting', processes: [], createdAt: at, updatedAt: at, logDirectory: toPosixPath(this.logDirectory) };
      writeJsonAtomic(location.file, record);
      const lease = new WorkspaceRuntimeLease(location.directory, location.file, record, release, this.pythonCommand);
      leases.set(location.directory, lease); return lease;
      } catch (error) { release(); throw error; }
    } finally { coordinator(); }
  }
  diagnostics(directory: string) {
    const location = files(directory, this.coordinationDirectory), record = readRuntime(location.file);
    if (!record) return { generation: null, phase: 'available', directory: toPosixPath(location.directory), logDirectory: toPosixPath(this.logDirectory), processes: [] };
    if (record.directory !== toPosixPath(location.directory)) throw failure('Runtime workspace path changed.', 'workspace_identity_conflict');
    return {
      ...record,
      hostObservation: inspectRecordedProcess(record.host, this.pythonCommand),
      processes: record.processes.map((item) => {
        const absent = item.pid !== null && inspectProcess(item.pid, this.pythonCommand).state === 'exited';
        return { ...item, observation: item.state === 'stopped' || absent ? { state: 'exited' } : item.identity ? inspectRecordedProcess(item.identity, this.pythonCommand) : { state: 'unknown', reason: item.pid === null ? 'Spawn PID was not committed. Recheck after a system restart if its processes cannot otherwise be identified.' : 'PID exists but its spawn identity was not committed; inspect the process manually before stopping it.' } };
      }),
    };
  }
  recover(directory: string, generation: string, action: 'recheck' | 'stop-owned') {
    if (!['recheck', 'stop-owned'].includes(action)) return Promise.reject(failure('Unsupported runtime recovery action.', 'invalid_runtime_action'));
    return this.serialize(directory, async () => {
      const location = files(directory, this.coordinationDirectory);
      if (leases.has(location.directory)) throw failure('This Host still owns an active runtime; close it through the conversation.', 'workspace_busy');
      const release = acquireWriteLease(location.target);
      try {
        const record = readRuntime(location.file);
        if (!record || record.generation !== generation) throw failure('Runtime generation changed; reload diagnostics.', 'workspace_revision_conflict');
        if (record.directory !== toPosixPath(location.directory)) throw failure('Runtime workspace path changed.', 'workspace_identity_conflict');
        if (record.phase === 'stopped') return this.diagnostics(directory);
        const host = inspectRecordedProcess(record.host, this.pythonCommand);
        if (host.state === 'running') throw failure('The recorded Host is still running; it must confirm its own stop.', 'workspace_busy');
        if (host.state === 'unknown') throw failure(host.reason);
        const rebooted = record.host.bootId !== currentBootId();
        for (const item of record.processes) {
          if (item.state === 'stopped' || rebooted) { item.state = 'stopped'; continue; }
          if (!item.identity) {
            if (item.pid !== null && inspectProcess(item.pid, this.pythonCommand).state === 'exited') { item.state = 'stopped'; continue; }
            throw failure('A spawn was interrupted before its identity was committed; inspect it manually, or recheck after a system restart when no PID was recorded.');
          }
          let observation = inspectRecordedProcess(item.identity, this.pythonCommand);
          if (observation.state === 'running' && action === 'stop-owned') { await stopRecordedProcess(item.identity, this.pythonCommand); observation = inspectRecordedProcess(item.identity, this.pythonCommand); }
          if (observation.state === 'running' || observation.state === 'unknown') throw failure(observation.state === 'unknown' ? observation.reason : 'A recorded Pi or managed job is still running.');
          item.state = 'stopped';
        }
        record.phase = 'stopped'; record.updatedAt = new Date().toISOString(); writeJsonAtomic(location.file, record);
        return this.diagnostics(directory);
      } finally { release(); }
    });
  }
}

/** Domain subprocesses join an already active workspace runtime, never acquire it. */
export function managedRuntimeProcess(directory?: string) {
  if (!directory || !fs.existsSync(directory)) return null;
  return leases.get(fs.realpathSync(directory))?.processIntent('managed') || null;
}
