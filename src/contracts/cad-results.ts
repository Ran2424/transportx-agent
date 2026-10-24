import { parseCadGeometry } from './cad-geometry.ts';
import { asInteger, asRecord, asString } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';
import { parseCanvasPresentationStructured, type CanvasPresentationV1 } from './canvas.ts';
import { CAD_PROTOCOL, CAD_VERSION } from './version.ts';
import {
  CAD_MAX_HANDLES,
  CAD_MAX_DIAGNOSTICS,
  CAD_MAX_TEXT_LENGTH,
  CAD_ENTITY_TYPES,
  type CadEntityType,
  type CadDiagnostic,
  type CadDrawingRefV1,
  type CadPreviewV1,
  type CadDrawResultV1,
  type CadInspectResultV1,
  type CadVerifyCheck,
  type CadVerifyResultV1,
  type CadParseResult,
} from './cad-types.ts';
import {
  HANDLE,
  finish,
  rejectUnknown,
  checkProtocol,
  requiredText,
  requiredInteger,
  parsePath,
  parseFileId,
  parseLayerName,
  parseUnits,
  parseSha256,
  parseExtents,
  parseStringList,
} from './cad-validation.ts';
import { parseTarget } from './cad-operations.ts';

export const RESULT_KEYS = new Set([
  'protocol', 'version', 'ok', 'dryRun', 'drawing', 'plan', 'preview', 'checks',
  'sourceRefs', 'canvas', 'warnings', 'diagnostics',
]);

export function parseDiagnostic(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadDiagnostic | null {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'CAD diagnostic must be an object.' }));
    return null;
  }
  const code = asString(record.code, 120);
  const message = asString(record.message, 2_000);
  const severity = record.severity;
  const diagPath = record.path === undefined ? undefined : asString(record.path, 1_000);
  const entityHandle = record.entityHandle === undefined ? undefined : asString(record.entityHandle, 16);
  const layer = record.layer === undefined ? undefined : asString(record.layer, 255);
  const details = record.details === undefined ? undefined : asRecord(record.details);
  if (!code || !message || (severity !== 'info' && severity !== 'warning' && severity !== 'error') || (record.path !== undefined && !diagPath) || (record.entityHandle !== undefined && !entityHandle) || (record.layer !== undefined && !layer) || (record.details !== undefined && !details)) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'Invalid CAD diagnostic.' }));
    return null;
  }
  return {
    code,
    severity,
    message,
    ...(diagPath ? { path: diagPath } : {}),
    ...(entityHandle ? { entityHandle } : {}),
    ...(layer ? { layer } : {}),
    ...(details ? { details } : {}),
  };
}

export function parseDiagnosticList(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadDiagnostic[] | null {
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'Expected an array of CAD diagnostics.' }));
    return null;
  }
  if (value.length > CAD_MAX_DIAGNOSTICS) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path, message: `Truncated to ${CAD_MAX_DIAGNOSTICS} diagnostics.`, severity: 'warning' }));
  }
  const items = value.slice(0, CAD_MAX_DIAGNOSTICS).map((item, index) => parseDiagnostic(item, `${path}[${index}]`, diagnostics));
  return items.every((item): item is CadDiagnostic => item !== null) ? items : null;
}

export function parseDrawingRef(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadDrawingRefV1 | null {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'drawing must be an object.' }));
    return null;
  }
  const fileId = parseFileId(record.fileId, `${path}.fileId`, diagnostics);
  const revision = asInteger(record.revision);
  const filePath = parsePath(record.path, `${path}.path`, diagnostics, ['.dxf']);
  const sha256 = parseSha256(record.sha256, `${path}.sha256`, diagnostics);
  const bytes = asInteger(record.bytes);
  if (record.units === undefined) diagnostics.push(diagnostic({ code: 'missing_required_field', path: `${path}.units`, message: 'units is required.' }));
  const units = record.units === undefined ? null : parseUnits(record.units, `${path}.units`, diagnostics);
  const extents = record.extents === null ? null : parseExtents(record.extents, `${path}.extents`, diagnostics);
  const layerCount = asInteger(record.layerCount);
  const entityCount = asInteger(record.entityCount);
  if (revision === null || revision < 0) diagnostics.push(diagnostic({ code: 'out_of_range', path: `${path}.revision`, message: 'revision must be >= 0.' }));
  if (bytes === null || bytes < 0) diagnostics.push(diagnostic({ code: 'out_of_range', path: `${path}.bytes`, message: 'bytes must be >= 0.' }));
  if (layerCount === null || layerCount < 0) diagnostics.push(diagnostic({ code: 'out_of_range', path: `${path}.layerCount`, message: 'layerCount must be >= 0.' }));
  if (entityCount === null || entityCount < 0) diagnostics.push(diagnostic({ code: 'out_of_range', path: `${path}.entityCount`, message: 'entityCount must be >= 0.' }));
  return fileId && revision !== null && revision >= 0 && filePath && sha256 && bytes !== null && bytes >= 0 && units && (record.extents === null || extents) && layerCount !== null && layerCount >= 0 && entityCount !== null && entityCount >= 0
    ? { fileId, revision, path: filePath, sha256, bytes, units, extents, layerCount, entityCount }
    : null;
}

