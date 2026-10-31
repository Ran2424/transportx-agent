import { parsePreviewOptions } from './cad-preview.ts';
import { asRecord, asString, type JsonRecord } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';

import { CAD_PROTOCOL, CAD_VERSION } from './version.ts';
import {
  type CadDrawRequestV1,
  type CadInspectRequestV1,
  type CadVerifyRequestV1,
  type CadParseResult,
} from './cad-types.ts';
import {
  finish,
  rejectUnknown,
  checkProtocol,
  requiredText,
  optionalText,
  optionalBoolean,
  optionalInteger,
  requiredInteger,
  parsePath,
  parseFileId,
  parseLayerName,
  parseUnits,
  parseSha256,
  parseStringList,
} from './cad-validation.ts';
import { parseLayerMap, parseTarget, parseSelector, parseOperations } from './cad-operations.ts';

export const COMMON_REQUEST_KEYS = ['protocol', 'version', 'kind'] as const;
export const DRAW_FROM_GEOJSON_KEYS = new Set([
  ...COMMON_REQUEST_KEYS, 'fileId', 'sourcePath', 'target', 'units', 'layerKey',
  'layerMap', 'labelField', 'labelLayer', 'fillLayers', 'repairInvalid',
  'title', 'dryRun', 'sourceCrs', 'exportPreview',
]);
export const DRAW_EDIT_KEYS = new Set([
  ...COMMON_REQUEST_KEYS, 'fileId', 'baseRevision', 'expectedSha256', 'contextId', 'operations', 'units', 'dryRun', 'exportPreview',
]);
export const DRAW_IMPORT_KEYS = new Set([
  ...COMMON_REQUEST_KEYS, 'sourcePath', 'fileId', 'title', 'units', 'dryRun', 'exportPreview',
]);
export const INSPECT_KEYS = new Set([
  'protocol', 'version', 'fileId', 'path', 'include', 'selector', 'limit', 'cursor',
]);
export const VERIFY_KEYS = new Set([
  'protocol', 'version', 'fileId', 'path', 'revision', 'policy', 'exportPreview', 'previewOptions',
]);
export function parseInputRef(record: JsonRecord, diagnostics: ContractDiagnostic[], extensions: string[]): { fileId?: string; path?: string } | null {
  const hasFileId = record.fileId !== undefined;
  const hasPath = record.path !== undefined;
  if (hasFileId === hasPath) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'cad', message: 'Exactly one of fileId or path is required.' }));
    return null;
  }
  if (hasFileId) {
    const fileId = parseFileId(record.fileId, 'cad.fileId', diagnostics);
    return fileId ? { fileId } : null;
  }
  const filePath = parsePath(record.path, 'cad.path', diagnostics, extensions);
  return filePath ? { path: filePath } : null;
}

