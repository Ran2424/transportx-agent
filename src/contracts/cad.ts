/**
 * CAD drawing contracts.
 *
 * These types cross the Pi Extension, the Host CAD Service and the Python
 * engine. The Host remains authoritative; the engine output is parsed again
 * before it is committed to the session.
 */
import { asFiniteNumber, asInteger, asRecord, asString, type JsonRecord } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';
import { parseCanvasPresentationStructured, type CanvasPresentationV1 } from './canvas.ts';
import {
  CAD_DRAWING_PROTOCOL,
  CAD_DRAWING_VERSION,
  CAD_PROTOCOL,
  CAD_VERSION,
} from './version.ts';

export const CAD_MAX_OPERATIONS = 200;
export const CAD_MAX_MATCHED = 5_000;
export const CAD_MAX_HANDLES = 500;
export const CAD_MAX_DIAGNOSTICS = 200;
export const CAD_MAX_POINTS = 10_000;
export const CAD_MAX_TEXT_LENGTH = 500;
export const CAD_MAX_INPUT_BYTES = 50 * 1024 * 1024;
export const CAD_MAX_ENTITY_COUNT = 20_000;
export const CAD_MAX_PATH_LENGTH = 1_000;

export const CAD_ENTITY_TYPES = [
  'LINE',
  'LWPOLYLINE',
  'POLYLINE',
  'CIRCLE',
  'ARC',
  'TEXT',
  'MTEXT',
  'POINT',
  'INSERT',
  'HATCH',
] as const;

export type CadEntityType = typeof CAD_ENTITY_TYPES[number];
export type CadUnits = 'm' | 'mm';
export type CadPoint2 = [number, number];

export type CadTarget =
  | { kind: 'epsg'; code: string }
  | { kind: 'local'; origin: CadPoint2; rotationDeg: number; scale: number };

export type CadSelector =
  | { kind: 'handle'; handle: string }
  | { kind: 'layer'; layer: string; entityType?: CadEntityType }
  | { kind: 'bounds'; layer?: string; entityType?: CadEntityType; min: CadPoint2; max: CadPoint2 };

export type CadOperation =
  | { op: 'move'; selector: CadSelector; dx: number; dy: number }
  | { op: 'copy'; selector: CadSelector; dx: number; dy: number; count?: number }
  | { op: 'delete'; selector: CadSelector }
  | { op: 'setLayer'; selector: CadSelector; layer: string }
  | { op: 'drawPolyline'; layer: string; points: CadPoint2[]; closed?: boolean }
  | { op: 'drawText'; layer: string; position: CadPoint2; text: string; height: number; rotationDeg?: number }
  | { op: 'drawHatch'; layer: string; boundary: CadPoint2[] }
  | { op: 'insertBlock'; layer: string; name: string; position: CadPoint2; rotationDeg?: number; scale?: number };

export type CadDrawRequestV1 =
  | {
      protocol: typeof CAD_PROTOCOL;
      version: typeof CAD_VERSION;
      kind: 'from-geojson';
      fileId?: string;
      sourcePath: string;
      target: CadTarget;
      units: 'm';
      layerKey?: string;
      layerMap: Record<string, string>;
      labelField?: string;
      labelLayer?: string;
      fillLayers?: string[];
      repairInvalid?: boolean;
      template?: string;
      title?: string;
      dryRun: boolean;
    }
  | {
      protocol: typeof CAD_PROTOCOL;
      version: typeof CAD_VERSION;
      kind: 'edit';
      fileId: string;
      baseRevision: number;
      operations: CadOperation[];
      units?: CadUnits;
      dryRun: boolean;
    }
  | {
      protocol: typeof CAD_PROTOCOL;
      version: typeof CAD_VERSION;
      kind: 'import';
      sourcePath: string;
      fileId?: string;
      title?: string;
      units?: CadUnits;
      dryRun: boolean;
    };

export type CadInspectRequestV1 = {
  protocol: typeof CAD_PROTOCOL;
  version: typeof CAD_VERSION;
  fileId?: string;
  path?: string;
  include: Array<'summary' | 'layers' | 'entities' | 'blocks' | 'units' | 'extents' | 'textStyles'>;
  selector?: CadSelector;
  limit: number;
  cursor?: string;
};

export type CadVerifyRequestV1 = {
  protocol: typeof CAD_PROTOCOL;
  version: typeof CAD_VERSION;
  fileId?: string;
  path?: string;
  revision?: number;
  policy: 'traffic-v1' | 'strict';
};

