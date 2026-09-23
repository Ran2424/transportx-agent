/**
 * Shared Canvas lifecycle contracts.
 *
 * The core validates only the common envelope and bounded JSON containers.
 * Adapter-owned payload, target and selection values need a second validation
 * pass in the registered trusted adapter before they are used.
 */

import { asInteger, asRecord, asString, type JsonRecord } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';
import {
  CANVAS_CONTEXT_PROTOCOL,
  CANVAS_CONTEXT_VERSION,
  CANVAS_PRESENTATION_PROTOCOL,
  CANVAS_PRESENTATION_VERSION,
} from './version.ts';

export const CANVAS_MAX_RESOURCES = 16;
export const CANVAS_MAX_JSON_BYTES = 64 * 1024;
export const CANVAS_MAX_JSON_DEPTH = 12;
export const CANVAS_MAX_JSON_NODES = 4096;

export type CanvasResourceRef =
  | { scope: 'session-file'; path: string }
  | { scope: 'citation'; resourceId: string; sha256: string }
  | { scope: 'capability'; moduleId: string; resourceId: string; revision?: number };

export type CanvasPresentationOperation = 'present' | 'focus' | 'update' | 'clear';

export type CanvasPresentationV1 = {
  protocol: typeof CANVAS_PRESENTATION_PROTOCOL;
  version: typeof CANVAS_PRESENTATION_VERSION;
  presentationId: string;
  adapterId: string;
  kind: string;
  viewId: string;
  revision: number;
  operation: CanvasPresentationOperation;
  title: string;
  resources: CanvasResourceRef[];
  payload?: unknown;
  target?: unknown;
  generatedAt: string;
};

export type CanvasContextV1 = {
  protocol: typeof CANVAS_CONTEXT_PROTOCOL;
  version: typeof CANVAS_CONTEXT_VERSION;
  contextId: string;
  adapterId: string;
  viewId: string;
  revision: number;
  resources: CanvasResourceRef[];
  target?: unknown;
  selection?: unknown;
  createdAt: string;
};

export type CanvasParseResult<T> =
  | { ok: true; value: T; diagnostics: ContractDiagnostic[] }
  | { ok: false; value: null; diagnostics: ContractDiagnostic[] };

function finish<T>(value: T | null, diagnostics: ContractDiagnostic[]): CanvasParseResult<T> {
  return value !== null && !diagnostics.some((item) => item.severity === 'error')
    ? { ok: true, value, diagnostics }
    : { ok: false, value: null, diagnostics };
}

function received(value: unknown): string | number {
  return typeof value === 'number' || typeof value === 'string' ? value : typeof value;
}

function requiredText(record: JsonRecord, key: string, path: string, max: number, diagnostics: ContractDiagnostic[]): string | null {
  const value = asString(record[key], max);
  if (!value) diagnostics.push(diagnostic({ code: 'missing_text_field', path: `${path}.${key}`, message: `${key} is required and must be at most ${max} characters.` }));
  return value;
}

function parseTimestamp(value: unknown, path: string, diagnostics: ContractDiagnostic[]): string | null {
  const text = asString(value, 64);
  if (!text || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'Expected an ISO 8601 date-time with an explicit timezone.' }));
    return null;
  }
  return text;
}