export function parseCadDrawRequestStructured(value: unknown, diagnostics: ContractDiagnostic[] = []): CadParseResult<CadDrawRequestV1> {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'cad', message: 'CAD draw request must be an object.' }));
    return { ok: false, value: null, diagnostics };
  }
  checkProtocol(record, CAD_PROTOCOL, CAD_VERSION, 'cad', diagnostics);
  const kind = asString(record.kind, 40);
  if (kind !== 'from-geojson' && kind !== 'edit' && kind !== 'import' && kind !== 'commit-candidate') {
    diagnostics.push(diagnostic({ code: 'unsupported_value', path: 'cad.kind', message: 'kind must be from-geojson, edit, import or commit-candidate.' }));
    return { ok: false, value: null, diagnostics };
  }

  if (kind === 'from-geojson') {
    rejectUnknown(record, DRAW_FROM_GEOJSON_KEYS, 'cad', diagnostics);
    const sourcePath = parsePath(record.sourcePath, 'cad.sourcePath', diagnostics, ['.geojson', '.json']);
    const sourceCrs = requiredText(record, 'sourceCrs', 'cad', 120, diagnostics);
    const target = parseTarget(record.target, 'cad.target', diagnostics);
    const layerMap = parseLayerMap(record.layerMap, 'cad.layerMap', diagnostics);
    const units = record.units === undefined ? 'm' : parseUnits(record.units, 'cad.units', diagnostics);
    if (units !== 'm') diagnostics.push(diagnostic({ code: 'unsupported_value', path: 'cad.units', message: 'from-geojson v1 only supports metres.' }));
    const fileId = record.fileId === undefined ? undefined : parseFileId(record.fileId, 'cad.fileId', diagnostics);
    const layerKey = optionalText(record, 'layerKey', 'cad', 120, diagnostics);
    const labelField = optionalText(record, 'labelField', 'cad', 120, diagnostics);
    const labelLayer = record.labelLayer === undefined ? undefined : parseLayerName(record.labelLayer, 'cad.labelLayer', diagnostics);
    const fillLayers = record.fillLayers === undefined ? undefined : parseStringList(record.fillLayers, 'cad.fillLayers', diagnostics, 64, (item, itemPath) => parseLayerName(item, itemPath, diagnostics));
    const repairInvalid = optionalBoolean(record, 'repairInvalid', 'cad', diagnostics);
    const title = optionalText(record, 'title', 'cad', 300, diagnostics);
    const dryRun = optionalBoolean(record, 'dryRun', 'cad', diagnostics) ?? false;
    const exportPreview = optionalBoolean(record, 'exportPreview', 'cad', diagnostics);
    if (!sourcePath || !sourceCrs || !target || !layerMap || units !== 'm' || (record.fileId !== undefined && !fileId) || (record.fillLayers !== undefined && !fillLayers)) return { ok: false, value: null, diagnostics };
    return finish({
      protocol: CAD_PROTOCOL,
      version: CAD_VERSION,
      kind,
      ...(fileId ? { fileId } : {}),
      sourcePath,
      sourceCrs,
      target,
      units: 'm',
      ...(layerKey ? { layerKey } : {}),
      layerMap,
      ...(labelField ? { labelField } : {}),
      ...(labelLayer ? { labelLayer } : {}),
      ...(fillLayers ? { fillLayers } : {}),
      ...(repairInvalid !== undefined ? { repairInvalid } : {}),
      ...(title ? { title } : {}),
      dryRun,
      ...(exportPreview !== undefined ? { exportPreview } : {}),
    }, diagnostics);
  }

  if (kind === 'commit-candidate') {
    rejectUnknown(record, new Set([...COMMON_REQUEST_KEYS, 'fileId', 'sourcePath', 'baseRevision', 'expectedSha256', 'candidateMode', 'dryRun', 'exportPreview']), 'cad', diagnostics);
    const fileId = parseFileId(record.fileId, 'cad.fileId', diagnostics);
    const sourcePath = parsePath(record.sourcePath, 'cad.sourcePath', diagnostics, ['.dxf']);
    const baseRevision = requiredInteger(record, 'baseRevision', 'cad', diagnostics, 1);
    const expectedSha256 = parseSha256(record.expectedSha256, 'cad.expectedSha256', diagnostics);
    const candidateMode = record.candidateMode;
    if (candidateMode !== 'rebuild' && candidateMode !== 'based-on-current') diagnostics.push(diagnostic({ code: 'unsupported_value', path: 'cad.candidateMode', message: 'Declare rebuild or based-on-current. Old contexts must be queried again in either mode.' }));
    const dryRun = optionalBoolean(record, 'dryRun', 'cad', diagnostics) ?? false;
    const exportPreview = optionalBoolean(record, 'exportPreview', 'cad', diagnostics);
    if (!fileId || !sourcePath || !expectedSha256 || baseRevision === null || (candidateMode !== 'rebuild' && candidateMode !== 'based-on-current')) return { ok: false, value: null, diagnostics };
    return finish({ protocol: CAD_PROTOCOL, version: CAD_VERSION, kind, fileId, sourcePath, baseRevision, expectedSha256, candidateMode, dryRun, ...(exportPreview !== undefined ? { exportPreview } : {}) }, diagnostics);
  }

  if (kind === 'edit') {
    rejectUnknown(record, DRAW_EDIT_KEYS, 'cad', diagnostics);
    const fileId = parseFileId(record.fileId, 'cad.fileId', diagnostics);
    const baseRevision = requiredInteger(record, 'baseRevision', 'cad', diagnostics, 0);
    const expectedSha256 = parseSha256(record.expectedSha256, 'cad.expectedSha256', diagnostics);
    const contextId = optionalText(record, 'contextId', 'cad', 100, diagnostics);
    if (contextId && !/^canvas_context_[a-f0-9-]+$/.test(contextId)) diagnostics.push(diagnostic({ code: 'unsafe_value', path: 'cad.contextId', message: 'Invalid Canvas context ID.' }));
    const operations = parseOperations(record.operations, 'cad.operations', diagnostics);
    const units = record.units === undefined ? undefined : parseUnits(record.units, 'cad.units', diagnostics);
    const dryRun = optionalBoolean(record, 'dryRun', 'cad', diagnostics) ?? false;
    const exportPreview = optionalBoolean(record, 'exportPreview', 'cad', diagnostics);
    if (!fileId || !expectedSha256 || baseRevision === null || !operations || (record.units !== undefined && !units)) return { ok: false, value: null, diagnostics };
    return finish({
      protocol: CAD_PROTOCOL,
      version: CAD_VERSION,
      kind,
      fileId,
      baseRevision,
      expectedSha256,
      ...(contextId ? { contextId } : {}),
      operations,
      ...(units ? { units } : {}),
      dryRun,
      ...(exportPreview !== undefined ? { exportPreview } : {}),
    }, diagnostics);
  }

  rejectUnknown(record, DRAW_IMPORT_KEYS, 'cad', diagnostics);
  const sourcePath = parsePath(record.sourcePath, 'cad.sourcePath', diagnostics, ['.dxf']);
  const fileId = record.fileId === undefined ? undefined : parseFileId(record.fileId, 'cad.fileId', diagnostics);
  const title = optionalText(record, 'title', 'cad', 300, diagnostics);
  const units = record.units === undefined ? undefined : parseUnits(record.units, 'cad.units', diagnostics);
  const dryRun = optionalBoolean(record, 'dryRun', 'cad', diagnostics) ?? false;
    const exportPreview = optionalBoolean(record, 'exportPreview', 'cad', diagnostics);
  if (!sourcePath || (record.fileId !== undefined && !fileId) || (record.units !== undefined && !units)) return { ok: false, value: null, diagnostics };
  return finish({
    protocol: CAD_PROTOCOL,
    version: CAD_VERSION,
    kind: 'import',
    sourcePath,
    ...(fileId ? { fileId } : {}),
    ...(title ? { title } : {}),
    ...(units ? { units } : {}),
    dryRun,
    ...(exportPreview !== undefined ? { exportPreview } : {}),
  }, diagnostics);
}

