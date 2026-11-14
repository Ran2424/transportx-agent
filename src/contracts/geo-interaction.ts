import { asRecord, asString, asInteger } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';
import type { GeoParseResult } from './geo-scene.ts';

const SOURCE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export const GEO_CONTEXT_MAX_FEATURES = 1_000;
export const GEO_CONTEXT_MAX_VISIBLE_LAYERS = 64;
export const GEO_CONTEXTS_PER_MESSAGE = 8;
export const GEO_CONTEXT_MAX_BYTES = 256 * 1024;
export const GEO_REQUEST_MAX_TARGET_LAYERS = 32;
export const GEO_REQUEST_DEFAULT_TIMEOUT_SECONDS = 600;
export const GEO_REQUEST_MIN_TIMEOUT_SECONDS = 30;
export const GEO_REQUEST_MAX_TIMEOUT_SECONDS = 1_800;
export const GEO_SCREENSHOT_TIMEOUT_SECONDS = 60;
export const GEO_CONTEXT_PROMPT_BEGIN = '<!-- TAU_GEO_CONTEXT_V1 -->';
export const GEO_CONTEXT_PROMPT_END = '<!-- /TAU_GEO_CONTEXT_V1 -->';

export type GeoContextMode = 'feature' | 'point' | 'rectangle' | 'viewport';

export type GeoContextViewV1 = {
  center: [number, number];
  zoom: number;
  bounds: [number, number, number, number];
  bearing: number;
  pitch: number;
};

export type GeoPointV1 = { type: 'Point'; coordinates: [number, number] };
export type GeoRectangleV1 = {
  type: 'Polygon';
  coordinates: [[
    [number, number],
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ]];
};

export type GeoClientContextV1 = {
  version: 1;
  contextId: string;
  visualizationId: string;
  sceneRevision: number;
  mode: GeoContextMode;
  createdAt: string;
  view: GeoContextViewV1;
  visibleLayerIds: string[];
  selection?: { layerId: string; featureIds: Array<string | number> };
  geometry?: GeoPointV1 | GeoRectangleV1;
  summary: string;
};

export type GeoContextReferenceV1 = {
  contextId: string;
  sessionId: string;
  visualizationId: string;
  sceneRevision: number;
  mode: GeoContextMode;
  summary: string;
  createdAt: string;
};

export type GeoContextProvenanceV1 = {
  sourceKind: 'resource';
  geoResourceId: string;
  sha256: string;
  bytes: number;
  idStrategy: { kind: 'feature-id' } | { kind: 'id-field'; field: string };
};

export type GeoInteractionRequestV1 = {
  version: 1;
  requestId: string;
  sessionId: string;
  visualizationId: string;
  sceneRevision: number;
  mode: GeoContextMode;
  prompt: string;
  required: boolean;
  targetLayerIds?: string[];
  maxFeatures?: number;
  timeoutSeconds: number;
  status: 'waiting';
  createdAt: string;
  expiresAt: string;
};

export type GeoInteractionTerminalStatus = 'submitted' | 'cancelled' | 'expired' | 'aborted' | 'invalidated';
export type GeoInteractionResponseReason =
  | 'user_cancelled'
  | 'timeout'
  | 'agent_aborted'
  | 'session_closed'
  | 'scene_revision_changed'
  | 'visualization_changed'
  | 'resource_changed';

export type GeoInteractionResponseV1 = {
  version: 1;
  requestId: string;
  status: GeoInteractionTerminalStatus;
  contextId?: string;
  reason?: GeoInteractionResponseReason;
  completedAt: string;
};

export type GeoScreenshotRequestV1 = {
  version: 1;
  requestId: string;
  sessionId: string;
  visualizationId: string;
  sceneRevision: number;
  status: 'waiting';
  createdAt: string;
  expiresAt: string;
};

export function buildGeoContextPrompt(contextIds: string[]) {
  if (!contextIds.length) return '';
  return `\n\n${GEO_CONTEXT_PROMPT_BEGIN}\nThis user turn has Geo Context IDs: ${JSON.stringify(contextIds)}. Call inspect_map_context before interpreting them. Do not reuse Geo Contexts from older turns.\n${GEO_CONTEXT_PROMPT_END}`;
}