export type CadDiagnostic = {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  path?: string;
  entityHandle?: string;
  layer?: string;
  details?: Record<string, unknown>;
};

export type CadDrawingRefV1 = {
  fileId: string;
  revision: number;
  path: string;
  sha256: string;
  bytes: number;
  units: CadUnits;
  extents: { min: CadPoint2; max: CadPoint2 } | null;
  layerCount: number;
  entityCount: number;
};

export type CadPreviewV1 = {
  png: string;
  pdf?: string;
  width: number;
  height: number;
  dpi: number;
};

export type CadDrawResultV1 = {
  protocol: typeof CAD_PROTOCOL;
  version: typeof CAD_VERSION;
  ok: boolean;
  dryRun: boolean;
  drawing?: CadDrawingRefV1;
  plan?: {
    operationCount: number;
    matchedCount: number;
    sampleHandles: string[];
    wouldCreate: number;
    wouldModify: number;
    wouldDelete: number;
  };
  preview?: CadPreviewV1;
  checks?: CadVerifyCheck[];
  sourceRefs?: Array<{ kind: 'geojson' | 'dxf'; path: string; sha256: string }>;
  canvas?: CanvasPresentationV1;
  warnings: CadDiagnostic[];
  diagnostics: CadDiagnostic[];
};

export type CadInspectResultV1 = {
  protocol: typeof CAD_PROTOCOL;
  version: typeof CAD_VERSION;
  summary: {
    units: CadUnits | null;
    extents: { min: CadPoint2; max: CadPoint2 } | null;
    layerCount: number;
    entityCount: number;
    blockCount: number;
    sha256?: string;
  };
  layers?: Array<{ name: string; entityCount: number; color: number; linetype: string }>;
  entities?: Array<{
    handle: string;
    type: CadEntityType;
    layer: string;
    bounds?: { min: CadPoint2; max: CadPoint2 };
    text?: string;
  }>;
  blocks?: Array<{ name: string; entityCount: number }>;
  textStyles?: Array<{ name: string; font: string }>;
  nextCursor?: string;
  warnings: CadDiagnostic[];
};

export type CadVerifyCheck = {
  id: string;
  status: 'pass' | 'warning' | 'fail';
  message: string;
  count?: number;
};

export type CadVerifyResultV1 = {
  protocol: typeof CAD_PROTOCOL;
  version: typeof CAD_VERSION;
  ok: boolean;
  checks: CadVerifyCheck[];
  diagnostics: CadDiagnostic[];
};

export type CadDrawingManifestV1 = {
  protocol: typeof CAD_DRAWING_PROTOCOL;
  version: typeof CAD_DRAWING_VERSION;
  drawingId: string;
  fileId: string;
  title: string;
  currentRevision: number;
  revisions: Array<{
    revision: number;
    path: string;
    sha256: string;
    bytes: number;
    parentSha256?: string;
    operationCount?: number;
    createdAt: string;
  }>;
  units: CadUnits;
  sourceCrs?: string;
  target?: CadTarget;
  transform?: Record<string, unknown>;
  sourceRefs?: Array<{ kind: 'geojson' | 'dxf'; path: string; sha256: string }>;
  createdAt: string;
  updatedAt: string;
};

export type CadParseResult<T> =
  | { ok: true; value: T; diagnostics: ContractDiagnostic[] }
  | { ok: false; value: null; diagnostics: ContractDiagnostic[] };