export function parsePreview(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadPreviewV1 | null {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'preview must be an object.' }));
    return null;
  }
  const png = parsePath(record.png, `${path}.png`, diagnostics, ['.png']);
  const pdf = record.pdf === undefined ? undefined : parsePath(record.pdf, `${path}.pdf`, diagnostics, ['.pdf']);
  const width = asInteger(record.width);
  const height = asInteger(record.height);
  const dpi = asInteger(record.dpi);
  if (width === null || width <= 0 || height === null || height <= 0 || dpi === null || dpi <= 0) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path, message: 'width, height and dpi must be positive integers.' }));
  }
  return png && width !== null && width > 0 && height !== null && height > 0 && dpi !== null && dpi > 0 && (record.pdf === undefined || pdf)
    ? { png, ...(pdf ? { pdf } : {}), width, height, dpi }
    : null;
}

export function parseChecks(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadVerifyCheck[] | null {
  if (!Array.isArray(value) || value.length > 200) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path, message: 'checks must be an array with at most 200 items.' }));
    return null;
  }
  const checks: CadVerifyCheck[] = [];
  value.forEach((item, index) => {
    const record = asRecord(item);
    const id = record ? asString(record.id, 120) : null;
    const status = record?.status;
    const message = record ? asString(record.message, 1_000) : null;
    const count = record?.count === undefined ? undefined : asInteger(record?.count);
    if (!record || !id || (status !== 'pass' && status !== 'warning' && status !== 'fail') || !message || (record.count !== undefined && (count === undefined || count === null || count < 0))) {
      diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}[${index}]`, message: 'Invalid CAD verification check.' }));
      return;
    }
    checks.push({ id, status, message, ...(count !== null && count !== undefined ? { count } : {}) });
  });
  return checks.length === value.length ? checks : null;
}

export function parseSourceRefs(value: unknown, path: string, diagnostics: ContractDiagnostic[]): Array<{ kind: 'geojson' | 'dxf'; path: string; sha256: string }> | null {
  if (!Array.isArray(value) || value.length > 16) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path, message: 'sourceRefs must be an array with at most 16 items.' }));
    return null;
  }
  const refs: Array<{ kind: 'geojson' | 'dxf'; path: string; sha256: string }> = [];
  value.forEach((item, index) => {
    const record = asRecord(item);
    const kind = record?.kind;
    const filePath = record ? parsePath(record.path, `${path}[${index}].path`, diagnostics, ['.geojson', '.json', '.dxf']) : null;
    const sha256 = record ? parseSha256(record.sha256, `${path}[${index}].sha256`, diagnostics) : null;
    if (!record || (kind !== 'geojson' && kind !== 'dxf') || !filePath || !sha256) {
      diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}[${index}]`, message: 'Invalid CAD source reference.' }));
      return;
    }
    refs.push({ kind, path: filePath, sha256 });
  });
  return refs.length === value.length ? refs : null;
}

