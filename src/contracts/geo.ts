/**
 * Geo visualization contract shared between the GIS extension, Server HTTP
 * resource layer and the Browser Geo Workspace.
 *
 * Modules re-exporting this contract:
 *   - `modules/capabilities/geo/extensions/pi-geo-visualization/index.ts` builds and validates Envelopes.
 *   - The React Geo feature consumes envelopes through its session projection.
 */
import {
  asRecord,
  asString,
  asFiniteNumber,
  asInteger,
  type JsonRecord,
  type ValidationIssue,
  type ValidationResult,
} from './common.ts';
import { GEO_ENVELOPE_PROTOCOL, GEO_ENVELOPE_VERSION } from './version.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';

/* -------------------------------------------------------------------------- */
/*                                Wire format                                 */
/* -------------------------------------------------------------------------- */

export type JsonObject = Record<string, unknown>;

export type GeoJsonGeometry = {
  type: 'Point' | 'MultiPoint' | 'LineString' | 'MultiLineString' | 'Polygon' | 'MultiPolygon' | 'GeometryCollection';
  coordinates?: unknown;
  geometries?: GeoJsonGeometry[];
};

export type GeoJsonFeature = {
  type: 'Feature';
  id?: string | number;
  properties: JsonObject | null;
  geometry: GeoJsonGeometry | null;
};

export type GeoJsonFeatureCollection = {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
};

export type GeoView =
  | { mode: 'bounds'; bounds: [number, number, number, number]; padding?: number }
  | { mode: 'camera'; center: [number, number]; zoom: number };

export type GeoVisualValue =
  | { mode: 'constant'; value: string | number | number[] }
  | { mode: 'categorical'; field: string; categories: Array<{ value: string | number | boolean; output: string | number }>; fallback: string | number }
  | { mode: 'step'; field: string; default: string | number; stops: Array<{ value: number; output: string | number }> }
  | { mode: 'continuous'; field: string; stops: Array<{ value: number; output: string | number }> };

export type GeoSource =
  | { id: string; type: 'geojson-inline'; data: GeoJsonFeatureCollection; idField?: string }
  | { id: string; type: 'geojson-resource'; resourceId: string; idField?: string };

export type GeoChart = {
  type: 'pie' | 'donut' | 'bar';
  valueFields: string[];
  colors: string[];
  size: number;
  collisionMode?: 'show-all' | 'hide-overlap';
  maxValue?: number;
  trackColor?: string;
  labelField?: string;
  labelFormat?: 'text' | 'integer' | 'decimal' | 'percent';
};

export type GeoLayer = {
  id: string;
  sourceId: string;
  type: 'circle' | 'line' | 'fill' | 'label' | 'chart';
  title?: string;
  visible?: boolean;
  minZoom?: number;
  maxZoom?: number;
  encoding: Record<string, GeoVisualValue>;
  chart?: GeoChart;
  popup?: { fields: Array<{ field: string; label: string; format?: 'text' | 'integer' | 'decimal' | 'percent' }> };
};

export type GeoSceneSnapshot = {
  view: GeoView;
  basemap: { id: 'default' | 'light' | 'dark' | 'none' };
  sources: GeoSource[];
  layers: GeoLayer[];
  controls?: { navigation?: boolean; fullscreen?: boolean; layerSwitcher?: boolean; legend?: boolean; fitToData?: boolean };
  selection?: Array<{ sourceId: string; layerId?: string; featureIds: Array<string | number> }>;
  metadata: { title: string; description?: string; warnings?: string[] };
};

/**
 * Every revision carries a complete Scene snapshot. The operation describes
 * how the Browser reconciles that snapshot: replace rebuilds the map, patch
 * updates content without resetting the camera, focus applies only the
 * declared view, select applies only selection, and clear removes it. Local
 * layer visibility survives while the same layer ID remains in the Scene.
 */
export type GeoEnvelopeOperation = 'replace' | 'patch' | 'focus' | 'select' | 'clear';

export type VisualizationEnvelope = {
  protocol: typeof GEO_ENVELOPE_PROTOCOL;
  version: typeof GEO_ENVELOPE_VERSION;
  kind: 'geo';
  visualizationId: string;
  revision: number;
  operation: GeoEnvelopeOperation;
  scene: GeoSceneSnapshot | null;
  summary: { title: string; description?: string };
  generatedAt: string;
};

/* -------------------------------------------------------------------------- */
/*                         Bidirectional interaction                          */
/* -------------------------------------------------------------------------- */