export function stripGeoContextPrompt(text: string) {
  const start = text.indexOf(GEO_CONTEXT_PROMPT_BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(GEO_CONTEXT_PROMPT_END, start);
  return (end < 0 ? text.slice(0, start) : `${text.slice(0, start)}${text.slice(end + GEO_CONTEXT_PROMPT_END.length)}`).trimEnd();
}

function interactionFail<T>(path: string, code: ContractDiagnostic['code'], message: string): GeoParseResult<T> {
  return { ok: false, value: null, diagnostics: [diagnostic({ path, code, message })] };
}

function interactionId(value: unknown, prefix: 'geoctx_' | 'georeq_' | 'geoshot_') {
  const text = asString(value, 80);
  return text && new RegExp(`^${prefix}[A-Za-z0-9_-]{12,64}$`).test(text) ? text : null;
}

function isoDate(value: unknown) {
  const text = asString(value, 64);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function position(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(finite)) return null;
  const [longitude, latitude] = value;
  return longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90
    ? [longitude, latitude]
    : null;
}

function contextView(value: unknown): GeoContextViewV1 | null {
  const input = asRecord(value);
  const center = position(input?.center);
  const bounds = Array.isArray(input?.bounds) && input.bounds.length === 4 && input.bounds.every(finite)
    ? input.bounds as [number, number, number, number]
    : null;
  if (!input || !center || !bounds || !finite(input.zoom) || input.zoom < 0 || input.zoom > 24 || !finite(input.bearing) || !finite(input.pitch)) return null;
  const [west, south, east, north] = bounds;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north || input.bearing < -360 || input.bearing > 360 || input.pitch < 0 || input.pitch > 85) return null;
  return { center, zoom: input.zoom, bounds, bearing: input.bearing, pitch: input.pitch };
}

function stringIds(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const ids = value.map((item) => asString(item, 64));
  if (ids.some((item) => !item || !SOURCE_ID_RE.test(item)) || new Set(ids).size !== ids.length) return null;
  return ids as string[];
}

function featureIds(value: unknown, max = GEO_CONTEXT_MAX_FEATURES): Array<string | number> | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return null;
  if (value.some((item) => (typeof item !== 'string' && typeof item !== 'number') || (typeof item === 'string' && (!item || item.length > 200)) || (typeof item === 'number' && !Number.isFinite(item)))) return null;
  const keys = value.map((item) => `${typeof item}:${String(item)}`);
  return new Set(keys).size === keys.length ? value as Array<string | number> : null;
}

function rectangle(value: unknown): GeoRectangleV1 | null {
  const root = asRecord(value);
  if (!root || root.type !== 'Polygon' || !Array.isArray(root.coordinates) || root.coordinates.length !== 1 || !Array.isArray(root.coordinates[0]) || root.coordinates[0].length !== 5) return null;
  const ring = root.coordinates[0].map(position);
  if (ring.some((item) => !item)) return null;
  const points = ring as Array<[number, number]>;
  if (points[0][0] !== points[4][0] || points[0][1] !== points[4][1]) return null;
  const unique = new Set(points.slice(0, 4).map(([x, y]) => `${x}:${y}`));
  if (unique.size !== 4) return null;
  const longitudes = [...new Set(points.slice(0, 4).map(([x]) => x))];
  const latitudes = [...new Set(points.slice(0, 4).map(([, y]) => y))];
  if (longitudes.length !== 2 || latitudes.length !== 2) return null;
  for (let index = 1; index < points.length; index++) {
    if (points[index - 1][0] !== points[index][0] && points[index - 1][1] !== points[index][1]) return null;
  }
  return { type: 'Polygon', coordinates: [points as GeoRectangleV1['coordinates'][0]] };
}