export function parseCadInspectRequestStructured(value: unknown, diagnostics: ContractDiagnostic[] = []): CadParseResult<CadInspectRequestV1> {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'cad', message: 'CAD inspect request must be an object.' }));
    return { ok: false, value: null, diagnostics };
  }
  checkProtocol(record, CAD_PROTOCOL, CAD_VERSION, 'cad', diagnostics);
  rejectUnknown(record, INSPECT_KEYS, 'cad', diagnostics);
  const reference = parseInputRef(record, diagnostics, ['.dxf']);
  const includeValues = ['summary', 'layers', 'entities', 'blocks', 'units', 'extents', 'textStyles', 'geometry'] as const;
  const include = record.include === undefined
    ? ['summary'] as CadInspectRequestV1['include']
    : parseStringList(record.include, 'cad.include', diagnostics, includeValues.length, (item, itemPath) => {
      const text = asString(item, 40);
      if (!text || !(includeValues as readonly string[]).includes(text)) {
        diagnostics.push(diagnostic({ code: 'unsupported_value', path: itemPath, message: 'Unsupported inspect include value.' }));
        return null;
      }
      return text;
    }) as CadInspectRequestV1['include'] | null;
  const selector = record.selector === undefined ? undefined : parseSelector(record.selector, 'cad.selector', diagnostics);
  const limit = record.limit === undefined ? 500 : optionalInteger(record, 'limit', 'cad', diagnostics, 1);
  const cursor = optionalText(record, 'cursor', 'cad', 160, diagnostics);
  if (!reference || !include || (record.selector !== undefined && !selector) || limit === undefined || limit > 500) {
    if (limit !== undefined && limit > 500) diagnostics.push(diagnostic({ code: 'out_of_range', path: 'cad.limit', message: 'limit must be <= 500.' }));
    return { ok: false, value: null, diagnostics };
  }
  return finish({
    protocol: CAD_PROTOCOL,
    version: CAD_VERSION,
    ...reference,
    include,
    ...(selector ? { selector } : {}),
    limit,
    ...(cursor ? { cursor } : {}),
  }, diagnostics);
}

export function parseCadVerifyRequestStructured(value: unknown, diagnostics: ContractDiagnostic[] = []): CadParseResult<CadVerifyRequestV1> {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'cad', message: 'CAD verify request must be an object.' }));
    return { ok: false, value: null, diagnostics };
  }
  checkProtocol(record, CAD_PROTOCOL, CAD_VERSION, 'cad', diagnostics);
  rejectUnknown(record, VERIFY_KEYS, 'cad', diagnostics);
  const reference = parseInputRef(record, diagnostics, ['.dxf']);
  const revision = optionalInteger(record, 'revision', 'cad', diagnostics, 0);
  const exportPreview = optionalBoolean(record, 'exportPreview', 'cad', diagnostics);
  const previewOptions = record.previewOptions === undefined ? undefined : parsePreviewOptions(record.previewOptions, diagnostics);
  if (record.previewOptions !== undefined && record.exportPreview !== true) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'cad.previewOptions', message: 'previewOptions requires exportPreview=true.' }));
  const policy = record.policy === undefined ? 'basic' : record.policy;
  if (policy !== 'basic' && policy !== 'traffic-v1' && policy !== 'strict') {
    diagnostics.push(diagnostic({ code: 'unsupported_value', path: 'cad.policy', message: 'policy must be basic, traffic-v1 or strict.' }));
  }
  if (record.revision !== undefined && record.fileId === undefined) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'cad.revision', message: 'revision requires fileId.' }));
  }
  if (!reference || (record.revision !== undefined && revision === undefined) || (policy !== 'basic' && policy !== 'traffic-v1' && policy !== 'strict')) return { ok: false, value: null, diagnostics };
  return finish({
    protocol: CAD_PROTOCOL,
    version: CAD_VERSION,
    ...reference,
    ...(revision !== undefined ? { revision } : {}),
    policy,
    ...(previewOptions ? { previewOptions } : {}),
    ...(exportPreview !== undefined ? { exportPreview } : {}),
  }, diagnostics);
}
