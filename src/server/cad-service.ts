const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

import type { JsonRecord } from './types.js';
import type { PiRpcSession } from './sessions.js';
import { PythonRunner } from './python-runner.js';
import { sha256File } from './asset-integrity.js';
import { isWithin, relativePosixPath } from './util/path.js';
import { writeJsonAtomic } from './util/json-storage.js';
import {
  CAD_CANVAS_ADAPTER_ID,
  CAD_CANVAS_KIND,
  CAD_DRAWING_PROTOCOL,
  CAD_DRAWING_VERSION,
  CAD_PROTOCOL,
  CAD_VERSION,
  CANVAS_PRESENTATION_PROTOCOL,
  CANVAS_PRESENTATION_VERSION,
  diagnosticMessage,
  parseCadCanvasPayload,
  parseCadCanvasTarget,
  parseCanvasPresentation,
  parseCadDrawRequestStructured,
  parseCadDrawResultStructured,
  parseCadDrawingManifestStructured,
  parseCadInspectRequestStructured,
  parseCadInspectResultStructured,
  parseCadVerifyRequestStructured,
  parseCadVerifyResultStructured,
  type CadDrawRequestV1,
  type CadDrawResultV1,
  type CadDrawingManifestV1,
  type CadInspectRequestV1,
  type CadInspectResultV1,
  type CadVerifyRequestV1,
  type CadVerifyResultV1,
} from '../contracts/index.js';

const MAX_ENGINE_OUTPUT = 8 * 1024 * 1024;
const ENGINE_TIMEOUT_MS = 120_000;
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type ServiceError = Error & { status?: number; code?: string };

function serviceError(message: string, status = 400, code?: string): ServiceError {
  const error = Object.assign(new Error(message), { status }) as ServiceError;
  if (code) error.code = code;
  return error;
}

function requestBody(body: JsonRecord): JsonRecord {
  const { sessionId: _sessionId, token: _token, ...request } = body;
  return request;
}

function requestTitle(request: CadDrawRequestV1): string | undefined {
  return 'title' in request ? request.title : undefined;
}

function requestTarget(request: CadDrawRequestV1) {
  return 'target' in request ? request.target : undefined;
}

function requestSourcePath(request: CadDrawRequestV1): string | undefined {
  return 'sourcePath' in request ? request.sourcePath : undefined;
}

function generatedFileId(request: CadDrawRequestV1): string {
  const source = requestSourcePath(request) || 'drawing';
  const raw = requestTitle(request) || path.basename(source).replace(/\.[^.]+$/, '') || 'drawing';
  const slug = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'drawing';
  return `cad_${slug}_${crypto.randomBytes(3).toString('hex')}`;
}

function assertRelativePath(relativePath: string): void {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\\') || /^[A-Za-z]:/.test(relativePath)) {
    throw serviceError('CAD paths must be relative POSIX paths.', 400, 'cad.unsafe_path');
  }
  if (relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw serviceError('CAD paths cannot contain empty, "." or ".." segments.', 400, 'cad.unsafe_path');
  }
}

function safePath(session: PiRpcSession, relativePath: string, extensions: string[] = [], mustExist = true): string {
  assertRelativePath(relativePath);
  const root = fs.realpathSync(session.cwd);
  let cursor = root;
  for (const part of relativePath.split('/')) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw serviceError(`CAD path cannot use symbolic links: ${relativePath}`, 400, 'cad.unsafe_path');
    }
  }
  const resolved = path.resolve(root, relativePath);
  if (!isWithin(root, resolved)) throw serviceError(`CAD path escapes the session: ${relativePath}`, 400, 'cad.unsafe_path');
  if (extensions.length && !extensions.some((extension) => resolved.toLowerCase().endsWith(extension))) {
    throw serviceError(`CAD path must end with ${extensions.join(' or ')}.`, 400, 'cad.unsafe_path');
  }
  if (mustExist) {
    if (!fs.existsSync(resolved)) throw serviceError(`CAD file not found: ${relativePath}`, 404, 'cad.not_found');
    const real = fs.realpathSync(resolved);
    if (!isWithin(root, real) || !fs.statSync(real).isFile()) {
      throw serviceError(`CAD file is outside the session: ${relativePath}`, 400, 'cad.unsafe_path');
    }
    if (fs.statSync(real).size > MAX_INPUT_BYTES) {
      throw serviceError(`CAD input exceeds ${MAX_INPUT_BYTES} bytes.`, 413, 'cad.too_large');
    }
    return real;
  }
  return resolved;
}

