const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

import { sha256File } from '../asset-integrity.js';
import { writeJsonAtomic } from '../util/json-storage.js';
import { isWithin, relativePosixPath } from '../util/path.js';

import {
  CAD_DRAWING_PROTOCOL,
  CAD_DRAWING_VERSION,
  diagnosticMessage,
  parseCadDrawingManifestStructured,
  type CadDrawingManifestV1,
  type CadInspectResultV1,
  type CadInspectRequestV1,
  type CadVerifyRequestV1,
} from '../../contracts/index.js';

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
type CadFileContext = { cwd: string };
type ServiceError = Error & { status?: number; code?: string };

export function serviceError(message: string, status = 400, code?: string): ServiceError {
  const error = Object.assign(new Error(message), { status }) as ServiceError;
  if (code) error.code = code;
  return error;
}

function assertRelativePath(relativePath: string): void {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\\') || /^[A-Za-z]:/.test(relativePath)) {
    throw serviceError('CAD paths must be relative POSIX paths.', 400, 'cad.unsafe_path');
  }
  if (relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw serviceError('CAD paths cannot contain empty, "." or ".." segments.', 400, 'cad.unsafe_path');
  }
}

export function safePath(session: CadFileContext, relativePath: string, extensions: string[] = [], mustExist = true): string {
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

export function jobArtifact(jobDir: string, name: string): string {
  const candidate = path.resolve(jobDir, 'out', name);
  if (!isWithin(jobDir, candidate) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw serviceError(`CAD engine artifact is missing: ${name}`, 502, 'cad.engine_artifact');
  }
  return candidate;
}

export class CadDrawingStore {
  findSource(session: CadFileContext, sourcePath: string): CadDrawingManifestV1 | null {
    const root = safePath(session, '.tau/cad-drawings', [], false);
    if (!fs.existsSync(root)) return null;
    const matches = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry: import('node:fs').Dirent) => entry.isDirectory())
      .map((entry: import('node:fs').Dirent) => this.readManifest(session, entry.name))
      .filter((manifest: CadDrawingManifestV1 | null): manifest is CadDrawingManifestV1 => !!manifest?.sourceRefs?.some((source) => source.path === sourcePath));
    if (matches.length > 1) throw serviceError('Multiple drawings reference this source. Open a managed revision path or the returned viewId.', 409, 'cad.source_ambiguous');
    return matches[0] ?? null;
  }

  registerSnapshot(session: CadFileContext, fileId: string, sourcePath: string, summary: CadInspectResultV1['summary'], title: unknown): CadDrawingManifestV1 {
    const absolute = safePath(session, sourcePath, ['.dxf']);
    const sha256 = sha256File(absolute);
    if (sha256 !== summary.sha256) throw serviceError('CAD input changed while opening.', 409, 'cad.checksum');
    const relative = `cad/${fileId}/r1.dxf`;
    const target = safePath(session, relative, ['.dxf'], false);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Opening snapshots bytes; it never rewrites geometry or assumes units.
    if (fs.existsSync(target) && sha256File(target) !== sha256) throw serviceError('Unconfirmed initial CAD revision exists.', 409, 'cad_result_unknown');
    if (!fs.existsSync(target)) {
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      try {
        fs.copyFileSync(absolute, temporary);
        if (sha256File(temporary) !== sha256) throw serviceError('CAD input changed while opening.', 409, 'cad.checksum');
        fs.renameSync(temporary, target);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    const now = new Date().toISOString();
    const manifest: CadDrawingManifestV1 = {
      protocol: CAD_DRAWING_PROTOCOL, version: CAD_DRAWING_VERSION, drawingId: fileId, fileId,
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 300) : path.basename(sourcePath),
      currentRevision: 1, units: summary.units,
      revisions: [{ revision: 1, path: relative, sha256, units: summary.units, bytes: fs.statSync(target).size, createdAt: now }],
      sourceRefs: [{ kind: 'dxf', path: sourcePath, sha256 }], createdAt: now, updatedAt: now,
    };
    writeJsonAtomic(this.manifestPath(session, fileId), manifest);
    return manifest;
  }

  manifestPath(session: CadFileContext, fileId: string): string {
    return safePath(session, `.tau/cad-drawings/${fileId}/manifest.json`, [], false);
  }

  readManifest(session: CadFileContext, fileId: string): CadDrawingManifestV1 | null {
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
    if (parsed.value.fileId !== fileId || parsed.value.drawingId !== fileId || parsed.value.revisions.some((entry) => entry.path !== `cad/${fileId}/r${entry.revision}.dxf`)) throw serviceError('CAD manifest identity differs.', 409, 'cad.manifest_corrupt');
    return parsed.value;
  }

  resolveInput(session: CadFileContext, request: CadInspectRequestV1 | CadVerifyRequestV1): { relativePath: string; absolutePath: string } {
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
      if (sha256File(absolutePath) !== entry.sha256) throw serviceError('CAD revision checksum changed.', 409, 'cad.checksum');
      return { relativePath: entry.path, absolutePath };
    }
    throw serviceError(`CAD manifest not found: ${request.fileId}`, 404, 'cad.not_found');
  }

}
