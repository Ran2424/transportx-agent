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

export type GeoLayer = {
  id: string;
  sourceId: string;
  type: 'circle' | 'line' | 'fill' | 'label';
  title?: string;
  visible?: boolean;
  minZoom?: number;
  maxZoom?: number;
  encoding: Record<string, GeoVisualValue>;
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

export type VisualizationEnvelope = {
  protocol: 'pi-visualization';
  version: '1.0';
  kind: 'geo';
  visualizationId: string;
  revision: number;
  operation: 'replace' | 'patch' | 'focus' | 'select' | 'clear';
  scene: GeoSceneSnapshot | null;
  summary: { title: string; description?: string };
  generatedAt: string;
};

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
};

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function text(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function coordinatesAreFinite(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (value.every(finite)) return value.length >= 2;
  return value.every(coordinatesAreFinite);
}

export function isFeatureCollection(value: unknown): value is GeoJsonFeatureCollection {
  const root = record(value);
  if (!root || root.type !== 'FeatureCollection' || !Array.isArray(root.features)) return false;
  return root.features.every((item) => {
    const feature = record(item);
    if (!feature || feature.type !== 'Feature') return false;
    if (feature.properties !== null && !record(feature.properties)) return false;
    if (feature.geometry === null) return true;
    const geometry = record(feature.geometry);
    if (!geometry || !text(geometry.type, 40) || !GEOMETRY_TYPES.has(geometry.type)) return false;
    if (geometry.type === 'GeometryCollection') {
      return Array.isArray(geometry.geometries) && geometry.geometries.every((child) => {
        const itemGeometry = record(child);
        return !!itemGeometry && text(itemGeometry.type, 40) && GEOMETRY_TYPES.has(itemGeometry.type) && itemGeometry.type !== 'GeometryCollection' && coordinatesAreFinite(itemGeometry.coordinates);
      });
    }
    return coordinatesAreFinite(geometry.coordinates);
  });
}

function parseView(value: unknown): GeoView | null {
  const input = record(value);
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

function outputMatchesChannel(channel: string, value: unknown) {
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
  const input = record(value);
  if (!input) return null;
  if (input.mode === 'constant' && (isVisualOutput(input.value) || (Array.isArray(input.value) && input.value.every(finite)))) {
    const parsed: GeoVisualValue = { mode: 'constant', value: input.value as string | number | number[] };
    return visualOutputs(parsed).every((output) => outputMatchesChannel(channel, output)) ? parsed : null;
  }
  if (input.mode === 'categorical' && text(input.field, 100) && Array.isArray(input.categories) && input.categories.length <= 64 && isVisualOutput(input.fallback)) {
    const categories = input.categories.map(record);
    if (categories.every((item) => item && ['string', 'number', 'boolean'].includes(typeof item.value) && isVisualOutput(item.output))) {
      const parsed = input as GeoVisualValue;
      return visualOutputs(parsed).every((output) => outputMatchesChannel(channel, output)) ? parsed : null;
    }
  }
  if ((input.mode === 'step' || input.mode === 'continuous') && text(input.field, 100) && Array.isArray(input.stops) && input.stops.length >= 2 && input.stops.length <= 16) {
    const stops = input.stops.map(record);
    if (stops.every((item) => item && finite(item.value) && isVisualOutput(item.output))) {
      const values = stops.map((item) => item!.value as number);
      if (values.every((item, index) => index === 0 || item > values[index - 1])) {
        if (input.mode === 'continuous') {
          const parsed = input as GeoVisualValue;
          return visualOutputs(parsed).every((output) => outputMatchesChannel(channel, output)) ? parsed : null;
        }
        if (isVisualOutput(input.default)) {
          const parsed = input as GeoVisualValue;
          return visualOutputs(parsed).every((output) => outputMatchesChannel(channel, output)) ? parsed : null;
        }
      }
    }
  }
  return null;
}

export function parseGeoScene(value: unknown): GeoSceneSnapshot | null {
  const input = record(value);
  if (!input || !Array.isArray(input.sources) || !Array.isArray(input.layers) || input.sources.length > 32 || input.layers.length > 64) return null;
  const view = parseView(input.view);
  const basemap = record(input.basemap);
  const metadata = record(input.metadata);
  if (!view || !basemap || !['default', 'light', 'dark', 'none'].includes(String(basemap.id)) || !metadata || !text(metadata.title, 160)) return null;

  const sources: GeoSource[] = [];
  const sourceIds = new Set<string>();
  for (const item of input.sources) {
    const source = record(item);
    if (!source || !text(source.id, 64) || !SOURCE_ID_RE.test(source.id) || sourceIds.has(source.id)) return null;
    sourceIds.add(source.id);
    const idField = source.idField === undefined ? undefined : source.idField;
    if (idField !== undefined && !text(idField, 100)) return null;
    if (source.type === 'geojson-inline' && isFeatureCollection(source.data)) {
      if (source.data.features.length > MAX_INLINE_FEATURES || new TextEncoder().encode(JSON.stringify(source.data)).byteLength > MAX_INLINE_BYTES) return null;
      sources.push({ id: source.id, type: source.type, data: source.data, ...(idField ? { idField } : {}) });
    } else if (source.type === 'geojson-resource' && text(source.resourceId, 80) && RESOURCE_ID_RE.test(source.resourceId)) {
      sources.push({ id: source.id, type: source.type, resourceId: source.resourceId, ...(idField ? { idField } : {}) });
    } else return null;
  }

  const layers: GeoLayer[] = [];
  const layerIds = new Set<string>();
  for (const item of input.layers) {
    const layer = record(item);
    if (!layer || !text(layer.id, 64) || !SOURCE_ID_RE.test(layer.id) || layerIds.has(layer.id) || !text(layer.sourceId, 64) || !sourceIds.has(layer.sourceId)) return null;
    if (!['circle', 'line', 'fill', 'label'].includes(String(layer.type))) return null;
    const layerType = layer.type as GeoLayer['type'];
    const encoding = record(layer.encoding);
    if (!encoding) return null;
    const parsedEncoding: Record<string, GeoVisualValue> = {};
    for (const [channel, channelValue] of Object.entries(encoding)) {
      if (!LAYER_CHANNELS[layerType].has(channel)) return null;
      const parsed = parseVisualValue(channelValue, channel);
      if (!parsed) return null;
      parsedEncoding[channel] = parsed;
    }
    if (layerType === 'label' && !parsedEncoding.textField) return null;
    const title = layer.title === undefined ? undefined : layer.title;
    if (title !== undefined && !text(title, 120)) return null;
    if (layer.minZoom !== undefined && (!finite(layer.minZoom) || layer.minZoom < 0 || layer.minZoom > 24)) return null;
    if (layer.maxZoom !== undefined && (!finite(layer.maxZoom) || layer.maxZoom < 0 || layer.maxZoom > 24)) return null;
    if (finite(layer.minZoom) && finite(layer.maxZoom) && layer.minZoom > layer.maxZoom) return null;
    let popup: GeoLayer['popup'];
    if (layer.popup !== undefined) {
      const popupInput = record(layer.popup);
      if (!popupInput || !Array.isArray(popupInput.fields) || popupInput.fields.length > 12) return null;
      const fields = popupInput.fields.map(record);
      if (!fields.every((field) => field && text(field.field, 100) && text(field.label, 100) && (field.format === undefined || ['text', 'integer', 'decimal', 'percent'].includes(String(field.format))))) return null;
      popup = { fields: popupInput.fields as NonNullable<GeoLayer['popup']>['fields'] };
    }
    layers.push({
      id: layer.id,
      sourceId: layer.sourceId,
      type: layerType,
      encoding: parsedEncoding,
      ...(title ? { title } : {}),
      ...(typeof layer.visible === 'boolean' ? { visible: layer.visible } : {}),
      ...(finite(layer.minZoom) ? { minZoom: layer.minZoom } : {}),
      ...(finite(layer.maxZoom) ? { maxZoom: layer.maxZoom } : {}),
      ...(popup ? { popup } : {}),
    });
    layerIds.add(layer.id);
  }

  const warnings = Array.isArray(metadata.warnings) && metadata.warnings.every((item) => typeof item === 'string')
    ? metadata.warnings.slice(0, 20) as string[]
    : undefined;
  const description = typeof metadata.description === 'string' ? metadata.description.slice(0, 1000) : undefined;
  let controls: GeoSceneSnapshot['controls'];
  if (input.controls !== undefined) {
    const controlsInput = record(input.controls);
    const allowed = new Set(['navigation', 'fullscreen', 'layerSwitcher', 'legend', 'fitToData']);
    if (!controlsInput || Object.entries(controlsInput).some(([key, value]) => !allowed.has(key) || typeof value !== 'boolean')) return null;
    controls = controlsInput as GeoSceneSnapshot['controls'];
  }
  let selection: GeoSceneSnapshot['selection'];
  if (input.selection !== undefined) {
    if (!Array.isArray(input.selection) || input.selection.length > 32) return null;
    const parsedSelection: NonNullable<GeoSceneSnapshot['selection']> = [];
    for (const item of input.selection) {
      const selected = record(item);
      if (!selected || !text(selected.sourceId, 64) || !sourceIds.has(selected.sourceId) || !Array.isArray(selected.featureIds) || selected.featureIds.length > 5_000) return null;
      if (!selected.featureIds.every((id) => typeof id === 'string' || finite(id))) return null;
      const layerId = selected.layerId === undefined ? undefined : selected.layerId;
      if (layerId !== undefined && (!text(layerId, 64) || !layerIds.has(layerId) || layers.find((layer) => layer.id === layerId)?.sourceId !== selected.sourceId)) return null;
      parsedSelection.push({ sourceId: selected.sourceId, ...(layerId ? { layerId } : {}), featureIds: selected.featureIds as Array<string | number> });
    }
    selection = parsedSelection;
  }
  return {
    view,
    basemap: { id: basemap.id as GeoSceneSnapshot['basemap']['id'] },
    sources,
    layers,
    ...(controls ? { controls } : {}),
    ...(selection ? { selection } : {}),
    metadata: { title: metadata.title, ...(description ? { description } : {}), ...(warnings ? { warnings } : {}) },
  };
}

export function parseVisualizationEnvelope(value: unknown): VisualizationEnvelope | null {
  const input = record(value);
  if (!input || input.protocol !== 'pi-visualization' || input.version !== '1.0' || input.kind !== 'geo') return null;
  if (!text(input.visualizationId, 80) || !SOURCE_ID_RE.test(input.visualizationId) || !Number.isInteger(input.revision) || (input.revision as number) < 1) return null;
  if (!['replace', 'patch', 'focus', 'select', 'clear'].includes(String(input.operation))) return null;
  const summary = record(input.summary);
  if (!summary || !text(summary.title, 160) || !text(input.generatedAt, 64)) return null;
  const scene = input.scene === null ? null : parseGeoScene(input.scene);
  if (input.operation !== 'clear' && !scene) return null;
  if (input.operation === 'clear' && input.scene !== null) return null;
  return {
    protocol: 'pi-visualization',
    version: '1.0',
    kind: 'geo',
    visualizationId: input.visualizationId,
    revision: input.revision as number,
    operation: input.operation as VisualizationEnvelope['operation'],
    scene,
    summary: { title: summary.title, ...(typeof summary.description === 'string' ? { description: summary.description.slice(0, 1000) } : {}) },
    generatedAt: input.generatedAt,
  };
}

export function getVisualizationFromToolResult(result: unknown): VisualizationEnvelope | null {
  const root = record(result);
  const details = record(root?.details);
  return parseVisualizationEnvelope(details?.visualization);
}