function jobArtifact(jobDir: string, name: string): string {
  const candidate = path.resolve(jobDir, 'out', name);
  if (!isWithin(jobDir, candidate) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw serviceError(`CAD engine artifact is missing: ${name}`, 502, 'cad.engine_artifact');
  }
  return candidate;
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
  private runner: PythonRunner;
  private locks = new Map<string, Promise<void>>();

  constructor(executable: ConstructorParameters<typeof PythonRunner>[0], private scriptPath: string) {
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
    const parsed = parseCadInspectRequestStructured(requestBody(body));
    if (!parsed.ok) throw serviceError(parsed.diagnostics.map(diagnosticMessage).join('; '), 400);
    const input = this.resolveInput(session, parsed.value);
    const jobDir = this.createJob(session);
    try {
      const stdout = await this.runEngine(session, jobDir, 'inspect', {
        ...parsed.value,
        fileId: undefined,
        path: input.relativePath,
      }, signal);
      const result = parseCadInspectResultStructured(jsonFromEngine(stdout));
      if (!result.ok) throw serviceError(result.diagnostics.map(diagnosticMessage).join('; '), 422);
      return result.value;
    } finally {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }

  async verify(session: PiRpcSession, body: JsonRecord, signal?: AbortSignal): Promise<CadVerifyResultV1> {
    const parsed = parseCadVerifyRequestStructured(requestBody(body));
    if (!parsed.ok) throw serviceError(parsed.diagnostics.map(diagnosticMessage).join('; '), 400);
    const input = this.resolveInput(session, parsed.value);
    const jobDir = this.createJob(session);
    try {
      const stdout = await this.runEngine(session, jobDir, 'verify', {
        ...parsed.value,
        fileId: undefined,
        path: input.relativePath,
      }, signal);
      const result = parseCadVerifyResultStructured(jsonFromEngine(stdout));
      if (!result.ok) throw serviceError(result.diagnostics.map(diagnosticMessage).join('; '), 422);
      return result.value;
    } finally {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  }

  async draw(session: PiRpcSession, body: JsonRecord, signal?: AbortSignal): Promise<CadDrawResultV1> {
    const parsed = parseCadDrawRequestStructured(requestBody(body));
    if (!parsed.ok) throw serviceError(parsed.diagnostics.map(diagnosticMessage).join('; '), 400);
    const request = parsed.value;
    const fileId = request.fileId ?? generatedFileId(request);
    if (!FILE_ID.test(fileId)) throw serviceError('Invalid CAD fileId.', 400);
    return this.withLock(`${session.cwd}:${fileId}`, async () => {
      const manifest = this.readManifest(session, fileId);
      if (request.kind === 'edit') {
        if (!manifest) throw serviceError(`CAD drawing not found: ${fileId}`, 404, 'cad.not_found');
        if (manifest.currentRevision !== request.baseRevision) {
          throw serviceError(`CAD revision mismatch: current r${manifest.currentRevision}, request r${request.baseRevision}`, 409, 'cad.revision_mismatch');
        }
      } else if (manifest) {
        throw serviceError(`CAD fileId already exists: ${fileId}`, 409, 'cad.file_exists');
      }

      const jobDir = this.createJob(session);
      try {
        const engineRequest = { ...request, fileId };
        const stdout = await this.runEngine(session, jobDir, 'draw', engineRequest, signal);
        const result = parseCadDrawResultStructured(jsonFromEngine(stdout));
        if (!result.ok) throw serviceError(result.diagnostics.map(diagnosticMessage).join('; '), 422);
        if (!result.value.ok || result.value.dryRun) return result.value;
        return this.commit(session, fileId, request, manifest, result.value, jobDir);
      } finally {
        fs.rmSync(jobDir, { recursive: true, force: true });
      }
    });
  }

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

  private createJob(session: PiRpcSession): string {
    const jobId = `cad_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
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

  private manifestPath(session: PiRpcSession, fileId: string): string {
    return safePath(session, `.tau/cad-drawings/${fileId}/manifest.json`, [], false);
  }

  private readManifest(session: PiRpcSession, fileId: string): CadDrawingManifestV1 | null {
    const file = this.manifestPath(session, fileId);
    if (!fs.existsSync(file)) return null;
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw serviceError(`CAD manifest is corrupt: ${fileId}`, 409, 'cad.manifest_corrupt');
    }
    const parsed = parseCadDrawingManifestStructured(value);
    if (!parsed.ok) throw serviceError(parsed.diagnostics.map(diagnosticMessage).join('; '), 409, 'cad.manifest_corrupt');
    return parsed.value;
  }

  private resolveInput(session: PiRpcSession, request: CadInspectRequestV1 | CadVerifyRequestV1): { relativePath: string; absolutePath: string } {
    if (request.path) {
      const absolutePath = safePath(session, request.path, ['.dxf'], true);
      return { relativePath: relativePosixPath(fs.realpathSync(session.cwd), absolutePath), absolutePath };
    }
    if (!request.fileId) throw serviceError('fileId or path is required.', 400);
    const requestedRevision = 'revision' in request ? request.revision : undefined;
    const manifest = this.readManifest(session, request.fileId);
    if (manifest) {
      const revision = requestedRevision ?? manifest.currentRevision;
      const entry = manifest.revisions.find((item) => item.revision === revision);
      if (!entry) throw serviceError(`CAD revision not found: ${request.fileId} r${revision}`, 404, 'cad.not_found');
      const absolutePath = safePath(session, entry.path, ['.dxf'], true);
      return { relativePath: entry.path, absolutePath };
    }
    const directory = safePath(session, `cad/${request.fileId}`, [], false);
    if (!fs.existsSync(directory)) throw serviceError(`CAD drawing not found: ${request.fileId}`, 404, 'cad.not_found');
    const candidates: Array<{ name: string; revision: number }> = [];
    for (const name of fs.readdirSync(directory) as string[]) {
      const match = /^r(\d+)\.dxf$/.exec(name);
      if (match) candidates.push({ name, revision: Number(match[1]) });
    }
    candidates.sort((a: { revision: number }, b: { revision: number }) => a.revision - b.revision);
    if (!candidates.length) throw serviceError(`CAD drawing not found: ${request.fileId}`, 404, 'cad.not_found');
    const revision = requestedRevision ?? candidates[candidates.length - 1].revision;
    const entry = candidates.find((item: { revision: number }) => item.revision === revision);
    if (!entry) throw serviceError(`CAD revision not found: ${request.fileId} r${revision}`, 404, 'cad.not_found');
    const relativePath = `cad/${request.fileId}/${entry.name}`;
    return { relativePath, absolutePath: safePath(session, relativePath, ['.dxf'], true) };
  }

  private commit(
    session: PiRpcSession,
    fileId: string,
    request: CadDrawRequestV1,
    previous: CadDrawingManifestV1 | null,
    result: CadDrawResultV1,
    jobDir: string,
  ): CadDrawResultV1 {
    const drawing = result.drawing;
    if (!drawing) throw serviceError('CAD engine returned no drawing.', 502, 'cad.engine_result');
    const expectedRevision = request.kind === 'edit' ? request.baseRevision + 1 : request.kind === 'import' ? 0 : 1;
    if (drawing.fileId !== fileId || drawing.revision !== expectedRevision) {
      throw serviceError('CAD engine returned an unexpected fileId or revision.', 502, 'cad.engine_result');
    }
    const expectedDxf = `cad/${fileId}/r${expectedRevision}.dxf`;
    if (drawing.path !== expectedDxf) throw serviceError('CAD engine returned an unexpected drawing path.', 502, 'cad.engine_result');

    const tempDxf = jobArtifact(jobDir, `r${expectedRevision}.dxf`);
    if (fs.statSync(tempDxf).size !== drawing.bytes || sha256File(tempDxf) !== drawing.sha256) {
      throw serviceError('CAD engine output failed checksum validation.', 502, 'cad.checksum');
    }

    const finalDxf = safePath(session, expectedDxf, ['.dxf'], false);
    if (fs.existsSync(finalDxf)) throw serviceError(`CAD revision already exists: ${drawing.path}`, 409, 'cad.file_exists');

    const artifacts: Array<{ temp: string; final: string }> = [{ temp: tempDxf, final: finalDxf }];
    if (result.preview) {
      const expectedPng = `cad/${fileId}/r${expectedRevision}.png`;
      if (result.preview.png !== expectedPng) throw serviceError('CAD engine returned an unexpected preview path.', 502, 'cad.engine_result');
      const tempPng = jobArtifact(jobDir, `r${expectedRevision}.png`);
      if (fs.statSync(tempPng).size <= 0) throw serviceError('CAD preview is empty.', 502, 'cad.engine_result');
      artifacts.push({ temp: tempPng, final: safePath(session, expectedPng, ['.png'], false) });
      if (result.preview.pdf) {
        const expectedPdf = `cad/${fileId}/r${expectedRevision}.pdf`;
        if (result.preview.pdf !== expectedPdf) throw serviceError('CAD engine returned an unexpected PDF path.', 502, 'cad.engine_result');
        const tempPdf = jobArtifact(jobDir, `r${expectedRevision}.pdf`);
        if (fs.statSync(tempPdf).size <= 0) throw serviceError('CAD PDF preview is empty.', 502, 'cad.engine_result');
        artifacts.push({ temp: tempPdf, final: safePath(session, expectedPdf, ['.pdf'], false) });
      }
    }

    const now = new Date().toISOString();
    const revisions = [...(previous?.revisions ?? []), {
      revision: drawing.revision,
      path: drawing.path,
      sha256: drawing.sha256,
      bytes: drawing.bytes,
      ...(previous?.revisions.length ? { parentSha256: previous.revisions[previous.revisions.length - 1].sha256 } : {}),
      ...(result.plan ? { operationCount: result.plan.operationCount } : {}),
      createdAt: now,
    }];
    const target = requestTarget(request);
    const sourceCrs = request.kind === 'from-geojson' ? 'EPSG:4326' : previous?.sourceCrs;
    const manifest: CadDrawingManifestV1 = {
      protocol: CAD_DRAWING_PROTOCOL,
      version: CAD_DRAWING_VERSION,
      drawingId: fileId,
      fileId,
      title: previous?.title || requestTitle(request) || fileId,
      currentRevision: drawing.revision,
      revisions,
      units: drawing.units,
      ...(sourceCrs ? { sourceCrs } : {}),
      ...(target ? { target } : previous?.target ? { target: previous.target } : {}),
      ...(result.sourceRefs ? { sourceRefs: result.sourceRefs } : previous?.sourceRefs ? { sourceRefs: previous.sourceRefs } : {}),
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
    const parsedManifest = parseCadDrawingManifestStructured(manifest);
    if (!parsedManifest.ok) throw serviceError(parsedManifest.diagnostics.map(diagnosticMessage).join('; '), 500, 'cad.manifest_invalid');

    const moved: string[] = [];
    try {
      for (const artifact of artifacts) {
        if (fs.existsSync(artifact.final)) throw serviceError(`CAD output already exists: ${artifact.final}`, 409, 'cad.file_exists');
        fs.mkdirSync(path.dirname(artifact.final), { recursive: true });
        fs.renameSync(artifact.temp, artifact.final);
        moved.push(artifact.final);
      }
      writeJsonAtomic(this.manifestPath(session, fileId), parsedManifest.value);
    } catch (error) {
      for (const file of moved.reverse()) fs.rmSync(file, { force: true });
      throw error;
    }

    const center: [number, number] = drawing.extents
      ? [(drawing.extents.min[0] + drawing.extents.max[0]) / 2, (drawing.extents.min[1] + drawing.extents.max[1]) / 2]
      : [0, 0];
    const payload = parseCadCanvasPayload({
      format: 'dxf',
      path: drawing.path,
      sha256: drawing.sha256,
      units: drawing.units,
      layerCount: drawing.layerCount,
      entityCount: drawing.entityCount,
      ...(result.preview?.png ? { preview: result.preview.png } : {}),
    });
    const canvasTarget = parseCadCanvasTarget({ kind: 'viewport', center, zoom: 1, units: drawing.units });
    const canvas = payload && canvasTarget
      ? parseCanvasPresentation({
          protocol: CANVAS_PRESENTATION_PROTOCOL,
          version: CANVAS_PRESENTATION_VERSION,
          presentationId: `cad_pres_${crypto.randomUUID()}`,
          adapterId: CAD_CANVAS_ADAPTER_ID,
          kind: CAD_CANVAS_KIND,
          viewId: `cad:${fileId}`,
          revision: drawing.revision,
          operation: request.kind === 'edit' ? 'update' : 'present',
          title: manifest.title,
          resources: [{ scope: 'session-file', path: drawing.path }],
          payload,
          target: canvasTarget,
          generatedAt: now,
        })
      : null;
    if (!canvas) throw serviceError('CAD Canvas presentation is invalid.', 500, 'cad.canvas_invalid');
    return { ...result, canvas };
  }
}