function isSafeRelativePosixPath(value: string): boolean {
  return !value.startsWith('/')
    && !value.includes('\\')
    && !/^[A-Za-z]:/.test(value)
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function parseResource(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CanvasResourceRef | null {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'Canvas resource must be an object.' }));
    return null;
  }
  if (record.scope === 'session-file') {
    if (Object.keys(record).some((key) => key !== 'scope' && key !== 'path')) diagnostics.push(diagnostic({ code: 'unsupported_value', path, message: 'Session File resource contains unknown fields.' }));
    const resourcePath = asString(record.path, 1000);
    if (!resourcePath || !isSafeRelativePosixPath(resourcePath)) {
      diagnostics.push(diagnostic({ code: 'unsafe_value', path: `${path}.path`, message: 'Session file path must be a safe relative POSIX path.' }));
      return null;
    }
    return { scope: 'session-file', path: resourcePath };
  }
  if (record.scope === 'citation') {
    if (Object.keys(record).some((key) => !['scope', 'resourceId', 'sha256'].includes(key))) diagnostics.push(diagnostic({ code: 'unsupported_value', path, message: 'Citation resource contains unknown fields.' }));
    const resourceId = asString(record.resourceId, 160);
    const sha256 = asString(record.sha256, 64);
    if (!resourceId) diagnostics.push(diagnostic({ code: 'missing_text_field', path: `${path}.resourceId`, message: 'Citation resourceId is required.' }));
    if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}.sha256`, message: 'Citation sha256 must be a lowercase hexadecimal digest.' }));
    return resourceId && sha256 && /^[a-f0-9]{64}$/.test(sha256) ? { scope: 'citation', resourceId, sha256 } : null;
  }
  if (record.scope === 'capability') {
    if (Object.keys(record).some((key) => !['scope', 'moduleId', 'resourceId', 'revision'].includes(key))) diagnostics.push(diagnostic({ code: 'unsupported_value', path, message: 'Capability resource contains unknown fields.' }));
    const moduleId = asString(record.moduleId, 200);
    const resourceId = asString(record.resourceId, 160);
    const revision = record.revision === undefined ? undefined : asInteger(record.revision) ?? undefined;
    if (!moduleId) diagnostics.push(diagnostic({ code: 'missing_text_field', path: `${path}.moduleId`, message: 'Capability moduleId is required.' }));
    if (!resourceId) diagnostics.push(diagnostic({ code: 'missing_text_field', path: `${path}.resourceId`, message: 'Capability resourceId is required.' }));
    if (record.revision !== undefined && (revision === undefined || revision < 0)) diagnostics.push(diagnostic({ code: 'out_of_range', path: `${path}.revision`, message: 'Capability revision must be a non-negative integer.' }));
    return moduleId && resourceId && (record.revision === undefined || revision !== undefined && revision >= 0)
      ? { scope: 'capability', moduleId, resourceId, ...(revision !== undefined ? { revision } : {}) }
      : null;
  }
  diagnostics.push(diagnostic({ code: 'unsupported_value', path: `${path}.scope`, message: 'Unknown Canvas resource scope.', received: received(record.scope) }));
  return null;
}

function parseResources(value: unknown, path: string, diagnostics: ContractDiagnostic[]): CanvasResourceRef[] | null {
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'resources must be an array.' }));
    return null;
  }
  if (value.length > CANVAS_MAX_RESOURCES) diagnostics.push(diagnostic({ code: 'out_of_range', path, message: `resources cannot contain more than ${CANVAS_MAX_RESOURCES} items.` }));
  const resources = value.slice(0, CANVAS_MAX_RESOURCES).map((item, index) => parseResource(item, `${path}[${index}]`, diagnostics));
  return resources.every((item): item is CanvasResourceRef => item !== null) && value.length <= CANVAS_MAX_RESOURCES ? resources : null;
}

function validateBoundedJson(value: unknown, path: string, diagnostics: ContractDiagnostic[]): boolean {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'Value must be JSON serializable.' }));
    return false;
  }
  if (encoded === undefined) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'Value must be JSON serializable.' }));
    return false;
  }
  if (new TextEncoder().encode(encoded).byteLength > CANVAS_MAX_JSON_BYTES) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path, message: `JSON value exceeds ${CANVAS_MAX_JSON_BYTES} bytes.` }));
    return false;
  }
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > CANVAS_MAX_JSON_NODES || depth > CANVAS_MAX_JSON_DEPTH) return false;
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return true;
    if (typeof candidate === 'number') return Number.isFinite(candidate);
    if (Array.isArray(candidate)) return candidate.every((item) => visit(item, depth + 1));
    const record = asRecord(candidate);
    return record !== null && Object.values(record).every((item) => visit(item, depth + 1));
  };
  if (!visit(value, 0)) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path, message: 'JSON value exceeds the Canvas depth/node limits or contains a non-finite number.' }));
    return false;
  }
  return true;
}

export function parseCanvasPresentationStructured(value: unknown, diagnostics: ContractDiagnostic[] = []): CanvasParseResult<CanvasPresentationV1> {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'canvas', message: 'Canvas presentation must be an object.' }));
    return { ok: false, value: null, diagnostics };
  }
  if (record.protocol !== CANVAS_PRESENTATION_PROTOCOL) diagnostics.push(diagnostic({ code: 'unsupported_value', path: 'canvas.protocol', message: 'Unsupported Canvas protocol.', expected: CANVAS_PRESENTATION_PROTOCOL, received: received(record.protocol) }));
  if (record.version !== CANVAS_PRESENTATION_VERSION) diagnostics.push(diagnostic({ code: 'unknown_schema_version', path: 'canvas.version', message: 'Unsupported Canvas protocol version.', expected: CANVAS_PRESENTATION_VERSION, received: received(record.version) }));
  const presentationId = requiredText(record, 'presentationId', 'canvas', 160, diagnostics);
  const adapterId = requiredText(record, 'adapterId', 'canvas', 200, diagnostics);
  const kind = requiredText(record, 'kind', 'canvas', 80, diagnostics);
  const viewId = requiredText(record, 'viewId', 'canvas', 240, diagnostics);
  const title = requiredText(record, 'title', 'canvas', 300, diagnostics);
  const revision = asInteger(record.revision);
  if (revision === null || revision < 0) diagnostics.push(diagnostic({ code: 'out_of_range', path: 'canvas.revision', message: 'revision must be a non-negative integer.' }));
  const operation = record.operation === 'present' || record.operation === 'focus' || record.operation === 'update' || record.operation === 'clear' ? record.operation : null;
  if (!operation) diagnostics.push(diagnostic({ code: 'unsupported_value', path: 'canvas.operation', message: 'Unsupported Canvas operation.', received: received(record.operation) }));
  const resources = parseResources(record.resources, 'canvas.resources', diagnostics);
  const generatedAt = parseTimestamp(record.generatedAt, 'canvas.generatedAt', diagnostics);
  if (record.payload !== undefined) validateBoundedJson(record.payload, 'canvas.payload', diagnostics);
  if (record.target !== undefined) validateBoundedJson(record.target, 'canvas.target', diagnostics);
  if (record.protocol !== CANVAS_PRESENTATION_PROTOCOL || record.version !== CANVAS_PRESENTATION_VERSION || !presentationId || !adapterId || !kind || !viewId || !title || revision === null || revision < 0 || !operation || !resources || !generatedAt) return { ok: false, value: null, diagnostics };
  return finish({
    protocol: CANVAS_PRESENTATION_PROTOCOL,
    version: CANVAS_PRESENTATION_VERSION,
    presentationId,
    adapterId,
    kind,
    viewId,
    revision,
    operation,
    title,
    resources,
    ...(record.payload !== undefined ? { payload: record.payload } : {}),
    ...(record.target !== undefined ? { target: record.target } : {}),
    generatedAt,
  }, diagnostics);
}

export function parseCanvasPresentation(value: unknown): CanvasPresentationV1 | null {
  const parsed = parseCanvasPresentationStructured(value);
  return parsed.ok ? parsed.value : null;
}

/** Extract a unified Canvas envelope persisted as tool-result details.canvas. */
export function getCanvasPresentationFromToolResult(message: unknown): CanvasPresentationV1 | null {
  const record = asRecord(message);
  const details = asRecord(record?.details);
  return details?.canvas === undefined ? null : parseCanvasPresentation(details.canvas);
}

export function parseCanvasContextStructured(value: unknown, diagnostics: ContractDiagnostic[] = []): CanvasParseResult<CanvasContextV1> {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'canvasContext', message: 'Canvas context must be an object.' }));
    return { ok: false, value: null, diagnostics };
  }
  if (record.protocol !== CANVAS_CONTEXT_PROTOCOL) diagnostics.push(diagnostic({ code: 'unsupported_value', path: 'canvasContext.protocol', message: 'Unsupported Canvas context protocol.', expected: CANVAS_CONTEXT_PROTOCOL, received: received(record.protocol) }));
  if (record.version !== CANVAS_CONTEXT_VERSION) diagnostics.push(diagnostic({ code: 'unknown_schema_version', path: 'canvasContext.version', message: 'Unsupported Canvas context version.', expected: CANVAS_CONTEXT_VERSION, received: received(record.version) }));
  const contextId = requiredText(record, 'contextId', 'canvasContext', 160, diagnostics);
  const adapterId = requiredText(record, 'adapterId', 'canvasContext', 200, diagnostics);
  const viewId = requiredText(record, 'viewId', 'canvasContext', 240, diagnostics);
  const revision = asInteger(record.revision);
  if (revision === null || revision < 0) diagnostics.push(diagnostic({ code: 'out_of_range', path: 'canvasContext.revision', message: 'revision must be a non-negative integer.' }));
  const resources = parseResources(record.resources, 'canvasContext.resources', diagnostics);
  const createdAt = parseTimestamp(record.createdAt, 'canvasContext.createdAt', diagnostics);
  if (record.target !== undefined) validateBoundedJson(record.target, 'canvasContext.target', diagnostics);
  if (record.selection !== undefined) validateBoundedJson(record.selection, 'canvasContext.selection', diagnostics);
  if (record.protocol !== CANVAS_CONTEXT_PROTOCOL || record.version !== CANVAS_CONTEXT_VERSION || !contextId || !adapterId || !viewId || revision === null || revision < 0 || !resources || !createdAt) return { ok: false, value: null, diagnostics };
  return finish({
    protocol: CANVAS_CONTEXT_PROTOCOL,
    version: CANVAS_CONTEXT_VERSION,
    contextId,
    adapterId,
    viewId,
    revision,
    resources,
    ...(record.target !== undefined ? { target: record.target } : {}),
    ...(record.selection !== undefined ? { selection: record.selection } : {}),
    createdAt,
  }, diagnostics);
}

export function parseCanvasContext(value: unknown): CanvasContextV1 | null {
  const parsed = parseCanvasContextStructured(value);
  return parsed.ok ? parsed.value : null;
}

export function stripCanvasContextPrompt(text: string) {
  return text.replace(/\n\n\[Canvas context\]\n[\s\S]*?\n\[\/Canvas context\]/g, '');
}
