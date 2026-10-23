import { asFiniteNumber, asRecord, asString } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';

import {
  CAD_MAX_OPERATIONS,
  CAD_MAX_POINTS,
  CAD_MAX_TEXT_LENGTH,
  CAD_ENTITY_TYPES,
  type CadEntityType,
  type CadTarget,
  type CadSelector,
  type CadOperation,
} from './cad-types.ts';
import {
  HANDLE,
  EPSG_CODE,
  rejectUnknown,
  optionalBoolean,
  optionalInteger,
  parseLayerName,
  parsePoint2,
  parsePointArray,
} from './cad-validation.ts';

export function parseLayerMap(value: unknown, path: string, diagnostics: ContractDiagnostic[]): Record<string, string> | null {
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

export function parseTarget(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadTarget | null {
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

export function parseSelector(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadSelector | null {
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

export function parseEntityType(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadEntityType | undefined {
  if (value === undefined) return undefined;
  const text = asString(value, 40);
  if (!text || !(CAD_ENTITY_TYPES as readonly string[]).includes(text)) {
    diagnostics.push(diagnostic({ code: 'unsupported_value', path, message: 'Unsupported CAD entity type.' }));
    return undefined;
  }
  return text as CadEntityType;
}

export function parseOperation(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadOperation | null {
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

export function parseOperations(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadOperation[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > CAD_MAX_OPERATIONS) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path, message: `operations must contain 1..${CAD_MAX_OPERATIONS} items.` }));
    return null;
  }
  const operations = value.map((item, index) => parseOperation(item, `${path}[${index}]`, diagnostics));
  return operations.every((item): item is CadOperation => item !== null) ? operations : null;
}