export function parseGeoClientContextStructured(value: unknown): GeoParseResult<GeoClientContextV1> {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return interactionFail('context', 'invalid_type', 'Context must be JSON serializable.'); }
  if (new TextEncoder().encode(serialized).byteLength > GEO_CONTEXT_MAX_BYTES) return interactionFail('context', 'out_of_range', `Context exceeds ${GEO_CONTEXT_MAX_BYTES} bytes.`);
  const input = asRecord(value);
  if (!input) return interactionFail('context', 'invalid_type', 'Context must be an object.');
  if (input.version !== 1) return interactionFail('context.version', 'unknown_schema_version', 'Unsupported Geo Context version.');
  const contextId = interactionId(input.contextId, 'geoctx_');
  if (!contextId) return interactionFail('context.contextId', 'invalid_type', 'contextId must be a valid geoctx_ identifier.');
  const visualizationId = asString(input.visualizationId, 80);
  if (!visualizationId || !SOURCE_ID_RE.test(visualizationId)) return interactionFail('context.visualizationId', 'invalid_type', 'visualizationId must be a valid identifier.');
  const sceneRevision = asInteger(input.sceneRevision);
  if (sceneRevision === null || sceneRevision < 1) return interactionFail('context.sceneRevision', 'out_of_range', 'sceneRevision must be a positive integer.');
  if (!['feature', 'point', 'rectangle', 'viewport'].includes(String(input.mode))) return interactionFail('context.mode', 'unsupported_value', 'Unknown Geo Context mode.');
  const mode = input.mode as GeoContextMode;
  const createdAt = isoDate(input.createdAt);
  if (!createdAt) return interactionFail('context.createdAt', 'invalid_type', 'createdAt must be an ISO date-time.');
  const view = contextView(input.view);
  if (!view) return interactionFail('context.view', 'unsupported_value', 'view must contain a valid WGS84 camera and bounds.');
  const visibleLayerIds = stringIds(input.visibleLayerIds, GEO_CONTEXT_MAX_VISIBLE_LAYERS);
  if (!visibleLayerIds) return interactionFail('context.visibleLayerIds', 'invalid_type', `visibleLayerIds must contain at most ${GEO_CONTEXT_MAX_VISIBLE_LAYERS} unique layer ids.`);
  const summary = asString(input.summary, 500);
  if (!summary) return interactionFail('context.summary', 'invalid_type', 'summary is required and must be at most 500 characters.');

  let selection: GeoClientContextV1['selection'];
  let geometry: GeoClientContextV1['geometry'];
  if (mode === 'feature') {
    const rawSelection = asRecord(input.selection);
    const layerId = asString(rawSelection?.layerId, 64);
    const ids = featureIds(rawSelection?.featureIds);
    if (!layerId || !SOURCE_ID_RE.test(layerId) || !ids) return interactionFail('context.selection', 'invalid_type', `feature mode requires one layer and 1-${GEO_CONTEXT_MAX_FEATURES} unique string/number feature ids.`);
    if (input.geometry !== undefined) return interactionFail('context.geometry', 'unsupported_value', 'feature mode forbids geometry.');
    selection = { layerId, featureIds: ids };
  } else {
    if (input.selection !== undefined) return interactionFail('context.selection', 'unsupported_value', `${mode} mode forbids selection.`);
    if (mode === 'point') {
      const raw = asRecord(input.geometry);
      const coordinates = raw?.type === 'Point' ? position(raw.coordinates) : null;
      if (!coordinates) return interactionFail('context.geometry', 'unsupported_value', 'point mode requires a valid WGS84 Point.');
      geometry = { type: 'Point', coordinates };
    } else if (mode === 'rectangle') {
      const parsed = rectangle(input.geometry);
      if (!parsed) return interactionFail('context.geometry', 'unsupported_value', 'rectangle mode requires an axis-aligned, five-point closed WGS84 Polygon.');
      geometry = parsed;
    } else if (input.geometry !== undefined) {
      return interactionFail('context.geometry', 'unsupported_value', 'viewport mode forbids geometry.');
    }
  }
  return { ok: true, value: { version: 1, contextId, visualizationId, sceneRevision, mode, createdAt, view, visibleLayerIds, ...(selection ? { selection } : {}), ...(geometry ? { geometry } : {}), summary }, diagnostics: [] };
}