const SAFE_RELATIVE_POSIX_PATH = /^(?![A-Za-z]:)(?![/\\])(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;
const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HANDLE = /^[0-9A-F]{1,16}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LAYER_NAME = /^[^<>/\\":;?*|,=\u0000-\u001f]{1,255}$/;
const EPSG_CODE = /^EPSG:[0-9]{4,6}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const COMMON_REQUEST_KEYS = ['protocol', 'version', 'kind'] as const;
const DRAW_FROM_GEOJSON_KEYS = new Set([
  ...COMMON_REQUEST_KEYS, 'fileId', 'sourcePath', 'target', 'units', 'layerKey',
  'layerMap', 'labelField', 'labelLayer', 'fillLayers', 'repairInvalid',
  'template', 'title', 'dryRun',
]);
const DRAW_EDIT_KEYS = new Set([
  ...COMMON_REQUEST_KEYS, 'fileId', 'baseRevision', 'operations', 'units', 'dryRun',
]);
const DRAW_IMPORT_KEYS = new Set([
  ...COMMON_REQUEST_KEYS, 'sourcePath', 'fileId', 'title', 'units', 'dryRun',
]);
const INSPECT_KEYS = new Set([
  'protocol', 'version', 'fileId', 'path', 'include', 'selector', 'limit', 'cursor',
]);
const VERIFY_KEYS = new Set([
  'protocol', 'version', 'fileId', 'path', 'revision', 'policy',
]);
const RESULT_KEYS = new Set([
  'protocol', 'version', 'ok', 'dryRun', 'drawing', 'plan', 'preview', 'checks',
  'sourceRefs', 'canvas', 'warnings', 'diagnostics',
]);

function finish<T>(value: T | null, diagnostics: ContractDiagnostic[]): CadParseResult<T> {
  return value !== null && !diagnostics.some((item) => item.severity === 'error')
    ? { ok: true, value, diagnostics }
    : { ok: false, value: null, diagnostics };
}

function received(value: unknown): string | number {
  return typeof value === 'number' || typeof value === 'string' ? value : typeof value;
}

function rejectUnknown(record: JsonRecord, allowed: Set<string>, path: string, diagnostics: ContractDiagnostic[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      diagnostics.push(diagnostic({
        code: 'unsupported_value',
        path: `${path}.${key}`,
        message: `Unknown CAD field: ${key}.`,
      }));
    }
  }
}

function checkProtocol(
  record: JsonRecord,
  protocol: string,
  version: string,
  path: string,
  diagnostics: ContractDiagnostic[],
): void {
  if (record.protocol !== protocol) {
    diagnostics.push(diagnostic({
      code: 'unsupported_value',
      path: `${path}.protocol`,
      message: 'Unsupported CAD protocol.',
      expected: protocol,
      received: received(record.protocol),
    }));
  }
  if (record.version !== version) {
    diagnostics.push(diagnostic({
      code: 'unknown_schema_version',
      path: `${path}.version`,
      message: 'Unsupported CAD protocol version.',
      expected: version,
      received: received(record.version),
    }));
  }
}

function requiredText(record: JsonRecord, key: string, path: string, max: number, diagnostics: ContractDiagnostic[]): string | null {
  const value = asString(record[key], max);
  if (!value) {
    diagnostics.push(diagnostic({
      code: 'missing_text_field',
      path: `${path}.${key}`,
      message: `${key} is required and must be at most ${max} characters.`,
    }));
  }
  return value;
}

function optionalText(record: JsonRecord, key: string, path: string, max: number, diagnostics: ContractDiagnostic[]): string | undefined {
  if (record[key] === undefined) return undefined;
  const value = asString(record[key], max);
  if (!value) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}.${key}`, message: `${key} must be a non-empty string.` }));
    return undefined;
  }
  return value;
}

function optionalBoolean(record: JsonRecord, key: string, path: string, diagnostics: ContractDiagnostic[]): boolean | undefined {
  if (record[key] === undefined) return undefined;
  if (typeof record[key] !== 'boolean') {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}.${key}`, message: `${key} must be a boolean.` }));
    return undefined;
  }
  return record[key];
}

function optionalInteger(
  record: JsonRecord,
  key: string,
  path: string,
  diagnostics: ContractDiagnostic[],
  minimum = 0,
): number | undefined {
  if (record[key] === undefined) return undefined;
  const value = asInteger(record[key]);
  if (value === null || value < minimum) {
    diagnostics.push(diagnostic({
      code: 'out_of_range',
      path: `${path}.${key}`,
      message: `${key} must be an integer >= ${minimum}.`,
    }));
    return undefined;
  }
  return value;
}

function requiredInteger(
  record: JsonRecord,
  key: string,
  path: string,
  diagnostics: ContractDiagnostic[],
  minimum = 0,
): number | null {
  const value = asInteger(record[key]);
  if (value === null || value < minimum) {
    diagnostics.push(diagnostic({
      code: 'out_of_range',
      path: `${path}.${key}`,
      message: `${key} must be an integer >= ${minimum}.`,
    }));
    return null;
  }
  return value;
}

function parseTimestamp(value: unknown, path: string, diagnostics: ContractDiagnostic[]): string | null {
  const text = asString(value, 64);
  if (!text || !TIMESTAMP.test(text) || !Number.isFinite(Date.parse(text))) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'Expected an ISO 8601 date-time with an explicit timezone.' }));
    return null;
  }
  return text;
}

