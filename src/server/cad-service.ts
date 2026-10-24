const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

import type { JsonRecord } from './types.js';
import type { PiRpcSession } from './sessions.js';
import { PythonRunner } from './python-runner.js';
import { sha256File } from './asset-integrity.js';
import { relativePosixPath } from './util/path.js';

import {
  CAD_CANVAS_ADAPTER_ID,
  CAD_PROTOCOL,
  CAD_VERSION,
  diagnosticMessage,
  parseCadCanvasSelection,
  parseCadDrawRequestStructured,
  parseCadDrawResultStructured,
  parseCadInspectRequestStructured,
  parseCadInspectResultStructured,
  parseCadVerifyRequestStructured,
  parseCadVerifyResultStructured,
  type CadDrawRequestV1,
  type CadDrawResultV1,
  type CadInspectRequestV1,
  type CadInspectResultV1,
  type CadVerifyRequestV1,
  type CadVerifyResultV1,
} from '../contracts/index.js';

import { CadDrawingStore, safePath, jobArtifact, serviceError } from './cad/files.js';
import { CadCommit } from './cad/commit.js';
import { cadPresentation } from './cad/presentation.js';
import type { CanvasContextV1 } from '../contracts/canvas.js';

const MAX_ENGINE_OUTPUT = 8 * 1024 * 1024;
const ENGINE_TIMEOUT_MS = 120_000;
const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function requestBody(body: JsonRecord): JsonRecord {
  const { sessionId: _sessionId, token: _token, toolCallId: _toolCallId, contractVersion: _contractVersion, ...request } = body;
  return request;
}

function generatedFileId(request: CadDrawRequestV1): string {
  const source = 'sourcePath' in request ? request.sourcePath : 'drawing';
  const raw = ('title' in request ? request.title : undefined) || path.basename(source).replace(/\.[^.]+$/, '') || 'drawing';
  const slug = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'drawing';
  return `cad_${slug}_${crypto.randomBytes(3).toString('hex')}`;
}

function jsonFromEngine(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    throw serviceError('CAD engine returned invalid JSON.', 502, 'cad.engine_output');
  }
}

export class CadService {
  get activeCount() { return this.runner.activeCount; }
  private store = new CadDrawingStore();
  private commits = new CadCommit(this.store);
  private runner: PythonRunner;
  private locks = new Map<string, Promise<void>>();

  constructor(executable: ConstructorParameters<typeof PythonRunner>[0], private scriptPath: string, private inspectContexts?: (session: PiRpcSession, ids: string[]) => CanvasContextV1[]) {
    this.runner = new PythonRunner(executable);
  }