export function parseGeoInteractionRequestStructured(value: unknown): GeoParseResult<GeoInteractionRequestV1> {
  const input = asRecord(value);
  if (!input) return interactionFail('request', 'invalid_type', 'Geo request must be an object.');
  if (input.version !== 1) return interactionFail('request.version', 'unknown_schema_version', 'Unsupported Geo request version.');
  const requestId = interactionId(input.requestId, 'georeq_');
  const sessionId = asString(input.sessionId, 160);
  const visualizationId = asString(input.visualizationId, 80);
  const revision = asInteger(input.sceneRevision);
  const prompt = asString(input.prompt, 500);
  const timeoutSeconds = asInteger(input.timeoutSeconds);
  const createdAt = isoDate(input.createdAt);
  const expiresAt = isoDate(input.expiresAt);
  if (!requestId) return interactionFail('request.requestId', 'invalid_type', 'requestId must be a valid georeq_ identifier.');
  if (!sessionId) return interactionFail('request.sessionId', 'invalid_type', 'sessionId is required.');
  if (!visualizationId || !SOURCE_ID_RE.test(visualizationId)) return interactionFail('request.visualizationId', 'invalid_type', 'visualizationId must be a valid identifier.');
  if (revision === null || revision < 1) return interactionFail('request.sceneRevision', 'out_of_range', 'sceneRevision must be positive.');
  if (!['feature', 'point', 'rectangle', 'viewport'].includes(String(input.mode))) return interactionFail('request.mode', 'unsupported_value', 'Unknown Geo request mode.');
  if (!prompt) return interactionFail('request.prompt', 'invalid_type', 'prompt is required and must be at most 500 characters.');
  if (typeof input.required !== 'boolean' || input.status !== 'waiting') return interactionFail('request.status', 'invalid_type', 'required must be boolean and status must be waiting.');
  if (timeoutSeconds === null || timeoutSeconds < GEO_REQUEST_MIN_TIMEOUT_SECONDS || timeoutSeconds > GEO_REQUEST_MAX_TIMEOUT_SECONDS) return interactionFail('request.timeoutSeconds', 'out_of_range', `timeoutSeconds must be ${GEO_REQUEST_MIN_TIMEOUT_SECONDS}-${GEO_REQUEST_MAX_TIMEOUT_SECONDS}.`);
  if (!createdAt || !expiresAt || Date.parse(expiresAt) <= Date.parse(createdAt)) return interactionFail('request.expiresAt', 'out_of_range', 'Request timestamps must define a future expiry.');
  const mode = input.mode as GeoContextMode;
  let targetLayerIds: string[] | undefined;
  let maxFeatures: number | undefined;
  if (mode === 'feature') {
    if (input.targetLayerIds !== undefined) {
      const parsed = stringIds(input.targetLayerIds, GEO_REQUEST_MAX_TARGET_LAYERS);
      if (!parsed || !parsed.length) return interactionFail('request.targetLayerIds', 'invalid_type', `targetLayerIds must contain 1-${GEO_REQUEST_MAX_TARGET_LAYERS} unique layer ids.`);
      targetLayerIds = parsed;
    }
    if (input.maxFeatures !== undefined) {
      const parsed = asInteger(input.maxFeatures);
      if (parsed === null || parsed < 1 || parsed > GEO_CONTEXT_MAX_FEATURES) return interactionFail('request.maxFeatures', 'out_of_range', `maxFeatures must be 1-${GEO_CONTEXT_MAX_FEATURES}.`);
      maxFeatures = parsed;
    }
  } else if (input.targetLayerIds !== undefined || input.maxFeatures !== undefined) {
    return interactionFail('request.mode', 'unsupported_value', 'Only feature requests may use targetLayerIds or maxFeatures.');
  }
  return { ok: true, value: { version: 1, requestId, sessionId, visualizationId, sceneRevision: revision, mode, prompt, required: input.required, ...(targetLayerIds ? { targetLayerIds } : {}), ...(maxFeatures ? { maxFeatures } : {}), timeoutSeconds, status: 'waiting', createdAt, expiresAt }, diagnostics: [] };
}