function isSafeRelativePosixPath(value: string): boolean {
  return SAFE_RELATIVE_POSIX_PATH.test(value)
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function parsePath(
  value: unknown,
  path: string,
  diagnostics: ContractDiagnostic[],
  extensions: string[],
): string | null {
  const text = asString(value, CAD_MAX_PATH_LENGTH);
  if (!text || !isSafeRelativePosixPath(text)) {
    diagnostics.push(diagnostic({
      code: 'unsafe_value',
      path,
      message: 'Path must be a safe relative POSIX path inside the session.',
    }));
    return null;
  }
  if (!extensions.some((extension) => text.toLowerCase().endsWith(extension))) {
    diagnostics.push(diagnostic({
      code: 'unsupported_value',
      path,
      message: `Path must end with ${extensions.join(' or ')}.`,
    }));
    return null;
  }
  return text;
}

function parseFileId(value: unknown, path: string, diagnostics: ContractDiagnostic[]): string | null {
  const text = asString(value, 64);
  if (!text || !FILE_ID.test(text)) {
    diagnostics.push(diagnostic({
      code: 'invalid_type',
      path,
      message: 'fileId must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$.',
    }));
    return null;
  }
  return text;
}

function parseLayerName(value: unknown, path: string, diagnostics: ContractDiagnostic[]): string | null {
  const text = asString(value, 255);
  if (!text || !LAYER_NAME.test(text)) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'Invalid DXF layer name.' }));
    return null;
  }
  return text;
}

function parseUnits(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadUnits | null {
  if (value === 'm' || value === 'mm') return value;
  diagnostics.push(diagnostic({ code: 'unsupported_value', path, message: 'Units must be "m" or "mm".' }));
  return null;
}

function parseSha256(value: unknown, path: string, diagnostics: ContractDiagnostic[]): string | null {
  const text = asString(value, 64);
  if (!text || !SHA256.test(text)) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'sha256 must be 64 lowercase hex characters.' }));
    return null;
  }
  return text;
}

function parsePoint2(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadPoint2 | null {
  if (!Array.isArray(value) || value.length !== 2) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'Expected [x, y].' }));
    return null;
  }
  const x = asFiniteNumber(value[0]);
  const y = asFiniteNumber(value[1]);
  if (x === null || y === null || Math.abs(x) > 1e8 || Math.abs(y) > 1e8) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path, message: 'Point coordinates must be finite and <= 1e8 in magnitude.' }));
    return null;
  }
  return [x, y];
}

function parsePointArray(
  value: unknown,
  path: string,
  diagnostics: ContractDiagnostic[],
  minimum: number,
  maximum: number,
): CadPoint2[] | null {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    diagnostics.push(diagnostic({
      code: 'out_of_range',
      path,
      message: `Expected ${minimum}..${maximum} points.`,
    }));
    return null;
  }
  const points: CadPoint2[] = [];
  value.forEach((item, index) => {
    const point = parsePoint2(item, `${path}[${index}]`, diagnostics);
    if (point) points.push(point);
  });
  return points.length === value.length ? points : null;
}

function parseExtents(value: unknown, path: string, diagnostics: ContractDiagnostic[]): { min: CadPoint2; max: CadPoint2 } | null {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'Extents must be an object with min and max.' }));
    return null;
  }
  const min = parsePoint2(record.min, `${path}.min`, diagnostics);
  const max = parsePoint2(record.max, `${path}.max`, diagnostics);
  if (!min || !max) return null;
  if (min[0] > max[0] || min[1] > max[1]) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path, message: 'Extents min must not exceed max.' }));
    return null;
  }
  return { min, max };
}