export const GEO_CONTEXT_MAX_FEATURES = 1_000;
export const GEO_CONTEXT_MAX_VISIBLE_LAYERS = 64;
export const GEO_CONTEXTS_PER_MESSAGE = 8;
export const GEO_CONTEXT_MAX_BYTES = 256 * 1024;
export const GEO_REQUEST_MAX_TARGET_LAYERS = 32;
export const GEO_REQUEST_DEFAULT_TIMEOUT_SECONDS = 600;
export const GEO_REQUEST_MIN_TIMEOUT_SECONDS = 30;
export const GEO_REQUEST_MAX_TIMEOUT_SECONDS = 1_800;
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

/* -------------------------------------------------------------------------- */
/*                                Validation                                  */
/* -------------------------------------------------------------------------- */

export type { ValidationIssue, ValidationResult } from './common.ts';

export type GeoDiagnostic = ContractDiagnostic;
export type GeoParseResult<T> =
  | { ok: true; value: T; diagnostics: [] }
  | { ok: false; value: null; diagnostics: GeoDiagnostic[] };

const SOURCE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RESOURCE_ID_RE = /^geo_[a-f0-9]{16,64}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const GEOMETRY_TYPES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection']);
const MAX_INLINE_FEATURES = 1_000;
const MAX_INLINE_BYTES = 256 * 1024;
const LAYER_CHANNELS: Record<GeoLayer['type'], Set<string>> = {
  circle: new Set(['color', 'radius', 'opacity', 'strokeColor', 'strokeWidth']),
  line: new Set(['color', 'width', 'opacity', 'dash']),
  fill: new Set(['color', 'opacity', 'outlineColor']),
  label: new Set(['textField', 'color', 'size', 'haloColor', 'haloWidth']),
  chart: new Set(),
};

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function coordinatesAreFinite(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (value.every(finite)) return value.length >= 2;
  return value.every(coordinatesAreFinite);
}

export function isFeatureCollection(value: unknown): value is GeoJsonFeatureCollection {
  const root = asRecord(value);
  if (!root || root.type !== 'FeatureCollection' || !Array.isArray(root.features)) return false;
  return root.features.every((item) => {
    const feature = asRecord(item);
    if (!feature || feature.type !== 'Feature') return false;
    if (feature.properties !== null && !asRecord(feature.properties)) return false;
    if (feature.geometry === null) return true;
    const geometry = asRecord(feature.geometry);
    if (!geometry) return false;
    const geometryType = asString(geometry.type, 40);
    if (!geometryType || !GEOMETRY_TYPES.has(geometryType)) return false;
    if (geometryType === 'GeometryCollection') {
      return Array.isArray(geometry.geometries) && geometry.geometries.every((child) => {
        const itemGeometry = asRecord(child);
        if (!itemGeometry) return false;
        const itemType = asString(itemGeometry.type, 40);
        if (!itemType || !GEOMETRY_TYPES.has(itemType) || itemType === 'GeometryCollection') return false;
        return coordinatesAreFinite(itemGeometry.coordinates);
      });
    }
    return coordinatesAreFinite(geometry.coordinates);
  });
}

function parseView(value: unknown): GeoView | null {
  const input = asRecord(value);
  if (!input) return null;
  if (input.mode === 'bounds' && Array.isArray(input.bounds) && input.bounds.length === 4 && input.bounds.every(finite)) {
    const [west, south, east, north] = input.bounds;
    if (west < east && south < north && west >= -180 && east <= 180 && south >= -90 && north <= 90) {
      const padding = input.padding === undefined ? undefined : input.padding;
      if (padding === undefined || (finite(padding) && padding >= 0 && padding <= 128)) {
        return { mode: 'bounds', bounds: [west, south, east, north], ...(padding === undefined ? {} : { padding }) };
      }
    }
  }
  if (input.mode === 'camera' && Array.isArray(input.center) && input.center.length === 2 && input.center.every(finite) && finite(input.zoom)) {
    const [lng, lat] = input.center;
    if (lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90 && input.zoom >= 0 && input.zoom <= 24) {
      return { mode: 'camera', center: [lng, lat], zoom: input.zoom };
    }
  }
  return null;
}

function isVisualOutput(value: unknown): value is string | number {
  return typeof value === 'string' || finite(value);
}

function outputMatchesChannel(channel: string, value: unknown): boolean {
  if (['color', 'strokeColor', 'outlineColor', 'haloColor'].includes(channel)) return typeof value === 'string' && HEX_COLOR_RE.test(value);
  if (channel === 'textField') return typeof value === 'string' && value.length > 0 && value.length <= 100;
  if (channel === 'dash') return Array.isArray(value) && value.length >= 2 && value.length <= 8 && value.every((item) => finite(item) && item >= 0);
  if (['radius', 'width', 'strokeWidth', 'size', 'haloWidth'].includes(channel)) return finite(value) && value >= 0;
  if (channel === 'opacity') return finite(value) && value >= 0 && value <= 1;
  return false;
}

