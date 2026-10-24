const fs = require('node:fs');
const path = require('node:path');

import type { PiRpcSession } from '../sessions.js';

import { sha256File } from '../asset-integrity.js';
import { relativePosixPath } from '../util/path.js';
import { canonicalToolSchema } from '../../contracts/tool-interface.js';
import { writeJsonAtomic } from '../util/json-storage.js';
import {
  CAD_DRAWING_PROTOCOL,
  CAD_DRAWING_VERSION,
  diagnosticMessage,
  parseCadDrawResultStructured,
  parseCadDrawingManifestStructured,
  type CadDrawRequestV1,
  type CadDrawResultV1,
  type CadDrawingManifestV1,
} from '../../contracts/index.js';

import { CadDrawingStore, safePath, jobArtifact, serviceError } from './files.js';

function requestTitle(request: CadDrawRequestV1) { return 'title' in request ? request.title : undefined; }
function requestTarget(request: CadDrawRequestV1) { return 'target' in request ? request.target : undefined; }

export class CadCommit {
  constructor(private store: CadDrawingStore) {}
  verifyCommitted(session: PiRpcSession, result: CadDrawResultV1): CadDrawResultV1 {
    const parsed = parseCadDrawResultStructured(result);
    if (!parsed.ok || !parsed.value.ok || parsed.value.dryRun || !parsed.value.drawing) throw serviceError('Unconfirmed CAD result.', 409, 'cad_result_unknown');
    const drawing = parsed.value.drawing;
    const manifest = this.store.readManifest(session, drawing.fileId);
    const entry = manifest?.revisions.find((item) => item.revision === drawing.revision);
    if (!entry || entry.path !== drawing.path || entry.sha256 !== drawing.sha256 || entry.bytes !== drawing.bytes || sha256File(safePath(session, entry.path, ['.dxf'])) !== entry.sha256) throw serviceError('CAD committed revision could not be verified.', 409, 'cad_result_unknown');
    return parsed.value;
  }

  recover(session: PiRpcSession, operationId: string, request: CadDrawRequestV1): { state: 'succeeded'; result: CadDrawResultV1 } | { state: 'failed' | 'unknown' } {
    const jobDir = safePath(session, `.tau/cad-jobs/${operationId}`, [], false);
    const journalPath = safePath(session, `.tau/cad-jobs/${operationId}/commit.json`, [], false);
    if (!fs.existsSync(journalPath)) return { state: 'unknown' };
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    if (canonicalToolSchema(request, 'data') !== canonicalToolSchema(journal.request, 'data')) return { state: 'unknown' };
    const parsed = parseCadDrawResultStructured(journal.result);
    const manifest = parseCadDrawingManifestStructured(journal.manifest);
    if (!parsed.ok || !parsed.value.drawing || !manifest.ok || !Array.isArray(journal.artifacts)) return { state: 'unknown' };
    const current = this.store.readManifest(session, parsed.value.drawing.fileId);
    if (current?.revisions.some((item) => item.revision === parsed.value.drawing!.revision)) {
      const result = this.verifyCommitted(session, parsed.value);
      for (const artifact of journal.artifacts) if (sha256File(safePath(session, artifact.path)) !== artifact.sha256) return { state: 'unknown' };
      return { state: 'succeeded', result };
    }
    // A fully staged journal proves the engine stopped. Roll back only this
    // generation, only while the authoritative manifest is still its parent.
    if (canonicalToolSchema(current, 'data') !== canonicalToolSchema(journal.previous, 'data')) return { state: 'unknown' };
    for (const artifact of journal.artifacts) {
      if (!/^cad\/[A-Za-z0-9._-]+\/r[0-9]+\.(dxf|png|pdf)$/.test(artifact.path) || artifact.path !== `cad/${manifest.value.fileId}/r${manifest.value.currentRevision}.${artifact.path.split('.').at(-1)}`) return { state: 'unknown' };
      const file = safePath(session, artifact.path, [], false);
      if (fs.existsSync(file) && sha256File(safePath(session, artifact.path)) !== artifact.sha256) return { state: 'unknown' };
    }
    for (const artifact of journal.artifacts) fs.rmSync(safePath(session, artifact.path, [], false), { force: true });
    fs.rmSync(jobDir, { recursive: true, force: true });
    return { state: 'failed' };
  }

  finalize(session: PiRpcSession, operationId: string) {
    fs.rmSync(safePath(session, `.tau/cad-jobs/${operationId}`, [], false), { recursive: true, force: true });
  }

  commit(
    session: PiRpcSession,
    fileId: string,
    request: CadDrawRequestV1,
    previous: CadDrawingManifestV1 | null,
    result: CadDrawResultV1,
    jobDir: string,
  ): CadDrawResultV1 {
    const drawing = result.drawing;
    if (!drawing) throw serviceError('CAD engine returned no drawing.', 502, 'cad.engine_result');
    const expectedRevision = request.kind === 'edit' || request.kind === 'commit-candidate' ? request.baseRevision + 1 : 1;
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
      units: drawing.units,
      ...(previous?.revisions.length ? { parentSha256: previous.revisions[previous.revisions.length - 1].sha256 } : {}),
      ...(result.plan ? { operationCount: result.plan.operationCount } : {}),
      createdAt: now,
    }];
    const target = requestTarget(request);
    const sourceCrs = request.kind === 'from-geojson' ? request.sourceCrs : previous?.sourceCrs;
    const sources = request.kind === 'commit-candidate'
      ? [...new Map([...(previous?.sourceRefs || []), ...(result.sourceRefs || [])].map((source) => [source.path, source])).values()]
      : result.sourceRefs || previous?.sourceRefs;
    const sourceRefs = sources && sources.length > 16 ? [sources[0], ...sources.slice(-15)] : sources;
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
      ...(sourceRefs ? { sourceRefs } : {}),
      createdAt: previous?.createdAt || now,
      updatedAt: now,
    };
    const parsedManifest = parseCadDrawingManifestStructured(manifest);
    if (!parsedManifest.ok) throw serviceError(parsedManifest.diagnostics.map(diagnosticMessage).join('; '), 500, 'cad.manifest_invalid');

    const committed = result;
    for (const artifact of artifacts) if (fs.existsSync(artifact.final)) throw serviceError('CAD output already exists.', 409, 'cad.file_exists');
    writeJsonAtomic(path.join(jobDir, 'commit.json'), { request, previous, manifest: parsedManifest.value, result: committed, artifacts: artifacts.map((artifact) => ({ path: relativePosixPath(fs.realpathSync(session.cwd), artifact.final), sha256: sha256File(artifact.temp) })) });
    // The manifest is the commit point. A journal is retained until the durable execution confirmation is saved.
    for (const artifact of artifacts) {
      if (fs.existsSync(artifact.final)) throw serviceError('CAD output already exists.', 409, 'cad.file_exists');
      fs.mkdirSync(path.dirname(artifact.final), { recursive: true });
      fs.renameSync(artifact.temp, artifact.final);
    }
    writeJsonAtomic(this.store.manifestPath(session, fileId), parsedManifest.value);
    return committed;
  }
}