function parseLayerMap(value: unknown, path: string, diagnostics: ContractDiagnostic[]): Record<string, string> | null {
  const record = asRecord(value);
  if (!record || Object.keys(record).length === 0 || Object.keys(record).length > 200) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'layerMap must contain 1..200 entries.' }));
    return null;
  }
  const layerMap: Record<string, string> = {};
  for (const [key, layerValue] of Object.entries(record)) {
    const normalizedKey = asString(key, 120);
    const layer = parseLayerName(layerValue, `${path}.${key}`, diagnostics);
    if (!normalizedKey || !layer) {
      diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}.${key}`, message: 'layerMap keys and values must be non-empty strings.' }));
      continue;
    }
    layerMap[normalizedKey] = layer;
  }
  return Object.keys(layerMap).length === Object.keys(record).length ? layerMap : null;
}

function parseTarget(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadTarget | null {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'target must be an object.' }));
    return null;
  }
  if (record.kind === 'epsg') {
    rejectUnknown(record, new Set(['kind', 'code']), path, diagnostics);
    const code = asString(record.code, 40);
    if (!code || !EPSG_CODE.test(code)) {
      diagnostics.push(diagnostic({ code: 'unsupported_value', path: `${path}.code`, message: 'EPSG code must look like EPSG:32651.' }));
      return null;
    }
    return { kind: 'epsg', code };
  }
  if (record.kind === 'local') {
    rejectUnknown(record, new Set(['kind', 'origin', 'rotationDeg', 'scale']), path, diagnostics);
    const origin = parsePoint2(record.origin, `${path}.origin`, diagnostics);
    const rotationDeg = record.rotationDeg === undefined ? 0 : asFiniteNumber(record.rotationDeg);
    const scale = record.scale === undefined ? 1 : asFiniteNumber(record.scale);
    if (!origin || rotationDeg === null || scale === null || scale <= 0) {
      diagnostics.push(diagnostic({ code: 'out_of_range', path, message: 'local target requires origin, finite rotationDeg and scale > 0.' }));
      return null;
    }
    return { kind: 'local', origin, rotationDeg, scale };
  }
  diagnostics.push(diagnostic({ code: 'unsupported_value', path: `${path}.kind`, message: 'target.kind must be "epsg" or "local".' }));
  return null;
}

function parseSelector(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadSelector | null {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'selector must be an object.' }));
    return null;
  }
  if (record.kind === 'handle') {
    rejectUnknown(record, new Set(['kind', 'handle']), path, diagnostics);
    const handle = asString(record.handle, 16);
    if (!handle || !HANDLE.test(handle)) {
      diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}.handle`, message: 'handle must be 1..16 uppercase hex characters.' }));
      return null;
    }
    return { kind: 'handle', handle };
  }
  if (record.kind === 'layer') {
    rejectUnknown(record, new Set(['kind', 'layer', 'entityType']), path, diagnostics);
    const layer = parseLayerName(record.layer, `${path}.layer`, diagnostics);
    const entityType = parseEntityType(record.entityType, `${path}.entityType`, diagnostics);
    if (!layer) return null;
    return { kind: 'layer', layer, ...(entityType ? { entityType } : {}) };
  }
  if (record.kind === 'bounds') {
    rejectUnknown(record, new Set(['kind', 'layer', 'entityType', 'min', 'max']), path, diagnostics);
    const layer = record.layer === undefined ? undefined : parseLayerName(record.layer, `${path}.layer`, diagnostics);
    const entityType = parseEntityType(record.entityType, `${path}.entityType`, diagnostics);
    const min = parsePoint2(record.min, `${path}.min`, diagnostics);
    const max = parsePoint2(record.max, `${path}.max`, diagnostics);
    if (record.layer !== undefined && !layer) return null;
    if (!min || !max || min[0] > max[0] || min[1] > max[1]) {
      diagnostics.push(diagnostic({ code: 'out_of_range', path, message: 'bounds min must not exceed max.' }));
      return null;
    }
    return { kind: 'bounds', min, max, ...(layer ? { layer } : {}), ...(entityType ? { entityType } : {}) };
  }
  diagnostics.push(diagnostic({ code: 'unsupported_value', path: `${path}.kind`, message: 'selector.kind must be handle, layer or bounds.' }));
  return null;
}

