import { asInteger, asRecord } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';

import { CAD_DRAWING_PROTOCOL, CAD_DRAWING_VERSION } from './version.ts';
import { type CadDrawingManifestV1, type CadParseResult } from './cad-types.ts';
import {
  finish,
  checkProtocol,
  requiredText,
  optionalText,
  requiredInteger,
  parseTimestamp,
  parsePath,
  parseFileId,
  parseUnits,
  parseSha256,
} from './cad-validation.ts';
import { parseTarget } from './cad-operations.ts';
import { parseSourceRefs } from './cad-results.ts';

export function parseCadDrawingManifestStructured(value: unknown, diagnostics: ContractDiagnostic[] = []): CadParseResult<CadDrawingManifestV1> {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'cad', message: 'CAD drawing manifest must be an object.' }));
    return { ok: false, value: null, diagnostics };
  }
  checkProtocol(record, CAD_DRAWING_PROTOCOL, CAD_DRAWING_VERSION, 'cad', diagnostics);
  const drawingId = requiredText(record, 'drawingId', 'cad', 64, diagnostics);
  const fileId = parseFileId(record.fileId, 'cad.fileId', diagnostics);
  const title = requiredText(record, 'title', 'cad', 300, diagnostics);
  const currentRevision = requiredInteger(record, 'currentRevision', 'cad', diagnostics, 0);
  if (record.units === undefined) diagnostics.push(diagnostic({ code: 'missing_required_field', path: 'cad.units', message: 'units is required.' }));
  const units = record.units === undefined || record.units === null ? null : parseUnits(record.units, 'cad.units', diagnostics);
  const sourceCrs = optionalText(record, 'sourceCrs', 'cad', 120, diagnostics);
  const target = record.target === undefined ? undefined : parseTarget(record.target, 'cad.target', diagnostics);
  const transform = record.transform === undefined ? undefined : asRecord(record.transform);
  if (record.transform !== undefined && !transform) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'cad.transform', message: 'transform must be an object.' }));
  const sourceRefs = record.sourceRefs === undefined ? undefined : parseSourceRefs(record.sourceRefs, 'cad.sourceRefs', diagnostics);
  const createdAt = parseTimestamp(record.createdAt, 'cad.createdAt', diagnostics);
  const updatedAt = parseTimestamp(record.updatedAt, 'cad.updatedAt', diagnostics);
  if (!Array.isArray(record.revisions) || record.revisions.length === 0 || record.revisions.length > 10_000) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path: 'cad.revisions', message: 'revisions must contain 1..10000 items.' }));
    return { ok: false, value: null, diagnostics };
  }
  const revisions: CadDrawingManifestV1['revisions'] = [];
  record.revisions.forEach((item, index) => {
    const revisionRecord = asRecord(item);
    const revision = asInteger(revisionRecord?.revision);
    const filePath = revisionRecord ? parsePath(revisionRecord.path, `cad.revisions[${index}].path`, diagnostics, ['.dxf']) : null;
    const sha256 = revisionRecord ? parseSha256(revisionRecord.sha256, `cad.revisions[${index}].sha256`, diagnostics) : null;
    const bytes = asInteger(revisionRecord?.bytes);
    const revisionUnits = revisionRecord?.units === undefined || revisionRecord.units === null ? revisionRecord?.units : parseUnits(revisionRecord.units, `cad.revisions[${index}].units`, diagnostics);
    const parentSha256 = revisionRecord?.parentSha256 === undefined ? undefined : parseSha256(revisionRecord.parentSha256, `cad.revisions[${index}].parentSha256`, diagnostics);
    const operationCount = revisionRecord?.operationCount === undefined ? undefined : asInteger(revisionRecord.operationCount);
    const revisionCreatedAt = revisionRecord ? parseTimestamp(revisionRecord.createdAt, `cad.revisions[${index}].createdAt`, diagnostics) : null;
    if (!revisionRecord || revision === null || revision < 0 || !filePath || !sha256 || bytes === null || bytes < 0 || (revisionRecord.parentSha256 !== undefined && !parentSha256) || (revisionRecord.operationCount !== undefined && (operationCount === undefined || operationCount === null || operationCount < 0)) || !revisionCreatedAt) {
      diagnostics.push(diagnostic({ code: 'invalid_type', path: `cad.revisions[${index}]`, message: 'Invalid CAD revision record.' }));
      return;
    }
    revisions.push({
      revision,
      path: filePath,
      sha256,
      bytes,
      ...(revisionUnits !== undefined ? { units: revisionUnits } : {}),
      ...(parentSha256 ? { parentSha256 } : {}),
      ...(operationCount !== null && operationCount !== undefined ? { operationCount } : {}),
      createdAt: revisionCreatedAt,
    });
  });
  if (!drawingId || !fileId || !title || currentRevision === null || currentRevision < 0 || (record.units !== null && !units) || !createdAt || !updatedAt || (record.sourceCrs !== undefined && !sourceCrs) || (record.target !== undefined && !target) || (record.transform !== undefined && !transform) || (record.sourceRefs !== undefined && !sourceRefs) || revisions.length !== record.revisions.length) {
    return { ok: false, value: null, diagnostics };
  }
  if (currentRevision !== revisions[revisions.length - 1].revision) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path: 'cad.currentRevision', message: 'currentRevision must equal the last revision.' }));
    return { ok: false, value: null, diagnostics };
  }
  for (let index = 1; index < revisions.length; index += 1) {
    if (revisions[index].revision <= revisions[index - 1].revision) {
      diagnostics.push(diagnostic({ code: 'out_of_range', path: `cad.revisions[${index}].revision`, message: 'revisions must be strictly increasing.' }));
      return { ok: false, value: null, diagnostics };
    }
  }
  return finish({
    protocol: CAD_DRAWING_PROTOCOL,
    version: CAD_DRAWING_VERSION,
    drawingId,
    fileId,
    title,
    currentRevision,
    revisions,
    units,
    ...(sourceCrs ? { sourceCrs } : {}),
    ...(target ? { target } : {}),
    ...(transform ? { transform } : {}),
    ...(sourceRefs ? { sourceRefs } : {}),
    createdAt,
    updatedAt,
  }, diagnostics);
}