function visualOutputs(value: GeoVisualValue): unknown[] {
  if (value.mode === 'constant') return [value.value];
  if (value.mode === 'categorical') return [...value.categories.map((item) => item.output), value.fallback];
  if (value.mode === 'step') return [value.default, ...value.stops.map((item) => item.output)];
  return value.stops.map((item) => item.output);
}

function parseVisualValue(value: unknown, channel: string): GeoVisualValue | null {
  const input = asRecord(value);
  if (!input) return null;
  if (input.mode === 'constant' && (isVisualOutput(input.value) || (Array.isArray(input.value) && input.value.every(finite)))) {
    const parsed: GeoVisualValue = { mode: 'constant', value: input.value as string | number | number[] };
    return visualOutputs(parsed).every((output) => outputMatchesChannel(channel, output)) ? parsed : null;
  }
  if (input.mode === 'categorical' && asString(input.field, 100) && Array.isArray(input.categories) && input.categories.length <= 64 && isVisualOutput(input.fallback)) {
    const categories = input.categories.map(asRecord);
    if (categories.every((item) => item && ['string', 'number', 'boolean'].includes(typeof item.value) && isVisualOutput(item.output))) {
      const parsed = input as unknown as GeoVisualValue;
      return visualOutputs(parsed).every((output) => outputMatchesChannel(channel, output)) ? parsed : null;
    }
  }
  if ((input.mode === 'step' || input.mode === 'continuous') && asString(input.field, 100) && Array.isArray(input.stops) && input.stops.length >= 2 && input.stops.length <= 16) {
    const stops = input.stops.map(asRecord);
    if (stops.every((item) => item && finite(item.value) && isVisualOutput(item.output))) {
      const values = stops.map((item) => item!.value as number);
      if (values.every((item, index) => index === 0 || item > values[index - 1])) {
        if (input.mode === 'continuous') {
          const parsed = input as unknown as GeoVisualValue;
          return visualOutputs(parsed).every((output) => outputMatchesChannel(channel, output)) ? parsed : null;
        }
        if (isVisualOutput(input.default)) {
          const parsed = input as unknown as GeoVisualValue;
          return visualOutputs(parsed).every((output) => outputMatchesChannel(channel, output)) ? parsed : null;
        }
      }
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*                                Output shape                                */
/* -------------------------------------------------------------------------- */

export const VISUALIZATION_PROTOCOL: typeof GEO_ENVELOPE_PROTOCOL = GEO_ENVELOPE_PROTOCOL;
export const VISUALIZATION_VERSION: typeof GEO_ENVELOPE_VERSION = GEO_ENVELOPE_VERSION;

export function visualizationEnvelope(input: {
  visualizationId: string;
  revision: number;
  operation: GeoEnvelopeOperation;
  scene: GeoSceneSnapshot | null;
  summary: { title: string; description?: string };
  generatedAt?: string;
}): VisualizationEnvelope {
  return {
    protocol: VISUALIZATION_PROTOCOL,
    version: VISUALIZATION_VERSION,
    kind: 'geo',
    visualizationId: input.visualizationId,
    revision: input.revision,
    operation: input.operation,
    scene: input.scene,
    summary: { title: input.summary.title, ...(input.summary.description ? { description: input.summary.description } : {}) },
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Parsers                                   */
/* -------------------------------------------------------------------------- */

export function parseGeoScene(value: unknown): ValidationResult<GeoSceneSnapshot> {
  const diagnostics: ContractDiagnostic[] = [];
  const result = parseGeoSceneStructured(value, diagnostics);
  return result.ok ? { ok: true, value: result.value, issues: [] } : resultByDiagnostic(result.diagnostics);
}

export function formatSceneValidationErrors(prefix: string, result: Extract<ValidationResult<GeoSceneSnapshot>, { ok: false }>): string {
  const detail = result.issues.map((issue) => `${issue.path} [${issue.code}]: ${issue.message}`).join('\n');
  return `${prefix}\n${detail}`;
}

export function parseGeoSceneStructured(value: unknown, sink: ContractDiagnostic[] = []): GeoParseResult<GeoSceneSnapshot> {
  const diagnostics: ContractDiagnostic[] = [];
  const target = sink ?? diagnostics;
  const fail = (path: string, code: string, message: string, severity: 'warning' | 'error' = 'error'): { ok: false; value: null; diagnostics: ContractDiagnostic[] } => {
    const entry = diagnostic({ code: code as ContractDiagnostic['code'], path, message, severity });
    target.push(entry);
    return { ok: false, value: null, diagnostics: target };
  };

  const input = asRecord(value);
  if (!input) return fail('scene', 'invalid_type', 'Scene must be an object.');
  if (!Array.isArray(input.sources)) return fail('scene.sources', 'invalid_type', 'Sources must be an array.');
  if (input.sources.length > 32) return fail('scene.sources', 'out_of_range', 'A scene can contain at most 32 sources.');
  if (!Array.isArray(input.layers)) return fail('scene.layers', 'invalid_type', 'Layers must be an array.');
  if (input.layers.length > 64) return fail('scene.layers', 'out_of_range', 'A scene can contain at most 64 layers.');
  const view = parseView(input.view);
  if (!view) return fail('scene.view', 'unsupported_value', 'Use a valid bounds or camera view.');
  const basemap = asRecord(input.basemap);
  if (!basemap || !['default', 'light', 'dark', 'none'].includes(String(basemap.id))) {
    return fail('scene.basemap.id', 'unsupported_value', 'Basemap id must be default, light, dark, or none.');
  }
  const metadata = asRecord(input.metadata);
  if (!metadata) return fail('scene.metadata', 'invalid_type', 'Metadata must be an object.');
  const metadataTitle = asString(metadata.title, 160);
  if (!metadataTitle) return fail('scene.metadata.title', 'missing_required_field', 'Metadata title is required and must be at most 160 characters.');

  const sources: GeoSource[] = [];
  const sourceIds = new Set<string>();
  for (let index = 0; index < input.sources.length; index++) {
    const item = input.sources[index];
    const sourcePath = `scene.sources[${index}]`;
    const source = asRecord(item);
    if (!source) return fail(sourcePath, 'invalid_type', 'Source must be an object.');
    const sourceId = asString(source.id, 64);
    if (!sourceId || !SOURCE_ID_RE.test(sourceId)) return fail(`${sourcePath}.id`, 'invalid_type', 'Source id must start with a letter and contain only letters, numbers, underscores, or hyphens.');
    if (sourceIds.has(sourceId)) return fail(`${sourcePath}.id`, 'duplicate_id', `Duplicate source id: ${sourceId}.`);
    sourceIds.add(sourceId);
    const idField = source.idField === undefined ? undefined : asString(source.idField, 100);
    if (source.idField !== undefined && idField === undefined) return fail(`${sourcePath}.idField`, 'invalid_type', 'idField must be a non-empty string of at most 100 characters.');
    const inlineData = source.type === 'geojson-inline' && isFeatureCollection(source.data) ? source.data : undefined;
    const resourceId = source.type === 'geojson-resource' ? asString(source.resourceId, 80) : undefined;
    if (source.type === 'geojson-inline') {
      if (!inlineData) return fail(`${sourcePath}.data`, 'unsupported_value', 'Inline source data must be a valid GeoJSON FeatureCollection.');
      if (inlineData.features.length > MAX_INLINE_FEATURES) return fail(`${sourcePath}.data.features`, 'out_of_range', `Inline GeoJSON can contain at most ${MAX_INLINE_FEATURES} features.`);
      if (new TextEncoder().encode(JSON.stringify(inlineData)).byteLength > MAX_INLINE_BYTES) return fail(`${sourcePath}.data`, 'out_of_range', `Inline GeoJSON can contain at most ${MAX_INLINE_BYTES} bytes.`);
      sources.push({ id: sourceId, type: source.type, data: inlineData, ...(idField ? { idField } : {}) });
    } else if (source.type === 'geojson-resource') {
      if (!resourceId || !RESOURCE_ID_RE.test(resourceId)) return fail(`${sourcePath}.resourceId`, 'invalid_type', 'Resource id must be a published geo_* identifier.');
      sources.push({ id: sourceId, type: source.type, resourceId, ...(idField ? { idField } : {}) });
    } else {
      return fail(`${sourcePath}.type`, 'unsupported_value', 'Source type must be geojson-inline or geojson-resource.');
    }
  }

  const layers: GeoLayer[] = [];
  const layerIds = new Set<string>();
  for (let index = 0; index < input.layers.length; index++) {
    const item = input.layers[index];
    const layerPath = `scene.layers[${index}]`;
    const layer = asRecord(item);
    if (!layer) return fail(layerPath, 'invalid_type', 'Layer must be an object.');
    const layerId = asString(layer.id, 64);
    if (!layerId || !SOURCE_ID_RE.test(layerId)) return fail(`${layerPath}.id`, 'invalid_type', 'Layer id must start with a letter and contain only letters, numbers, underscores, or hyphens.');
    if (layerIds.has(layerId)) return fail(`${layerPath}.id`, 'duplicate_id', `Duplicate layer id: ${layerId}.`);
    const layerSourceId = asString(layer.sourceId, 64);
    if (!layerSourceId) return fail(`${layerPath}.sourceId`, 'invalid_type', 'Layer sourceId is required.');
    if (!sourceIds.has(layerSourceId)) return fail(`${layerPath}.sourceId`, 'unknown_reference', `Source not found: ${layerSourceId}.`);
    if (!['circle', 'line', 'fill', 'label', 'chart'].includes(String(layer.type))) return fail(`${layerPath}.type`, 'unsupported_value', 'Layer type must be circle, line, fill, label, or chart.');
    const layerType = layer.type as GeoLayer['type'];
    const encoding = asRecord(layer.encoding);
    if (!encoding) return fail(`${layerPath}.encoding`, 'invalid_type', 'Layer encoding must be an object.');
    const parsedEncoding: Record<string, GeoVisualValue> = {};
    for (const [channel, channelValue] of Object.entries(encoding)) {
      if (!LAYER_CHANNELS[layerType].has(channel)) return fail(`${layerPath}.encoding.${channel}`, 'unsupported_value', `${channel} is not supported by ${layerType} layers.`);
      const parsed = parseVisualValue(channelValue, channel);
      if (!parsed) return fail(`${layerPath}.encoding.${channel}`, 'unsupported_value', `Invalid ${channel} value. Check mode, field, output type, stop order, and channel limits.`);
      parsedEncoding[channel] = parsed;
    }
    if (layerType === 'label' && !parsedEncoding.textField) return fail(`${layerPath}.encoding.textField`, 'missing_text_field', 'Label layers require textField.');
    let chart: GeoLayer['chart'];
    if (layerType === 'chart') {
      const chartInput = asRecord(layer.chart);
      if (!chartInput || !['pie', 'donut', 'bar'].includes(String(chartInput.type))) return fail(`${layerPath}.chart.type`, 'unsupported_value', 'Chart layers require pie, donut, or bar chart type.');
      if (!Array.isArray(chartInput.valueFields) || !chartInput.valueFields.every((field) => !!asString(field, 100))) return fail(`${layerPath}.chart.valueFields`, 'invalid_type', 'Chart valueFields must be non-empty field names.');
      const valueFields = chartInput.valueFields as string[];
      if (valueFields.length < 1 || valueFields.length > 5) return fail(`${layerPath}.chart.valueFields`, 'out_of_range', 'Chart layers require 1 to 5 value fields.');
      if (chartInput.type === 'pie' && valueFields.length < 2) return fail(`${layerPath}.chart.valueFields`, 'out_of_range', 'Pie charts require at least 2 value fields.');
      if (chartInput.type === 'bar' && valueFields.length !== 1) return fail(`${layerPath}.chart.valueFields`, 'out_of_range', 'Bar charts require exactly 1 value field.');
      if (!Array.isArray(chartInput.colors) || chartInput.colors.length < valueFields.length || !chartInput.colors.every((color) => typeof color === 'string' && HEX_COLOR_RE.test(color))) return fail(`${layerPath}.chart.colors`, 'unsupported_value', 'Chart colors must provide a valid hex color for every value field.');
      const size = asFiniteNumber(chartInput.size);
      if (size === null || size < 16 || size > 96) return fail(`${layerPath}.chart.size`, 'out_of_range', 'Chart size must be between 16 and 96 pixels.');
      if (chartInput.collisionMode !== undefined && !['show-all', 'hide-overlap'].includes(String(chartInput.collisionMode))) return fail(`${layerPath}.chart.collisionMode`, 'unsupported_value', 'Chart collisionMode must be show-all or hide-overlap.');
      const maxValue = chartInput.maxValue === undefined ? undefined : asFiniteNumber(chartInput.maxValue);
      if (chartInput.type === 'bar' && (maxValue === undefined || maxValue === null || maxValue <= 0)) return fail(`${layerPath}.chart.maxValue`, 'out_of_range', 'Bar charts require a positive maxValue.');
      const trackColor = chartInput.trackColor === undefined ? undefined : asString(chartInput.trackColor, 9);
      if (trackColor !== undefined && (trackColor === null || !HEX_COLOR_RE.test(trackColor))) return fail(`${layerPath}.chart.trackColor`, 'unsupported_value', 'Chart trackColor must be a hex color.');
      const labelField = chartInput.labelField === undefined ? undefined : asString(chartInput.labelField, 100);
      if (chartInput.labelField !== undefined && !labelField) return fail(`${layerPath}.chart.labelField`, 'invalid_type', 'Chart labelField must be a non-empty field name.');
      if (chartInput.labelFormat !== undefined && !['text', 'integer', 'decimal', 'percent'].includes(String(chartInput.labelFormat))) return fail(`${layerPath}.chart.labelFormat`, 'unsupported_value', 'Chart labelFormat must be text, integer, decimal, or percent.');
      chart = {
        type: chartInput.type as NonNullable<GeoLayer['chart']>['type'],
        valueFields,
        colors: chartInput.colors as string[],
        size,
        ...(chartInput.collisionMode ? { collisionMode: chartInput.collisionMode as NonNullable<GeoLayer['chart']>['collisionMode'] } : {}),
        ...(maxValue !== undefined && maxValue !== null ? { maxValue } : {}),
        ...(trackColor ? { trackColor } : {}),
        ...(labelField ? { labelField } : {}),
        ...(chartInput.labelFormat ? { labelFormat: chartInput.labelFormat as NonNullable<GeoLayer['chart']>['labelFormat'] } : {}),
      };
    } else if (layer.chart !== undefined) {
      return fail(`${layerPath}.chart`, 'unsupported_value', 'Only chart layers may define chart settings.');
    }
    const title = layer.title === undefined ? undefined : asString(layer.title, 120);
    if (layer.title !== undefined && !title) return fail(`${layerPath}.title`, 'invalid_type', 'Layer title must be a non-empty string of at most 120 characters.');
    const rawMinZoom = layer.minZoom === undefined ? undefined : asFiniteNumber(layer.minZoom);
    const rawMaxZoom = layer.maxZoom === undefined ? undefined : asFiniteNumber(layer.maxZoom);
    if (rawMinZoom !== undefined && rawMinZoom !== null && (rawMinZoom < 0 || rawMinZoom > 24)) return fail(`${layerPath}.minZoom`, 'out_of_range', 'minZoom must be between 0 and 24.');
    if (rawMaxZoom !== undefined && rawMaxZoom !== null && (rawMaxZoom < 0 || rawMaxZoom > 24)) return fail(`${layerPath}.maxZoom`, 'out_of_range', 'maxZoom must be between 0 and 24.');
    if (rawMinZoom !== undefined && rawMinZoom !== null && rawMaxZoom !== undefined && rawMaxZoom !== null && rawMinZoom > rawMaxZoom) return fail(`${layerPath}.minZoom`, 'out_of_range', 'minZoom cannot be greater than maxZoom.');
    const minZoom = rawMinZoom ?? undefined;
    const maxZoom = rawMaxZoom ?? undefined;
    let popup: GeoLayer['popup'];
    if (layer.popup !== undefined) {
      const popupInput = asRecord(layer.popup);
      if (!popupInput || !Array.isArray(popupInput.fields)) return fail(`${layerPath}.popup.fields`, 'invalid_type', 'Popup fields must be an array.');
      if (popupInput.fields.length > 12) return fail(`${layerPath}.popup.fields`, 'out_of_range', 'A popup can contain at most 12 fields.');
      const fields = popupInput.fields.map(asRecord);
      const invalidFieldIndex = fields.findIndex((field) => !field || !asString(field.field, 100) || !asString(field.label, 100) || (field.format !== undefined && !['text', 'integer', 'decimal', 'percent'].includes(String(field.format))));
      if (invalidFieldIndex >= 0) return fail(`${layerPath}.popup.fields[${invalidFieldIndex}]`, 'unsupported_value', 'Popup field requires field and label; format may be text, integer, decimal, or percent.');
      popup = { fields: popupInput.fields as unknown as NonNullable<GeoLayer['popup']>['fields'] };
    }
    layers.push({
      id: layerId,
      sourceId: layerSourceId,
      type: layerType,
      encoding: parsedEncoding,
      ...(chart ? { chart } : {}),
      ...(title ? { title } : {}),
      ...(typeof layer.visible === 'boolean' ? { visible: layer.visible } : {}),
      ...(minZoom !== undefined ? { minZoom } : {}),
      ...(maxZoom !== undefined ? { maxZoom } : {}),
      ...(popup ? { popup } : {}),
    });
    layerIds.add(layerId);
  }

  const warnings = Array.isArray(metadata.warnings) && metadata.warnings.every((item) => typeof item === 'string')
    ? metadata.warnings.slice(0, 20) as string[]
    : undefined;
  const description = typeof metadata.description === 'string' ? metadata.description.slice(0, 1000) : undefined;
  let controls: GeoSceneSnapshot['controls'];
  if (input.controls !== undefined) {
    const controlsInput = asRecord(input.controls);
    const allowed = new Set(['navigation', 'fullscreen', 'layerSwitcher', 'legend', 'fitToData']);
    if (!controlsInput) return fail('scene.controls', 'invalid_type', 'Controls must be an object.');
    const invalidControl = Object.entries(controlsInput).find(([key, controlValue]) => !allowed.has(key) || typeof controlValue !== 'boolean');
    if (invalidControl) return fail(`scene.controls.${invalidControl[0]}`, 'unsupported_value', 'Control values must be booleans and use a supported control name.');
    controls = controlsInput as GeoSceneSnapshot['controls'];
  }
  let selection: GeoSceneSnapshot['selection'];
  if (input.selection !== undefined) {
    if (!Array.isArray(input.selection)) return fail('scene.selection', 'invalid_type', 'Selection must be an array.');
    if (input.selection.length > 32) return fail('scene.selection', 'out_of_range', 'Selection can contain at most 32 entries.');
    const parsedSelection: NonNullable<GeoSceneSnapshot['selection']> = [];
    for (let index = 0; index < input.selection.length; index++) {
      const item = input.selection[index];
      const selectionPath = `scene.selection[${index}]`;
      const selected = asRecord(item);
      if (!selected) return fail(selectionPath, 'invalid_type', 'Selection entry must be an object.');
      const selectedSourceId = asString(selected.sourceId, 64);
      if (!selectedSourceId || !sourceIds.has(selectedSourceId)) return fail(`${selectionPath}.sourceId`, 'unknown_reference', 'Selection sourceId must reference an existing source.');
      if (!Array.isArray(selected.featureIds)) return fail(`${selectionPath}.featureIds`, 'invalid_type', 'featureIds must be an array.');
      if (selected.featureIds.length > 5_000) return fail(`${selectionPath}.featureIds`, 'out_of_range', 'A selection entry can contain at most 5,000 feature ids.');
      if (!selected.featureIds.every((id) => typeof id === 'string' || finite(id))) return fail(`${selectionPath}.featureIds`, 'invalid_type', 'Feature ids must be strings or finite numbers.');
      const selectedLayerId = selected.layerId === undefined ? undefined : asString(selected.layerId, 64);
      if (selected.layerId !== undefined && !selectedLayerId) return fail(`${selectionPath}.layerId`, 'invalid_type', 'Selection layerId must be a string.');
      if (selectedLayerId && !layerIds.has(selectedLayerId)) return fail(`${selectionPath}.layerId`, 'unknown_reference', 'Selection layerId must reference an existing layer.');
      if (selectedLayerId && layers.find((layer) => layer.id === selectedLayerId)?.sourceId !== selectedSourceId) return fail(`${selectionPath}.layerId`, 'unsupported_value', 'Selected layer must use the selected source.');
      parsedSelection.push({ sourceId: selectedSourceId, ...(selectedLayerId ? { layerId: selectedLayerId } : {}), featureIds: selected.featureIds as unknown as Array<string | number> });
    }
    selection = parsedSelection;
  }
  return { ok: true, value: {
    view,
    basemap: { id: basemap.id as GeoSceneSnapshot['basemap']['id'] },
    sources,
    layers,
    ...(controls ? { controls } : {}),
    ...(selection ? { selection } : {}),
    metadata: { title: metadataTitle, ...(description ? { description } : {}), ...(warnings ? { warnings } : {}) },
  }, diagnostics: [] };
}

function resultByDiagnostic(diagnostics: ContractDiagnostic[]): ValidationResult<never> {
  return { ok: false, value: null, issues: diagnostics.map((diag) => ({ path: diag.path, code: diag.code, message: diag.message })) };
}

/* -------------------------------------------------------------------------- */
/*                              Envelope parser                               */
/* -------------------------------------------------------------------------- */

export type VisualizationEnvelopeResult = GeoParseResult<VisualizationEnvelope>;

export function parseVisualizationEnvelopeStructured(value: unknown, sink: ContractDiagnostic[] = []): VisualizationEnvelopeResult {
  const diagnostics = sink;
  const fail = (path: string, code: string, message: string): VisualizationEnvelopeResult => ({
    ok: false, value: null, diagnostics: [...diagnostics, diagnostic({ code: code as ContractDiagnostic['code'], path, message })],
  });
  const input = asRecord(value);
  if (!input) return fail('envelope', 'invalid_type', 'Envelope must be an object.');
  if (input.protocol !== GEO_ENVELOPE_PROTOCOL) {
    return fail('envelope.protocol', 'unknown_schema_version', `Unknown envelope protocol ${JSON.stringify(input.protocol)}; expected ${GEO_ENVELOPE_PROTOCOL}.`);
  }
  if (input.version !== GEO_ENVELOPE_VERSION) {
    return fail('envelope.version', 'unknown_schema_version', `Unknown envelope version ${JSON.stringify(input.version)}; expected ${GEO_ENVELOPE_VERSION}.`);
  }
  if (input.kind !== 'geo') return fail('envelope.kind', 'unsupported_value', `Unknown envelope kind ${JSON.stringify(input.kind)}; expected "geo".`);

  const visualizationId = asString(input.visualizationId, 80);
  if (!visualizationId || !SOURCE_ID_RE.test(visualizationId)) {
    return fail('envelope.visualizationId', 'invalid_type', 'visualizationId must be a 1-80 char identifier.');
  }
  const revision = asInteger(input.revision);
  if (revision === null || revision < 1) {
    return fail('envelope.revision', 'out_of_range', 'revision must be a positive integer.');
  }
  if (!['replace', 'patch', 'focus', 'select', 'clear'].includes(String(input.operation))) {
    return fail('envelope.operation', 'unsupported_value', 'operation must be replace, patch, focus, select, or clear.');
  }
  const summary = asRecord(input.summary);
  if (!summary || !asString(summary.title, 160)) return fail('envelope.summary.title', 'missing_required_field', 'summary.title is required and must be at most 160 characters.');
  const generatedAt = asString(input.generatedAt, 64);
  if (!generatedAt) return fail('envelope.generatedAt', 'invalid_type', 'generatedAt must be a string of at most 64 chars (typically ISO timestamp).');

  let scene: GeoSceneSnapshot | null = null;
  if (input.scene !== null) {
    const sceneResult = parseGeoScene(input.scene);
    if (!sceneResult.ok) return fail('envelope.scene', 'unsupported_value', `scene failed validation: ${sceneResult.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
    scene = sceneResult.value;
  }
  if ((input.operation === 'clear') !== (scene === null)) {
    return fail('envelope.scene', 'unsupported_value', 'operation="clear" requires scene=null; other operations require a non-null scene.');
  }
  return {
    ok: true,
    value: {
      protocol: GEO_ENVELOPE_PROTOCOL,
      version: GEO_ENVELOPE_VERSION,
      kind: 'geo',
      visualizationId,
      revision,
      operation: input.operation as GeoEnvelopeOperation,
      scene,
      summary: { title: summary.title as string, ...(typeof summary.description === 'string' ? { description: summary.description.slice(0, 1000) } : {}) },
      generatedAt: generatedAt as string,
    },
    diagnostics: [],
  };
}

/**
 * Backwards-compatible boolean parser used by the Web Feature host: returns
 * the Envelope on success or `null` on any failure (covers all diagnostic
 * severities).
 */
export function parseVisualizationEnvelope(value: unknown): VisualizationEnvelope | null {
  return parseVisualizationEnvelopeStructured(value).value;
}

export function getVisualizationFromToolResult(result: unknown): VisualizationEnvelope | null {
  const root = asRecord(result);
  const details = asRecord(root?.details as JsonRecord | undefined);
  return parseVisualizationEnvelope(details?.visualization);
}

export function acceptEnvelopeRevision(
  previous: VisualizationEnvelope | null,
  next: VisualizationEnvelope,
): { accepted: boolean; diagnostic?: ContractDiagnostic } {
  if (previous && next.revision <= previous.revision) {
    return {
      accepted: false,
      diagnostic: diagnostic({
        code: 'revision_regression',
        path: 'envelope.revision',
        message: `Incoming envelope revision ${next.revision} is not greater than current ${previous.revision}.`,
        severity: 'warning',
        expected: previous.revision + 1,
        received: next.revision,
      }),
    };
  }
  return { accepted: true };
}

function interactionFail<T>(path: string, code: ContractDiagnostic['code'], message: string): GeoParseResult<T> {
  return { ok: false, value: null, diagnostics: [diagnostic({ path, code, message })] };
}

function interactionId(value: unknown, prefix: 'geoctx_' | 'georeq_') {
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

export function parseGeoClientContext(value: unknown) {
  return parseGeoClientContextStructured(value).value;
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