function parseEntityType(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadEntityType | undefined {
  if (value === undefined) return undefined;
  const text = asString(value, 40);
  if (!text || !(CAD_ENTITY_TYPES as readonly string[]).includes(text)) {
    diagnostics.push(diagnostic({ code: 'unsupported_value', path, message: 'Unsupported CAD entity type.' }));
    return undefined;
  }
  return text as CadEntityType;
}

function parseOperation(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadOperation | null {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'operation must be an object.' }));
    return null;
  }
  const op = asString(record.op, 40);
  if (op === 'move' || op === 'copy') {
    rejectUnknown(record, new Set(['op', 'selector', 'dx', 'dy', ...(op === 'copy' ? ['count'] : [])]), path, diagnostics);
    const selector = parseSelector(record.selector, `${path}.selector`, diagnostics);
    const dx = asFiniteNumber(record.dx);
    const dy = asFiniteNumber(record.dy);
    if (dx === null) diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}.dx`, message: 'dx must be a finite number.' }));
    if (dy === null) diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}.dy`, message: 'dy must be a finite number.' }));
    const count = op === 'copy' ? optionalInteger(record, 'count', path, diagnostics, 1) : undefined;
    if (op === 'copy' && count !== undefined && count > 100) {
      diagnostics.push(diagnostic({ code: 'out_of_range', path: `${path}.count`, message: 'count must be <= 100.' }));
    }
    if (!selector || dx === null || dy === null || (op === 'copy' && count !== undefined && count > 100)) return null;
    return op === 'move'
      ? { op: 'move', selector, dx, dy }
      : { op: 'copy', selector, dx, dy, ...(count !== undefined ? { count } : {}) };
  }
  if (op === 'delete') {
    rejectUnknown(record, new Set(['op', 'selector']), path, diagnostics);
    const selector = parseSelector(record.selector, `${path}.selector`, diagnostics);
    return selector ? { op: 'delete', selector } : null;
  }
  if (op === 'setLayer') {
    rejectUnknown(record, new Set(['op', 'selector', 'layer']), path, diagnostics);
    const selector = parseSelector(record.selector, `${path}.selector`, diagnostics);
    const layer = parseLayerName(record.layer, `${path}.layer`, diagnostics);
    return selector && layer ? { op: 'setLayer', selector, layer } : null;
  }
  if (op === 'drawPolyline') {
    rejectUnknown(record, new Set(['op', 'layer', 'points', 'closed']), path, diagnostics);
    const layer = parseLayerName(record.layer, `${path}.layer`, diagnostics);
    const points = parsePointArray(record.points, `${path}.points`, diagnostics, 2, CAD_MAX_POINTS);
    const closed = optionalBoolean(record, 'closed', path, diagnostics);
    return layer && points ? { op: 'drawPolyline', layer, points, ...(closed !== undefined ? { closed } : {}) } : null;
  }
  if (op === 'drawText') {
    rejectUnknown(record, new Set(['op', 'layer', 'position', 'text', 'height', 'rotationDeg']), path, diagnostics);
    const layer = parseLayerName(record.layer, `${path}.layer`, diagnostics);
    const position = parsePoint2(record.position, `${path}.position`, diagnostics);
    const text = asString(record.text, CAD_MAX_TEXT_LENGTH);
    const height = asFiniteNumber(record.height);
    const rotationDeg = record.rotationDeg === undefined ? undefined : asFiniteNumber(record.rotationDeg);
    if (!text) diagnostics.push(diagnostic({ code: 'missing_text_field', path: `${path}.text`, message: 'text is required.' }));
    if (height === null || height <= 0) diagnostics.push(diagnostic({ code: 'out_of_range', path: `${path}.height`, message: 'height must be > 0.' }));
    if (record.rotationDeg !== undefined && rotationDeg === null) diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}.rotationDeg`, message: 'rotationDeg must be finite.' }));
    return layer && position && text && height !== null && height > 0
      ? { op: 'drawText', layer, position, text, height, ...(rotationDeg !== null && rotationDeg !== undefined ? { rotationDeg } : {}) }
      : null;
  }
  if (op === 'drawHatch') {
    rejectUnknown(record, new Set(['op', 'layer', 'boundary']), path, diagnostics);
    const layer = parseLayerName(record.layer, `${path}.layer`, diagnostics);
    const boundary = parsePointArray(record.boundary, `${path}.boundary`, diagnostics, 3, CAD_MAX_POINTS);
    return layer && boundary ? { op: 'drawHatch', layer, boundary } : null;
  }
  if (op === 'insertBlock') {
    rejectUnknown(record, new Set(['op', 'layer', 'name', 'position', 'rotationDeg', 'scale']), path, diagnostics);
    const layer = parseLayerName(record.layer, `${path}.layer`, diagnostics);
    const name = asString(record.name, 255);
    const position = parsePoint2(record.position, `${path}.position`, diagnostics);
    const rotationDeg = record.rotationDeg === undefined ? undefined : asFiniteNumber(record.rotationDeg);
    const scale = record.scale === undefined ? undefined : asFiniteNumber(record.scale);
    if (!name) diagnostics.push(diagnostic({ code: 'missing_text_field', path: `${path}.name`, message: 'block name is required.' }));
    if (record.rotationDeg !== undefined && rotationDeg === null) diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}.rotationDeg`, message: 'rotationDeg must be finite.' }));
    if (record.scale !== undefined && (scale === null || scale === undefined || scale <= 0)) diagnostics.push(diagnostic({ code: 'out_of_range', path: `${path}.scale`, message: 'scale must be > 0.' }));
    return layer && name && position
      ? { op: 'insertBlock', layer, name, position, ...(rotationDeg !== null && rotationDeg !== undefined ? { rotationDeg } : {}), ...(scale !== null && scale !== undefined ? { scale } : {}) }
      : null;
  }
  diagnostics.push(diagnostic({ code: 'unsupported_value', path: `${path}.op`, message: 'Unsupported CAD operation.' }));
  return null;
}

