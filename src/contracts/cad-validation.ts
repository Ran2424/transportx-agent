import { asFiniteNumber, asInteger, asRecord, asString, type JsonRecord } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';

import { CAD_MAX_PATH_LENGTH, type CadUnits, type CadPoint2, type CadParseResult } from './cad-types.ts';

export const SAFE_RELATIVE_POSIX_PATH = /^(?![A-Za-z]:)(?![/\\])(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;
export const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const HANDLE = /^[0-9A-F]{1,16}$/;
export const SHA256 = /^[a-f0-9]{64}$/;
export const LAYER_NAME = /^[^<>/\\":;?*|,=\u0000-\u001f]{1,255}$/;
export const EPSG_CODE = /^EPSG:[0-9]{4,6}$/;
export const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function finish<T>(value: T | null, diagnostics: ContractDiagnostic[]): CadParseResult<T> {
  return value !== null && !diagnostics.some((item) => item.severity === 'error')
    ? { ok: true, value, diagnostics }
    : { ok: false, value: null, diagnostics };
}

export function received(value: unknown): string | number {
  return typeof value === 'number' || typeof value === 'string' ? value : typeof value;
}

export function rejectUnknown(record: JsonRecord, allowed: Set<string>, path: string, diagnostics: ContractDiagnostic[]): void {
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

export function checkProtocol(
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

export function requiredText(record: JsonRecord, key: string, path: string, max: number, diagnostics: ContractDiagnostic[]): string | null {
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

export function optionalText(record: JsonRecord, key: string, path: string, max: number, diagnostics: ContractDiagnostic[]): string | undefined {
  if (record[key] === undefined) return undefined;
  const value = asString(record[key], max);
  if (!value) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}.${key}`, message: `${key} must be a non-empty string.` }));
    return undefined;
  }
  return value;
}

export function optionalBoolean(record: JsonRecord, key: string, path: string, diagnostics: ContractDiagnostic[]): boolean | undefined {
  if (record[key] === undefined) return undefined;
  if (typeof record[key] !== 'boolean') {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}.${key}`, message: `${key} must be a boolean.` }));
    return undefined;
  }
  return record[key];
}

export function optionalInteger(
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

export function requiredInteger(
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

export function parseTimestamp(value: unknown, path: string, diagnostics: ContractDiagnostic[]): string | null {
  const text = asString(value, 64);
  if (!text || !TIMESTAMP.test(text) || !Number.isFinite(Date.parse(text))) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'Expected an ISO 8601 date-time with an explicit timezone.' }));
    return null;
  }
  return text;
}

export function isSafeRelativePosixPath(value: string): boolean {
  return SAFE_RELATIVE_POSIX_PATH.test(value)
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export function parsePath(
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

export function parseFileId(value: unknown, path: string, diagnostics: ContractDiagnostic[]): string | null {
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

export function parseLayerName(value: unknown, path: string, diagnostics: ContractDiagnostic[]): string | null {
  const text = asString(value, 255);
  if (!text || !LAYER_NAME.test(text)) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'Invalid DXF layer name.' }));
    return null;
  }
  return text;
}

export function parseUnits(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadUnits | null {
  if (value === 'm' || value === 'mm') return value;
  diagnostics.push(diagnostic({ code: 'unsupported_value', path, message: 'Units must be "m" or "mm".' }));
  return null;
}

export function parseSha256(value: unknown, path: string, diagnostics: ContractDiagnostic[]): string | null {
  const text = asString(value, 64);
  if (!text || !SHA256.test(text)) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'sha256 must be 64 lowercase hex characters.' }));
    return null;
  }
  return text;
}

export function parsePoint2(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CadPoint2 | null {
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

export function parsePointArray(
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

export function parseExtents(value: unknown, path: string, diagnostics: ContractDiagnostic[]): { min: CadPoint2; max: CadPoint2 } | null {
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

export function parseStringList(value: unknown, path: string, diagnostics: ContractDiagnostic[], maximum: number, parseItem: (item: unknown, itemPath: string) => string | null): string[] | null {
  if (!Array.isArray(value) || value.length > maximum) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path, message: `Expected an array with at most ${maximum} items.` }));
    return null;
  }
  const items = value.map((item, index) => parseItem(item, `${path}[${index}]`));
  return items.every((item): item is string => item !== null) ? items : null;
}