  async health(): Promise<{ ok: boolean; version?: string; reason?: string }> {
    try {
      const { stdout } = await this.runner.run(this.scriptPath, ['--health'], { cwd: os.tmpdir(), timeoutMs: 15_000 });
      const parsed = jsonFromEngine(stdout) as { ok?: boolean; ezdxf?: string; reason?: string };
      return parsed.ok ? { ok: true, version: parsed.ezdxf } : { ok: false, reason: parsed.reason || 'CAD runtime unavailable' };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async inspect(session: PiRpcSession, body: JsonRecord, signal?: AbortSignal): Promise<CadInspectResultV1> {
    const { contextId, ...input } = requestBody(body);
    if (contextId !== undefined && typeof contextId !== 'string') throw serviceError('CAD contextId must be a string.');
    const context = typeof contextId === 'string' ? this.attachedSelection(session, contextId) : undefined;
    const selection = context && parseCadCanvasSelection(context.selection)!;
    const contextFileId = context?.viewId.replace(/^cad:/, '').replace(/@r[0-9]+$/, '');
    if (context) {
      if (input.path !== undefined || input.fileId !== undefined && input.fileId !== contextFileId) throw serviceError('CAD query and selection refer to different drawings.', 409, 'cad.context_mismatch');
      delete input.fileId;
      const resource = context.resources[0];
      if (resource?.scope !== 'session-file') throw serviceError('CAD selection has no file.', 409);
      input.path = resource.path;
    }
    const parsed = parseCadInspectRequestStructured({ protocol: CAD_PROTOCOL, version: CAD_VERSION, ...input });
    if (!parsed.ok) throw serviceError(parsed.diagnostics.map(diagnosticMessage).join('; '), 400);
    const file = this.resolveInput(session, parsed.value);
    const jobDir = this.createJob(session);
    try {
      const stdout = await this.runEngine(session, jobDir, 'inspect', {
        ...parsed.value,
        fileId: undefined,
        path: file.relativePath,
        ...(selection?.handles.length && !parsed.value.selector ? { selectionHandles: selection.handles } : {}),
      }, signal);
      const result = parseCadInspectResultStructured(jsonFromEngine(stdout));
      if (!result.ok) throw serviceError(result.diagnostics.map(diagnosticMessage).join('; '), 422);
      if (result.value.warnings.some((item) => item.severity === 'error')) throw serviceError('CAD input could not be inspected.', 422, 'cad.invalid_input');
      if (sha256File(file.absolutePath) !== result.value.summary.sha256) throw serviceError('CAD input changed during inspection.', 409, 'cad.checksum');
      if (parsed.value.fileId || contextFileId) {
        const manifest = this.readManifest(session, (contextFileId ?? parsed.value.fileId)!)!;
        const entry = manifest.revisions.find((item) => item.path === file.relativePath);
        if (!entry || entry.sha256 !== result.value.summary.sha256) throw serviceError('CAD inspection differs from its stored revision.', 409, 'cad.checksum');
        return { ...result.value, drawing: { fileId: manifest.fileId, revision: entry.revision, sha256: entry.sha256, ...(manifest.sourceCrs ? { sourceCrs: manifest.sourceCrs } : {}), ...(manifest.target ? { target: manifest.target } : {}) } };
      }
      return result.value;
    } finally {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }

  async verify(session: PiRpcSession, body: JsonRecord, signal?: AbortSignal): Promise<CadVerifyResultV1> {
    const parsed = parseCadVerifyRequestStructured({ protocol: CAD_PROTOCOL, version: CAD_VERSION, ...requestBody(body) });
    if (!parsed.ok) throw serviceError(parsed.diagnostics.map(diagnosticMessage).join('; '), 400);
    const input = this.resolveInput(session, parsed.value);
    const inputHash = sha256File(input.absolutePath);
    const previewKey = inputHash + (parsed.value.previewOptions ? '_' + crypto.createHash('sha256').update(JSON.stringify(parsed.value.previewOptions)).digest('hex').slice(0, 16) : '');
    const jobDir = this.createJob(session);
    try {
      const stdout = await this.runEngine(session, jobDir, 'verify', {
        ...parsed.value,
        _previewKey: previewKey,
        fileId: undefined,
        path: input.relativePath,
      }, signal);
      const result = parseCadVerifyResultStructured(jsonFromEngine(stdout));
      if (!result.ok) throw serviceError(result.diagnostics.map(diagnosticMessage).join('; '), 422);
      if (sha256File(input.absolutePath) !== inputHash) throw serviceError('CAD input changed during verification.', 409, 'cad.checksum');
      if (result.value.preview) {
        for (const format of ['png', 'pdf'] as const) {
          const relative = result.value.preview[format];
          if (relative !== `cad/previews/${previewKey}.${format}`) throw serviceError('CAD preview path differs.', 502, 'cad.engine_result');
          const source = jobArtifact(jobDir, `preview.${format}`);
          if (!fs.statSync(source).size) throw serviceError('CAD preview is empty.', 502);
          const target = safePath(session, relative, [`.${format}`], false);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.renameSync(source, target);
        }
      }
      return result.value;
    } finally {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }

  async draw(session: PiRpcSession, body: JsonRecord, signal?: AbortSignal, operationId?: string, inputSha256?: string): Promise<CadDrawResultV1> {
    const prepared = this.prepare(session, body);
    const request = prepared.request;
    if (inputSha256 && prepared.inputSha256 !== inputSha256) throw serviceError('CAD input changed before execution.', 409, 'cad.checksum');
    const fileId = request.fileId!;
    if (!FILE_ID.test(fileId)) throw serviceError('Invalid CAD fileId.', 400);
    return this.withLock(`${session.cwd}:${fileId}`, async () => {
      const manifest = this.readManifest(session, fileId);
      if (request.kind === 'edit' || request.kind === 'commit-candidate') {
        if (!manifest) throw serviceError(`CAD drawing not found: ${fileId}`, 404, 'cad.not_found');
        if (manifest.currentRevision !== request.baseRevision) {
          throw serviceError(`CAD revision mismatch: current r${manifest.currentRevision}, request r${request.baseRevision}`, 409, 'cad.revision_mismatch');
        }
      } else if (manifest) {
        throw serviceError(`CAD fileId already exists: ${fileId}`, 409, 'cad.file_exists');
      }

      const jobDir = this.createJob(session, operationId);
      let preserve = false;
      try {
        if (signal?.aborted) throw serviceError('CAD cancelled before dispatch.', 409, 'cad_cancelled');
        const engineRequest = { ...request, fileId };
        const stdout = await this.runEngine(session, jobDir, 'draw', engineRequest, signal);
        const result = parseCadDrawResultStructured(jsonFromEngine(stdout));
        if (!result.ok) throw serviceError(result.diagnostics.map(diagnosticMessage).join('; '), 422);
        if (!result.value.ok || result.value.dryRun) return result.value;
        if (this.prepare(session, body).inputSha256 !== prepared.inputSha256) throw serviceError('CAD input changed during execution.', 409, 'cad.checksum');
        const committed = this.commit(session, fileId, request, manifest, result.value, jobDir);
        preserve = !!operationId;
        return { ...committed, canvas: cadPresentation(this.readManifest(session, fileId)!, committed.drawing!, request.kind === 'edit' || request.kind === 'commit-candidate' ? 'update' : 'present', committed.preview) };
      } catch (error) {
        preserve = (error as { code?: string }).code === 'process_stop_unconfirmed' || fs.existsSync(path.join(jobDir, 'commit.json'));
        throw Object.assign(error as Error, { commit: preserve ? 'unknown' : 'not_committed', phase: preserve ? 'commit' : 'execution' });
      } finally {
        if (!preserve) fs.rmSync(jobDir, { recursive: true, force: true });
      }
    });
  }

  private sourceFileId(sourcePath: string) { return `cad_${crypto.createHash('sha256').update(sourcePath).digest('hex').slice(0, 24)}`; }

  resolvePresentation(session: PiRpcSession, viewId: string) {
    const identity = viewId.match(/^cad:([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?:@r([0-9]+))?$/);
    if (!identity) return null;
    const fileId = identity[1];
    const historicalRevision = identity[2] === undefined ? undefined : Number(identity[2]);
    const manifest = this.readManifest(session, fileId);
    if (!manifest) return null;
    this.resolveInput(session, { protocol: CAD_PROTOCOL, version: CAD_VERSION, fileId, revision: historicalRevision, policy: 'basic' });
    return cadPresentation(manifest, undefined, 'present', undefined, historicalRevision);
  }

  async present(session: PiRpcSession, input: { resource?: unknown; title?: unknown }) {
    const resource = input.resource as { scope?: unknown; path?: unknown } | undefined;
    if (resource?.scope !== 'session-file' || typeof resource.path !== 'string') throw serviceError('CAD requires a session DXF resource.');
    const absolute = safePath(session, resource.path, ['.dxf']);
    const sourcePath = relativePosixPath(fs.realpathSync(session.cwd), absolute);
    const managed = sourcePath.match(/^cad\/([A-Za-z0-9._-]+)\/r([0-9]+)\.dxf$/);
    const existing = !managed ? this.store.findSource(session, sourcePath) : null;
    const fileId = managed?.[1] ?? existing?.fileId ?? this.sourceFileId(sourcePath);
    return this.withLock(`${session.cwd}:${fileId}`, async () => {
      let manifest = this.readManifest(session, fileId);
      if (!manifest) {
        if (managed) throw serviceError('CAD revision has no manifest.', 409, 'cad.manifest_corrupt');
        const inspected = await this.inspect(session, { path: sourcePath });
        if (inspected.warnings.some((item) => item.severity === 'error' || item.code === 'cad.audit')) throw serviceError('DXF could not be opened without audit errors.', 422);
        manifest = this.store.registerSnapshot(session, fileId, sourcePath, inspected.summary, input.title);
      } else if (!managed && manifest.sourceRefs?.some((source) => source.path === sourcePath && source.sha256 !== sha256File(absolute))) {
        throw serviceError(`Source DXF changed. Submit commit-candidate to ${fileId} using its current revision/hash, or explicitly import a separate drawing.`, 409, 'cad.source_changed');
      }
      const historical = managed && Number(managed[2]) !== manifest.currentRevision ? Number(managed[2]) : undefined;
      const inspected = await this.inspect(session, historical === undefined ? { fileId } : { path: sourcePath });
      if (historical !== undefined && !manifest.revisions.some((entry) => entry.revision === historical && entry.sha256 === inspected.summary.sha256)) throw serviceError('Historical CAD revision differs.', 409, 'cad.checksum');
      return cadPresentation(manifest, inspected.summary, 'present', undefined, historical);
    });
  }

  private attachedSelection(session: PiRpcSession, contextId: string) {
    const context = this.inspectContexts?.(session, [contextId])[0];
    if (!context || context.adapterId !== CAD_CANVAS_ADAPTER_ID || !parseCadCanvasSelection(context.selection)?.drawingSha256) throw serviceError('Attach a current CAD selection.', 409, 'cad.context_mismatch');
    return context;
  }

  prepare(session: PiRpcSession, body: JsonRecord) {
    const input = { protocol: CAD_PROTOCOL, version: CAD_VERSION, ...requestBody(body) } as JsonRecord;
    if (input.kind === 'edit' && typeof input.contextId === 'string') {
      const context = this.attachedSelection(session, input.contextId);
      const selection = context && parseCadCanvasSelection(context.selection);
      if (!context || context.adapterId !== CAD_CANVAS_ADAPTER_ID || !selection?.drawingSha256) throw serviceError('Attach a current CAD selection.', 409, 'cad.context_mismatch');
      const reference = { fileId: context.viewId.replace(/^cad:/, '').replace(/@r[0-9]+$/, ''), baseRevision: context.revision, expectedSha256: selection.drawingSha256 };
      for (const [key, value] of Object.entries(reference)) {
        if (input[key] !== undefined && input[key] !== value) throw serviceError('CAD selection and drawing version differ.', 409, 'cad.context_mismatch');
        input[key] = value;
      }
    }
    const parsed = parseCadDrawRequestStructured(input);
    if (!parsed.ok) throw Object.assign(serviceError(parsed.diagnostics.map(diagnosticMessage).join('; '), 400), { commit: 'not_started', phase: 'validation' });
    const request = { ...parsed.value, fileId: parsed.value.fileId ?? (parsed.value.kind === 'import' ? this.sourceFileId(parsed.value.sourcePath) : generatedFileId(parsed.value)) };
    let inputPath: string;
    if (request.kind === 'edit' || request.kind === 'commit-candidate') {
      const manifest = this.readManifest(session, request.fileId);
      if (!manifest || manifest.currentRevision !== request.baseRevision) throw Object.assign(serviceError('CAD revision mismatch or missing manifest.', 409, 'cad.revision_mismatch'), { commit: 'not_started' });
      inputPath = this.resolveInput(session, { protocol: CAD_PROTOCOL, version: CAD_VERSION, fileId: request.fileId, include: ['summary'], limit: 1 }).absolutePath;
      if (sha256File(inputPath) !== request.expectedSha256) throw Object.assign(serviceError('CAD base checksum changed.', 409, 'cad.checksum'), { commit: 'not_started' });
      if (request.kind === 'commit-candidate') {
        if (request.sourcePath.startsWith('cad/')) throw Object.assign(serviceError('Write candidates outside the managed cad/ directory.', 400, 'cad.candidate_path'), { commit: 'not_started' });
        inputPath = safePath(session, request.sourcePath, ['.dxf']);
      }
    } else {
      if (this.readManifest(session, request.fileId)) throw Object.assign(serviceError('CAD fileId already exists.', 409, 'cad.file_exists'), { commit: 'not_started' });
      inputPath = safePath(session, request.sourcePath, request.kind === 'import' ? ['.dxf'] : ['.geojson', '.json']);
    }
    return { request, inputSha256: sha256File(inputPath) };
  }

  verifyCommitted(...args: Parameters<CadCommit['verifyCommitted']>) { return this.commits.verifyCommitted(...args); }
  recover(...args: Parameters<CadCommit['recover']>) { return this.commits.recover(...args); }
  finalize(...args: Parameters<CadCommit['finalize']>) { return this.commits.finalize(...args); }

  terminateAll() {
    return this.runner.terminateAll();
  }

  private async withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(run);
    const tail = operation.then(() => undefined, () => undefined);
    this.locks.set(key, tail);
    try {
      return await operation;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private createJob(session: PiRpcSession, operationId?: string): string {
    if (operationId && !/^cad_[a-f0-9]{32}$/.test(operationId)) throw serviceError('Invalid CAD operation ID.');
    const jobId = operationId ?? `cad_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
    const jobDir = safePath(session, `.tau/cad-jobs/${jobId}`, [], false);
    fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
    return jobDir;
  }

  private async runEngine(
    session: PiRpcSession,
    jobDir: string,
    action: 'draw' | 'inspect' | 'verify',
    request: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    const requestPath = path.join(jobDir, 'request.json');
    fs.writeFileSync(requestPath, `${JSON.stringify({
      protocol: 'tau-cad-engine',
      version: '1.0',
      action,
      workspaceRoot: fs.realpathSync(session.cwd),
      jobDir,
      request,
    }, null, 2)}\n`, { mode: 0o600 });
    const { stdout } = await this.runner.run(this.scriptPath, ['--request', requestPath], {
      cwd: session.cwd,
      timeoutMs: ENGINE_TIMEOUT_MS,
      maxBuffer: MAX_ENGINE_OUTPUT,
      signal,
    });
    return stdout;
  }

  private readManifest(session: PiRpcSession, fileId: string) { return this.store.readManifest(session, fileId); }
  private resolveInput(session: PiRpcSession, request: CadInspectRequestV1 | CadVerifyRequestV1) { return this.store.resolveInput(session, request); }
  private commit(...args: Parameters<CadCommit['commit']>) { return this.commits.commit(...args); }
}