export function parsePlan(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadDrawResultV1['plan'] | null {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'plan must be an object.' }));
    return null;
  }
  const operationCount = asInteger(record.operationCount);
  const matchedCount = asInteger(record.matchedCount);
  const wouldCreate = asInteger(record.wouldCreate);
  const wouldModify = asInteger(record.wouldModify);
  const wouldDelete = asInteger(record.wouldDelete);
  const sampleHandles = record.sampleHandles === undefined
    ? []
    : parseStringList(record.sampleHandles, `${path}.sampleHandles`, diagnostics, CAD_MAX_HANDLES, (item, itemPath) => {
      const handle = asString(item, 16);
      return handle && HANDLE.test(handle) ? handle : null;
    });
  if (operationCount === null || operationCount < 0 || matchedCount === null || matchedCount < 0 || wouldCreate === null || wouldCreate < 0 || wouldModify === null || wouldModify < 0 || wouldDelete === null || wouldDelete < 0 || !sampleHandles) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path, message: 'plan counters must be non-negative integers.' }));
  }
  return operationCount !== null && operationCount >= 0 && matchedCount !== null && matchedCount >= 0 && wouldCreate !== null && wouldCreate >= 0 && wouldModify !== null && wouldModify >= 0 && wouldDelete !== null && wouldDelete >= 0 && sampleHandles
    ? { operationCount, matchedCount, sampleHandles, wouldCreate, wouldModify, wouldDelete }
    : null;
}

export function parseCadDrawResultStructured(value: unknown, diagnostics: ContractDiagnostic[] = []): CadParseResult<CadDrawResultV1> {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'cad', message: 'CAD draw result must be an object.' }));
    return { ok: false, value: null, diagnostics };
  }
  checkProtocol(record, CAD_PROTOCOL, CAD_VERSION, 'cad', diagnostics);
  rejectUnknown(record, RESULT_KEYS, 'cad', diagnostics);
  if (typeof record.ok !== 'boolean') diagnostics.push(diagnostic({ code: 'invalid_type', path: 'cad.ok', message: 'ok must be a boolean.' }));
  if (typeof record.dryRun !== 'boolean') diagnostics.push(diagnostic({ code: 'invalid_type', path: 'cad.dryRun', message: 'dryRun must be a boolean.' }));
  const drawing = record.drawing === undefined ? undefined : parseDrawingRef(record.drawing, 'cad.drawing', diagnostics);
  const plan = record.plan === undefined ? undefined : parsePlan(record.plan, 'cad.plan', diagnostics);
  const preview = record.preview === undefined ? undefined : parsePreview(record.preview, 'cad.preview', diagnostics);
  const checks = record.checks === undefined ? undefined : parseChecks(record.checks, 'cad.checks', diagnostics);
  const sourceRefs = record.sourceRefs === undefined ? undefined : parseSourceRefs(record.sourceRefs, 'cad.sourceRefs', diagnostics);
  const warnings = parseDiagnosticList(record.warnings, 'cad.warnings', diagnostics);
  const resultDiagnostics = parseDiagnosticList(record.diagnostics, 'cad.diagnostics', diagnostics);
  let canvas: CanvasPresentationV1 | undefined;
  if (record.canvas !== undefined) {
    const parsedCanvas = parseCanvasPresentationStructured(record.canvas, diagnostics);
    if (parsedCanvas.ok) canvas = parsedCanvas.value;
  }
  if (typeof record.ok !== 'boolean' || typeof record.dryRun !== 'boolean' || !warnings || !resultDiagnostics || (record.drawing !== undefined && !drawing) || (record.plan !== undefined && !plan) || (record.preview !== undefined && !preview) || (record.checks !== undefined && !checks) || (record.sourceRefs !== undefined && !sourceRefs)) {
    return { ok: false, value: null, diagnostics };
  }
  return finish({
    protocol: CAD_PROTOCOL,
    version: CAD_VERSION,
    ok: record.ok,
    dryRun: record.dryRun,
    ...(drawing ? { drawing } : {}),
    ...(plan ? { plan } : {}),
    ...(preview ? { preview } : {}),
    ...(checks ? { checks } : {}),
    ...(sourceRefs ? { sourceRefs } : {}),
    ...(canvas ? { canvas } : {}),
    warnings,
    diagnostics: resultDiagnostics,
  }, diagnostics);
}

