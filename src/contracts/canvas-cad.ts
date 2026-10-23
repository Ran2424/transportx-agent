import { asInteger, asRecord, asString } from './common.ts';

export const CAD_CANVAS_ADAPTER_ID = 'com.transportx.canvas.cad';
export const CAD_CANVAS_KIND = 'cad';
export const CAD_CANVAS_MAX_HANDLES = 500;
export const CAD_CANVAS_MAX_LAYERS = 100;

export type CadCanvasUnits = 'm' | 'mm' | null;

export type CadCanvasTarget = {
  kind: 'viewport';
  center: [number, number];
  zoom: number;
  units: CadCanvasUnits;
};

export type CadCanvasSelection = {
  kind: 'cad-selection';
  handles: string[];
  layers: string[];
  count: number;
  truncated: boolean;
  drawingSha256?: string;
};

export type CadCanvasPayload = {
  format: 'dxf';
  path: string;
  sha256: string;
  units: CadCanvasUnits;
  layerCount?: number;
  entityCount?: number;
  preview?: string;
};

const HANDLE = /^[0-9A-F]{1,16}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LAYER_NAME = /^[^<>/\\":;?*|,=\u0000-\u001f]{1,255}$/;
const MAX_COUNT = 10_000_000;

function exactKeys(record: Record<string, unknown>, allowed: string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(record).every((key) => keys.has(key));
}

function safeRelativePath(value: unknown): string | null {
  const text = asString(value, 1000);
  return text
    && !text.startsWith('/')
    && !text.includes('\\')
    && !/^[A-Za-z]:/.test(text)
    && text.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    ? text
    : null;
}

function units(value: unknown): CadCanvasUnits | null {
  return value === 'm' || value === 'mm' ? value : null;
}

function point(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [x, y] = value;
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y) ? [x, y] : null;
}

export function parseCadCanvasTarget(value: unknown): CadCanvasTarget | null {
  const record = asRecord(value);
  if (!record || !exactKeys(record, ['kind', 'center', 'zoom', 'units']) || record.kind !== 'viewport') return null;
  const center = point(record.center);
  const zoom = record.zoom;
  const unit = units(record.units);
  if (!center || typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom <= 0 || (record.units !== null && !unit)) return null;
  return { kind: 'viewport', center, zoom, units: unit };
}

export function parseCadCanvasSelection(value: unknown): CadCanvasSelection | null {
  const record = asRecord(value);
  if (!record || !exactKeys(record, ['kind', 'handles', 'layers', 'count', 'truncated', 'drawingSha256']) || record.kind !== 'cad-selection') return null;
  if (!Array.isArray(record.handles) || record.handles.length > CAD_CANVAS_MAX_HANDLES) return null;
  if (!Array.isArray(record.layers) || record.layers.length > CAD_CANVAS_MAX_LAYERS) return null;
  const handles: string[] = [];
  for (const item of record.handles) {
    const handle = asString(item, 16);
    if (!handle || !HANDLE.test(handle)) return null;
    handles.push(handle);
  }
  const layers: string[] = [];
  for (const item of record.layers) {
    const layer = asString(item, 255);
    if (!layer || !LAYER_NAME.test(layer)) return null;
    layers.push(layer);
  }
  const count = asInteger(record.count);
  if (count === null || count < handles.length || count > MAX_COUNT || typeof record.truncated !== 'boolean') return null;
  if (new Set(handles).size !== handles.length || !record.truncated && count !== handles.length) return null;
  if (record.drawingSha256 !== undefined && (typeof record.drawingSha256 !== 'string' || !SHA256.test(record.drawingSha256))) return null;
  return { kind: 'cad-selection', handles, layers, count, truncated: record.truncated, ...(typeof record.drawingSha256 === 'string' ? { drawingSha256: record.drawingSha256 } : {}) };
}

export function parseCadCanvasPayload(value: unknown): CadCanvasPayload | null {
  const record = asRecord(value);
  if (!record || !exactKeys(record, ['format', 'path', 'sha256', 'units', 'layerCount', 'entityCount', 'preview'])) return null;
  if (record.format !== 'dxf') return null;
  const path = safeRelativePath(record.path);
  const sha256 = asString(record.sha256, 64);
  const unit = units(record.units);
  const layerCount = record.layerCount === undefined ? undefined : asInteger(record.layerCount);
  const entityCount = record.entityCount === undefined ? undefined : asInteger(record.entityCount);
  const preview = record.preview === undefined ? undefined : safeRelativePath(record.preview);
  if (!path || !sha256 || !SHA256.test(sha256) || (record.units !== null && !unit) || layerCount === null || layerCount !== undefined && layerCount < 0 || entityCount === null || entityCount !== undefined && entityCount < 0 || (record.preview !== undefined && !preview)) return null;
  return { format: 'dxf', path, sha256, units: unit, ...(layerCount !== undefined ? { layerCount } : {}), ...(entityCount !== undefined ? { entityCount } : {}), ...(preview ? { preview } : {}) };
}