const RESPONSE_REASONS: Record<Exclude<GeoInteractionTerminalStatus, 'submitted'>, GeoInteractionResponseReason[]> = {
  cancelled: ['user_cancelled'],
  expired: ['timeout'],
  aborted: ['agent_aborted', 'session_closed'],
  invalidated: ['scene_revision_changed', 'visualization_changed', 'resource_changed'],
};

export function parseGeoInteractionResponseStructured(value: unknown): GeoParseResult<GeoInteractionResponseV1> {
  const input = asRecord(value);
  if (!input) return interactionFail('response', 'invalid_type', 'Geo response must be an object.');
  if (input.version !== 1) return interactionFail('response.version', 'unknown_schema_version', 'Unsupported Geo response version.');
  const requestId = interactionId(input.requestId, 'georeq_');
  const completedAt = isoDate(input.completedAt);
  if (!requestId) return interactionFail('response.requestId', 'invalid_type', 'requestId must be a valid georeq_ identifier.');
  if (!completedAt) return interactionFail('response.completedAt', 'invalid_type', 'completedAt must be an ISO date-time.');
  if (!['submitted', 'cancelled', 'expired', 'aborted', 'invalidated'].includes(String(input.status))) return interactionFail('response.status', 'unsupported_value', 'Unknown Geo response status.');
  const status = input.status as GeoInteractionTerminalStatus;
  if (status === 'submitted') {
    const contextId = interactionId(input.contextId, 'geoctx_');
    if (!contextId || input.reason !== undefined) return interactionFail('response.contextId', 'invalid_type', 'submitted requires contextId and forbids reason.');
    return { ok: true, value: { version: 1, requestId, status, contextId, completedAt }, diagnostics: [] };
  }
  const reason = typeof input.reason === 'string' ? input.reason as GeoInteractionResponseReason : null;
  if (!reason || !RESPONSE_REASONS[status].includes(reason) || input.contextId !== undefined) return interactionFail('response.reason', 'unsupported_value', `${status} requires its matching reason and forbids contextId.`);
  return { ok: true, value: { version: 1, requestId, status, reason, completedAt }, diagnostics: [] };
}

export function parseGeoScreenshotRequestStructured(value: unknown): GeoParseResult<GeoScreenshotRequestV1> {
  const input = asRecord(value);
  if (!input) return interactionFail('screenshotRequest', 'invalid_type', 'Geo screenshot request must be an object.');
  if (input.version !== 1) return interactionFail('screenshotRequest.version', 'unknown_schema_version', 'Unsupported Geo screenshot request version.');
  const requestId = interactionId(input.requestId, 'geoshot_');
  const sessionId = asString(input.sessionId, 160);
  const visualizationId = asString(input.visualizationId, 80);
  const revision = asInteger(input.sceneRevision);
  const createdAt = isoDate(input.createdAt);
  const expiresAt = isoDate(input.expiresAt);
  if (!requestId) return interactionFail('screenshotRequest.requestId', 'invalid_type', 'requestId must be a valid geoshot_ identifier.');
  if (!sessionId) return interactionFail('screenshotRequest.sessionId', 'invalid_type', 'sessionId is required.');
  if (!visualizationId || !SOURCE_ID_RE.test(visualizationId)) return interactionFail('screenshotRequest.visualizationId', 'invalid_type', 'visualizationId must be a valid identifier.');
  if (revision === null || revision < 1) return interactionFail('screenshotRequest.sceneRevision', 'out_of_range', 'sceneRevision must be positive.');
  if (input.status !== 'waiting') return interactionFail('screenshotRequest.status', 'unsupported_value', 'status must be waiting.');
  if (!createdAt || !expiresAt || Date.parse(expiresAt) <= Date.parse(createdAt)) return interactionFail('screenshotRequest.expiresAt', 'out_of_range', 'Request timestamps must define a future expiry.');
  return { ok: true, value: { version: 1, requestId, sessionId, visualizationId, sceneRevision: revision, status: 'waiting', createdAt, expiresAt }, diagnostics: [] };
}