export function parseLayers(value: unknown, path: string, diagnostics: ContractDiagnostic[]): NonNullable<CadInspectResultV1['layers']> | null {
  if (!Array.isArray(value) || value.length > 1_000) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path, message: 'layers must be an array with at most 1000 items.' }));
    return null;
  }
  const layers: NonNullable<CadInspectResultV1['layers']> = [];
  value.forEach((item, index) => {
    const record = asRecord(item);
    const name = record ? parseLayerName(record.name, `${path}[${index}].name`, diagnostics) : null;
    const entityCount = asInteger(record?.entityCount);
    const color = asInteger(record?.color);
    const linetype = record ? asString(record.linetype, 120) : null;
    if (!record || !name || entityCount === null || entityCount < 0 || color === null || color < 0 || color > 256 || !linetype) {
      diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}[${index}]`, message: 'Invalid CAD layer record.' }));
      return;
    }
    layers.push({ name, entityCount, color, linetype });
  });
  return layers.length === value.length ? layers : null;
}

export function parseEntities(value: unknown, path: string, diagnostics: ContractDiagnostic[]): NonNullable<CadInspectResultV1['entities']> | null {
  if (!Array.isArray(value) || value.length > CAD_MAX_HANDLES) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path, message: `entities must contain at most ${CAD_MAX_HANDLES} items.` }));
    return null;
  }
  const entities: NonNullable<CadInspectResultV1['entities']> = [];
  value.forEach((item, index) => {
    const record = asRecord(item);
    const handle = record ? asString(record.handle, 16) : null;
    const type = record ? asString(record.type, 40) : null;
    const layer = record ? parseLayerName(record.layer, `${path}[${index}].layer`, diagnostics) : null;
    const bounds = record?.bounds === undefined ? undefined : parseExtents(record.bounds, `${path}[${index}].bounds`, diagnostics);
    const text = record?.text === undefined ? undefined : asString(record.text, CAD_MAX_TEXT_LENGTH);
    if (!record || !handle || !HANDLE.test(handle) || !type || !(CAD_ENTITY_TYPES as readonly string[]).includes(type) || !layer || (record.bounds !== undefined && !bounds) || (record.text !== undefined && !text)) {
      diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}[${index}]`, message: 'Invalid CAD entity record.' }));
      return;
    }
    const geometry = record.geometry === undefined ? undefined : parseCadGeometry(record.geometry, `${path}[${index}].geometry`, diagnostics);
    if (record.geometryTruncated !== undefined && typeof record.geometryTruncated !== 'boolean') diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'geometryTruncated must be boolean.' }));
    entities.push({ ...(geometry ? { geometry } : {}), ...(record.geometryTruncated === true ? { geometryTruncated: true } : {}), handle, type: type as CadEntityType, layer, ...(bounds ? { bounds } : {}), ...(text ? { text } : {}) });
  });
  return entities.length === value.length ? entities : null;
}

export function parseBlocks(value: unknown, path: string, diagnostics: ContractDiagnostic[]): NonNullable<CadInspectResultV1['blocks']> | null {
  if (!Array.isArray(value) || value.length > 1_000) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path, message: 'blocks must be an array with at most 1000 items.' }));
    return null;
  }
  const blocks: NonNullable<CadInspectResultV1['blocks']> = [];
  value.forEach((item, index) => {
    const record = asRecord(item);
    const name = record ? asString(record.name, 255) : null;
    const entityCount = asInteger(record?.entityCount);
    if (!record || !name || entityCount === null || entityCount < 0) {
      diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}[${index}]`, message: 'Invalid CAD block record.' }));
      return;
    }
    blocks.push({ name, entityCount });
  });
  return blocks.length === value.length ? blocks : null;
}

export function parseTextStyles(value: unknown, path: string, diagnostics: ContractDiagnostic[]): NonNullable<CadInspectResultV1['textStyles']> | null {
  if (!Array.isArray(value) || value.length > 1_000) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path, message: 'textStyles must be an array with at most 1000 items.' }));
    return null;
  }
  const styles: NonNullable<CadInspectResultV1['textStyles']> = [];
  value.forEach((item, index) => {
    const record = asRecord(item);
    const name = record ? asString(record.name, 255) : null;
    const font = record ? asString(record.font, 255) : null;
    if (!record || !name || !font) {
      diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}[${index}]`, message: 'Invalid CAD text style record.' }));
      return;
    }
    styles.push({ name, font });
  });
  return styles.length === value.length ? styles : null;
}