function parseOperations(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadOperation[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > CAD_MAX_OPERATIONS) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path, message: `operations must contain 1..${CAD_MAX_OPERATIONS} items.` }));
    return null;
  }
  const operations = value.map((item, index) => parseOperation(item, `${path}[${index}]`, diagnostics));
  return operations.every((item): item is CadOperation => item !== null) ? operations : null;
}

function parseStringList(value: unknown, path: string, diagnostics: ContractDiagnostic[], maximum: number, parseItem: (item: unknown, itemPath: string) => string | null): string[] | null {
  if (!Array.isArray(value) || value.length > maximum) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path, message: `Expected an array with at most ${maximum} items.` }));
    return null;
  }
  const items = value.map((item, index) => parseItem(item, `${path}[${index}]`));
  return items.every((item): item is string => item !== null) ? items : null;
}

function parseInputRef(record: JsonRecord, diagnostics: ContractDiagnostic[], extensions: string[]): { fileId?: string; path?: string } | null {
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
  if (kind !== 'from-geojson' && kind !== 'edit' && kind !== 'import') {
    diagnostics.push(diagnostic({ code: 'unsupported_value', path: 'cad.kind', message: 'kind must be from-geojson, edit or import.' }));
    return { ok: false, value: null, diagnostics };
  }

  if (kind === 'from-geojson') {
    rejectUnknown(record, DRAW_FROM_GEOJSON_KEYS, 'cad', diagnostics);
    const sourcePath = parsePath(record.sourcePath, 'cad.sourcePath', diagnostics, ['.geojson', '.json']);
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
    const template = optionalText(record, 'template', 'cad', 120, diagnostics);
    const title = optionalText(record, 'title', 'cad', 300, diagnostics);
    const dryRun = optionalBoolean(record, 'dryRun', 'cad', diagnostics) ?? false;
    if (!sourcePath || !target || !layerMap || units !== 'm' || (record.fileId !== undefined && !fileId) || (record.fillLayers !== undefined && !fillLayers)) return { ok: false, value: null, diagnostics };
    return finish({
      protocol: CAD_PROTOCOL,
      version: CAD_VERSION,
      kind,
      ...(fileId ? { fileId } : {}),
      sourcePath,
      target,
      units: 'm',
      ...(layerKey ? { layerKey } : {}),
      layerMap,
      ...(labelField ? { labelField } : {}),
      ...(labelLayer ? { labelLayer } : {}),
      ...(fillLayers ? { fillLayers } : {}),
      ...(repairInvalid !== undefined ? { repairInvalid } : {}),
      ...(template ? { template } : {}),
      ...(title ? { title } : {}),
      dryRun,
    }, diagnostics);
  }

  if (kind === 'edit') {
    rejectUnknown(record, DRAW_EDIT_KEYS, 'cad', diagnostics);
    const fileId = parseFileId(record.fileId, 'cad.fileId', diagnostics);
    const baseRevision = requiredInteger(record, 'baseRevision', 'cad', diagnostics, 0);
    const operations = parseOperations(record.operations, 'cad.operations', diagnostics);
    const units = record.units === undefined ? undefined : parseUnits(record.units, 'cad.units', diagnostics);
    const dryRun = optionalBoolean(record, 'dryRun', 'cad', diagnostics) ?? false;
    if (!fileId || baseRevision === null || !operations || (record.units !== undefined && !units)) return { ok: false, value: null, diagnostics };
    return finish({
      protocol: CAD_PROTOCOL,
      version: CAD_VERSION,
      kind,
      fileId,
      baseRevision,
      operations,
      ...(units ? { units } : {}),
      dryRun,
    }, diagnostics);
  }

  rejectUnknown(record, DRAW_IMPORT_KEYS, 'cad', diagnostics);
  const sourcePath = parsePath(record.sourcePath, 'cad.sourcePath', diagnostics, ['.dxf']);
  const fileId = record.fileId === undefined ? undefined : parseFileId(record.fileId, 'cad.fileId', diagnostics);
  const title = optionalText(record, 'title', 'cad', 300, diagnostics);
  const units = record.units === undefined ? undefined : parseUnits(record.units, 'cad.units', diagnostics);
  const dryRun = optionalBoolean(record, 'dryRun', 'cad', diagnostics) ?? false;
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
  const includeValues = ['summary', 'layers', 'entities', 'blocks', 'units', 'extents', 'textStyles'] as const;
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
  const policy = record.policy === undefined ? 'traffic-v1' : record.policy;
  if (policy !== 'traffic-v1' && policy !== 'strict') {
    diagnostics.push(diagnostic({ code: 'unsupported_value', path: 'cad.policy', message: 'policy must be traffic-v1 or strict.' }));
  }
  if (record.revision !== undefined && record.fileId === undefined) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'cad.revision', message: 'revision requires fileId.' }));
  }
  if (!reference || (record.revision !== undefined && revision === undefined) || (policy !== 'traffic-v1' && policy !== 'strict')) return { ok: false, value: null, diagnostics };
  return finish({
    protocol: CAD_PROTOCOL,
    version: CAD_VERSION,
    ...reference,
    ...(revision !== undefined ? { revision } : {}),
    policy,
  }, diagnostics);
}