export function parseCadInspectResultStructured(value: unknown, diagnostics: ContractDiagnostic[] = []): CadParseResult<CadInspectResultV1> {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'cad', message: 'CAD inspect result must be an object.' }));
    return { ok: false, value: null, diagnostics };
  }
  checkProtocol(record, CAD_PROTOCOL, CAD_VERSION, 'cad', diagnostics);
  const summaryRecord = asRecord(record.summary);
  const units = summaryRecord?.units === null ? null : summaryRecord ? parseUnits(summaryRecord.units, 'cad.summary.units', diagnostics) : null;
  const extents = summaryRecord?.extents === null ? null : summaryRecord ? parseExtents(summaryRecord.extents, 'cad.summary.extents', diagnostics) : null;
  const layerCount = asInteger(summaryRecord?.layerCount);
  const entityCount = asInteger(summaryRecord?.entityCount);
  const blockCount = asInteger(summaryRecord?.blockCount);
  const sha256 = summaryRecord?.sha256 === undefined ? undefined : parseSha256(summaryRecord.sha256, 'cad.summary.sha256', diagnostics);
  const layers = record.layers === undefined ? undefined : parseLayers(record.layers, 'cad.layers', diagnostics);
  const entities = record.entities === undefined ? undefined : parseEntities(record.entities, 'cad.entities', diagnostics);
  const blocks = record.blocks === undefined ? undefined : parseBlocks(record.blocks, 'cad.blocks', diagnostics);
  const textStyles = record.textStyles === undefined ? undefined : parseTextStyles(record.textStyles, 'cad.textStyles', diagnostics);
  const warnings = parseDiagnosticList(record.warnings, 'cad.warnings', diagnostics);
  const nextCursor = record.nextCursor === undefined ? undefined : asString(record.nextCursor, 160);
  if (!summaryRecord || layerCount === null || layerCount < 0 || entityCount === null || entityCount < 0 || blockCount === null || blockCount < 0 || !warnings || (record.layers !== undefined && !layers) || (record.entities !== undefined && !entities) || (record.blocks !== undefined && !blocks) || (record.textStyles !== undefined && !textStyles) || (record.nextCursor !== undefined && !nextCursor)) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'cad', message: 'Invalid CAD inspect result.' }));
    return { ok: false, value: null, diagnostics };
  }
  const drawingRecord = asRecord(record.drawing);
  const drawing = drawingRecord ? { fileId: parseFileId(drawingRecord.fileId, 'cad.drawing.fileId', diagnostics), revision: requiredInteger(drawingRecord, 'revision', 'cad.drawing', diagnostics, 0), sha256: parseSha256(drawingRecord.sha256, 'cad.drawing.sha256', diagnostics), ...(drawingRecord.sourceCrs ? { sourceCrs: requiredText(drawingRecord, 'sourceCrs', 'cad.drawing', 120, diagnostics) } : {}), ...(drawingRecord.target ? { target: parseTarget(drawingRecord.target, 'cad.drawing.target', diagnostics) } : {}) } : undefined;
  if (record.drawing !== undefined && (!drawing?.fileId || drawing.revision === null || !drawing.sha256 || drawingRecord?.target && !drawing.target)) return { ok: false, value: null, diagnostics };
  return finish({
    ...(drawing ? { drawing: drawing as NonNullable<CadInspectResultV1['drawing']> } : {}),
    protocol: CAD_PROTOCOL,
    version: CAD_VERSION,
    summary: {
      units: units ?? null,
      extents: extents ?? null,
      layerCount,
      entityCount,
      blockCount,
      ...(sha256 ? { sha256 } : {}),
    },
    ...(layers ? { layers } : {}),
    ...(entities ? { entities } : {}),
    ...(blocks ? { blocks } : {}),
    ...(textStyles ? { textStyles } : {}),
    ...(nextCursor ? { nextCursor } : {}),
    warnings,
  }, diagnostics);
}

export function parseCadVerifyResultStructured(value: unknown, diagnostics: ContractDiagnostic[] = []): CadParseResult<CadVerifyResultV1> {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'cad', message: 'CAD verify result must be an object.' }));
    return { ok: false, value: null, diagnostics };
  }
  checkProtocol(record, CAD_PROTOCOL, CAD_VERSION, 'cad', diagnostics);
  const preview = record.preview === undefined ? undefined : parsePreview(record.preview, 'cad.preview', diagnostics);
  const checks = parseChecks(record.checks, 'cad.checks', diagnostics);
  const resultDiagnostics = parseDiagnosticList(record.diagnostics, 'cad.diagnostics', diagnostics);
  if (typeof record.ok !== 'boolean' || !checks || !resultDiagnostics || (record.preview !== undefined && !preview)) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'cad', message: 'Invalid CAD verify result.' }));
    return { ok: false, value: null, diagnostics };
  }
  return finish({
    protocol: CAD_PROTOCOL,
    version: CAD_VERSION,
    ok: record.ok,
    checks,
    ...(preview ? { preview } : {}),
    diagnostics: resultDiagnostics,
  }, diagnostics);
}