function parseDiagnostic(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadDiagnostic | null {
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

function parseDiagnosticList(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadDiagnostic[] | null {
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

function parseDrawingRef(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadDrawingRefV1 | null {
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

function parsePreview(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadPreviewV1 | null {
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

function parseChecks(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadVerifyCheck[] | null {
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

function parseSourceRefs(value: unknown, path: string, diagnostics: ContractDiagnostic[]): Array<{ kind: 'geojson' | 'dxf'; path: string; sha256: string }> | null {
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

function parsePlan(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadDrawResultV1['plan'] | null {
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

function parseLayers(value: unknown, path: string, diagnostics: ContractDiagnostic[]): NonNullable<CadInspectResultV1['layers']> | null {
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

function parseEntities(value: unknown, path: string, diagnostics: ContractDiagnostic[]): NonNullable<CadInspectResultV1['entities']> | null {
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
    entities.push({ handle, type: type as CadEntityType, layer, ...(bounds ? { bounds } : {}), ...(text ? { text } : {}) });
  });
  return entities.length === value.length ? entities : null;
}

function parseBlocks(value: unknown, path: string, diagnostics: ContractDiagnostic[]): NonNullable<CadInspectResultV1['blocks']> | null {
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

function parseTextStyles(value: unknown, path: string, diagnostics: ContractDiagnostic[]): NonNullable<CadInspectResultV1['textStyles']> | null {
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
  return finish({
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
  const checks = parseChecks(record.checks, 'cad.checks', diagnostics);
  const resultDiagnostics = parseDiagnosticList(record.diagnostics, 'cad.diagnostics', diagnostics);
  if (typeof record.ok !== 'boolean' || !checks || !resultDiagnostics) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'cad', message: 'Invalid CAD verify result.' }));
    return { ok: false, value: null, diagnostics };
  }
  return finish({
    protocol: CAD_PROTOCOL,
    version: CAD_VERSION,
    ok: record.ok,
    checks,
    diagnostics: resultDiagnostics,
  }, diagnostics);
}

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
  const units = record.units === undefined ? null : parseUnits(record.units, 'cad.units', diagnostics);
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
      ...(parentSha256 ? { parentSha256 } : {}),
      ...(operationCount !== null && operationCount !== undefined ? { operationCount } : {}),
      createdAt: revisionCreatedAt,
    });
  });
  if (!drawingId || !fileId || !title || currentRevision === null || currentRevision < 0 || !units || !createdAt || !updatedAt || (record.sourceCrs !== undefined && !sourceCrs) || (record.target !== undefined && !target) || (record.transform !== undefined && !transform) || (record.sourceRefs !== undefined && !sourceRefs) || revisions.length !== record.revisions.length) {
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
