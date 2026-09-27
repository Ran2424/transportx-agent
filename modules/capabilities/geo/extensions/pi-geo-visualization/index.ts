import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  isFeatureCollection,
  parseGeoScene,
  parseVisualizationEnvelope,
  formatSceneValidationErrors,
  type GeoJsonFeatureCollection,
  type GeoLayer,
  type GeoSceneSnapshot,
  type GeoSource,
  type GeoVisualValue,
  type GeoView,
  type VisualizationEnvelope,
} from '../../../../../src/contracts/index.ts';

type SceneState = { revision: number; scene: GeoSceneSnapshot | null };
type PresentCommand = { command: string; visualizationId: string; [key: string]: any };

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_FEATURES = 50_000;
const EXTENSION_RUNTIME_ID = 'pi-geo-visualization-command-v2';

function canvasPresentation(envelope: VisualizationEnvelope) {
  const resources = envelope.scene?.sources.flatMap((source) => source.type === 'geojson-resource'
    ? [{ scope: 'capability' as const, moduleId: 'com.transportx.geo', resourceId: source.resourceId, revision: envelope.revision }]
    : []) ?? [];
  return {
    protocol: 'pi-canvas' as const,
    version: '1.0' as const,
    presentationId: crypto.randomUUID(),
    adapterId: 'com.transportx.canvas.geo',
    kind: 'geo',
    viewId: `geo:${envelope.visualizationId}`,
    revision: envelope.revision,
    operation: envelope.operation === 'focus' ? 'focus' as const : envelope.operation === 'clear' ? 'clear' as const : envelope.revision === 1 ? 'present' as const : 'update' as const,
    title: envelope.summary.title,
    resources,
    payload: envelope,
    generatedAt: envelope.generatedAt,
  };
}

const BasemapIdSchema = Type.Union(
  [Type.Literal('default'), Type.Literal('light'), Type.Literal('dark'), Type.Literal('none')],
  { description: 'Use light/default for most maps, dark for high-contrast dashboards, and none only for an intentionally blank or offline canvas' },
);

const PopupSchema = Type.Object({
  fields: Type.Array(Type.Object({
    field: Type.String(), label: Type.String(),
    format: Type.Optional(Type.Union([Type.Literal('text'), Type.Literal('integer'), Type.Literal('decimal'), Type.Literal('percent')])),
  })),
});

const VisualizationIdSchema = Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' });
const ItemIdSchema = Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' });
const ResourceIdSchema = Type.String({ pattern: '^geo_[a-f0-9]{16,64}$' });
const LayerTypeSchema = Type.Union([Type.Literal('circle'), Type.Literal('line'), Type.Literal('fill'), Type.Literal('label'), Type.Literal('chart')]);
const ChartTypeSchema = Type.Union([Type.Literal('pie'), Type.Literal('donut'), Type.Literal('bar')]);
const ChartCollisionModeSchema = Type.Union([Type.Literal('show-all'), Type.Literal('hide-overlap')]);
const ChannelSchema = Type.Union([
  Type.Literal('color'), Type.Literal('radius'), Type.Literal('opacity'), Type.Literal('strokeColor'),
  Type.Literal('strokeWidth'), Type.Literal('width'), Type.Literal('dash'), Type.Literal('outlineColor'),
  Type.Literal('textField'), Type.Literal('size'), Type.Literal('haloColor'), Type.Literal('haloWidth'),
]);
// Pi runs TypeBox Value.Convert before execute(). Keep Number before String so
// numeric style values are not coerced to strings by the first union branch.
const VisualOutputSchema = Type.Union([Type.Number(), Type.String(), Type.Array(Type.Number())]);
const NumericStopSchema = Type.Object({ value: Type.Number(), output: Type.Union([Type.Number(), Type.String()]) });
const CategorySchema = Type.Object({
  value: Type.Union([Type.Number(), Type.String(), Type.Boolean()]),
  output: Type.Union([Type.Number(), Type.String()]),
});

const PresentVisualizationCommandSchema = Type.Object({
  command: Type.Union([
    Type.Literal('create_map'), Type.Literal('add_layer'), Type.Literal('set_constant'), Type.Literal('set_step'),
    Type.Literal('set_continuous'), Type.Literal('set_categorical'), Type.Literal('set_popup'),
    Type.Literal('set_controls'), Type.Literal('set_metadata'), Type.Literal('set_camera'),
    Type.Literal('fit_bounds'), Type.Literal('set_visibility'), Type.Literal('remove_layer'),
    Type.Literal('reorder_layers'), Type.Literal('select'), Type.Literal('clear'), Type.Literal('show_map'),
    Type.Literal('add_chart_layer'), Type.Literal('set_chart'),
  ], { description: 'One atomic scene mutation: create/add content, change one style or popup/control/metadata concern, focus/select, or clear. create_map starts a visualizationId; later commands update it.' }),
  visualizationId: VisualizationIdSchema,
  title: Type.Optional(Type.String({ description: 'Map title for create_map, or replacement title for set_metadata.' })),
  description: Type.Optional(Type.String()),
  warnings: Type.Optional(Type.Array(Type.String())),
  resourceId: Type.Optional(ResourceIdSchema),
  sourceId: Type.Optional(ItemIdSchema),
  idField: Type.Optional(Type.String()),
  layerId: Type.Optional(ItemIdSchema),
  layerType: Type.Optional(LayerTypeSchema),
  layerTitle: Type.Optional(Type.String()),
  color: Type.Optional(Type.String()),
  textField: Type.Optional(Type.String()),
  basemap: Type.Optional(BasemapIdSchema),
  visible: Type.Optional(Type.Boolean()),
  channel: Type.Optional(ChannelSchema),
  value: Type.Optional(VisualOutputSchema),
  field: Type.Optional(Type.String()),
  defaultValue: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  stops: Type.Optional(Type.Array(NumericStopSchema, { minItems: 2, maxItems: 16 })),
  categories: Type.Optional(Type.Array(CategorySchema, { minItems: 1, maxItems: 64 })),
  fallback: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  fields: Type.Optional(PopupSchema.properties.fields),
  navigation: Type.Optional(Type.Boolean()),
  fullscreen: Type.Optional(Type.Boolean()),
  layerSwitcher: Type.Optional(Type.Boolean()),
  legend: Type.Optional(Type.Boolean()),
  fitToData: Type.Optional(Type.Boolean()),
  center: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
  zoom: Type.Optional(Type.Number()),
  bounds: Type.Optional(Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()])),
  padding: Type.Optional(Type.Number()),
  layerIds: Type.Optional(Type.Array(ItemIdSchema, { minItems: 1, maxItems: 64 })),
  featureIds: Type.Optional(Type.Array(Type.Union([Type.Number(), Type.String()]), { maxItems: 5000 })),
  chartType: Type.Optional(ChartTypeSchema),
  valueFields: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 5 })),
  colors: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 5 })),
  size: Type.Optional(Type.Number({ minimum: 16, maximum: 96 })),
  collisionMode: Type.Optional(ChartCollisionModeSchema),
  maxValue: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  trackColor: Type.Optional(Type.String()),
  labelField: Type.Optional(Type.String()),
  labelFormat: Type.Optional(Type.Union([Type.Literal('text'), Type.Literal('integer'), Type.Literal('decimal'), Type.Literal('percent')])),
}, { description: 'Flat command parameters. Do not pass a scene JSON object.' });

const COMMAND_REQUIRED_PARAMS: Record<string, string[]> = {
  create_map: ['title', 'resourceId', 'layerType'],
  add_layer: ['sourceId', 'layerId', 'layerType'],
  set_constant: ['layerId', 'channel', 'value'],
  set_step: ['layerId', 'channel', 'field', 'defaultValue', 'stops'],
  set_continuous: ['layerId', 'channel', 'field', 'stops'],
  set_categorical: ['layerId', 'channel', 'field', 'categories', 'fallback'],
  set_popup: ['layerId', 'fields'],
  set_camera: ['center', 'zoom'],
  fit_bounds: ['bounds'],
  set_visibility: ['layerId', 'visible'],
  remove_layer: ['layerId'],
  reorder_layers: ['layerIds'],
  select: ['sourceId', 'featureIds'],
  add_chart_layer: ['sourceId', 'layerId', 'chartType', 'valueFields'],
  set_chart: ['layerId', 'chartType', 'valueFields'],
};

function assertCommandParams(params: PresentCommand) {
  const required = COMMAND_REQUIRED_PARAMS[params.command] || [];
  const missing = required.filter((name) => params[name] === undefined || params[name] === null || params[name] === '');
  if (missing.length) throw new Error(`Missing parameters for command ${params.command}: ${missing.join(', ')}`);
  if ((params.layerType === 'chart' || params.command === 'add_chart_layer' || params.command === 'set_chart') && params.chartType === 'bar' && !(params.maxValue > 0)) {
    throw new Error('Bar charts require a positive maxValue.');
  }
  if (params.layerType === 'chart' && (!params.chartType || !params.valueFields?.length)) {
    throw new Error('Chart layers require chartType and valueFields.');
  }
}

function isWithin(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function walkCoordinates(value: unknown, visitor: (lng: number, lat: number) => void): void {
  if (!Array.isArray(value) || value.length === 0) return;
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    visitor(value[0], value[1]);
    return;
  }
  for (const child of value) walkCoordinates(child, visitor);
}

function inspectGeoJson(data: GeoJsonFeatureCollection, idField?: string) {
  if (data.features.length > MAX_FEATURES) {
    throw new Error(`GeoJSON has ${data.features.length} features; the limit is ${MAX_FEATURES}. Aggregate, simplify, or split the data before publication.`);
  }
  const types = new Set<string>();
  const ids = new Set<string>();
  const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [featureIndex, feature] of data.features.entries()) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    types.add(geometry.type);
    if (idField) {
      const value = feature.properties?.[idField];
      if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`features[${featureIndex}].properties.${idField} is missing or is not a string/number`);
      const key = String(value);
      if (ids.has(key)) throw new Error(`features[${featureIndex}].properties.${idField} duplicates id value: ${key}`);
      ids.add(key);
    }
    const visit = (lng: number, lat: number) => {
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        throw new Error(`features[${featureIndex}] contains coordinates outside WGS84 longitude/latitude ranges`);
      }
      bounds[0] = Math.min(bounds[0], lng);
      bounds[1] = Math.min(bounds[1], lat);
      bounds[2] = Math.max(bounds[2], lng);
      bounds[3] = Math.max(bounds[3], lat);
    };
    if (geometry.type === 'GeometryCollection') {
      for (const child of geometry.geometries || []) walkCoordinates(child.coordinates, visit);
    } else walkCoordinates(geometry.coordinates, visit);
  }
  return {
    geometryTypes: Array.from(types).sort(),
    bounds: bounds.every(Number.isFinite) ? bounds : null,
  };
}

function resourceDirectory(cwd: string, resourceId: string) {
  return path.join(cwd, '.tau', 'geo-resources', resourceId);
}

function readResourceManifest(cwd: string, resourceId: string) {
  const manifestPath = path.join(resourceDirectory(cwd, resourceId), 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`Geo resource not found: ${resourceId}`);
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    resourceId: string;
    bounds?: [number, number, number, number] | null;
    idField?: string;
  };
}

function viewForBounds(bounds: [number, number, number, number] | null | undefined): GeoView {
  if (!bounds) return { mode: 'bounds', bounds: [-180, -85, 180, 85], padding: 24 };
  let [west, south, east, north] = bounds;
  const lngPadding = west === east ? 0.01 : 0;
  const latPadding = south === north ? 0.01 : 0;
  west = Math.max(-180, west - lngPadding);
  east = Math.min(180, east + lngPadding);
  south = Math.max(-90, south - latPadding);
  north = Math.min(90, north + latPadding);
  return { mode: 'bounds', bounds: [west, south, east, north], padding: 24 };
}

function initialLayer(params: PresentCommand, sourceId: string, layerId: string): GeoLayer {
  const encoding: Record<string, GeoVisualValue> = {};
  if (params.layerType === 'chart') {
    return {
      id: layerId,
      sourceId,
      type: 'chart',
      encoding,
      chart: chartSettings(params),
      ...(params.layerTitle ? { title: params.layerTitle } : {}),
      ...(typeof params.visible === 'boolean' ? { visible: params.visible } : {}),
    };
  } else if (params.layerType === 'label') {
    if (params.textField) encoding.textField = { mode: 'constant', value: params.textField };
    encoding.color = { mode: 'constant', value: params.color || '#172033' };
  } else {
    encoding.color = { mode: 'constant', value: params.color || '#2563eb' };
  }
  return {
    id: layerId,
    sourceId,
    type: params.layerType,
    encoding,
    ...(params.layerTitle ? { title: params.layerTitle } : {}),
    ...(typeof params.visible === 'boolean' ? { visible: params.visible } : {}),
  };
}

const DEFAULT_CHART_COLORS = ['#34c79b', '#8268bd', '#e8795b', '#4f8edc', '#e2b93b'];

function chartSettings(params: PresentCommand): NonNullable<GeoLayer['chart']> {
  return {
    type: params.chartType,
    valueFields: params.valueFields,
    colors: params.colors?.length ? params.colors : DEFAULT_CHART_COLORS.slice(0, params.valueFields.length),
    size: params.size ?? 40,
    collisionMode: params.collisionMode ?? 'show-all',
    ...(params.maxValue !== undefined ? { maxValue: params.maxValue } : {}),
    ...(params.trackColor ? { trackColor: params.trackColor } : {}),
    ...(params.labelField ? { labelField: params.labelField } : {}),
    ...(params.labelFormat ? { labelFormat: params.labelFormat } : {}),
  };
}

function requireCurrentScene(current: SceneState | undefined, visualizationId: string) {
  if (!current?.scene) throw new Error(`Visualization not found: ${visualizationId}`);
  return current.scene;
}

function validatedScene(value: unknown, prefix: string) {
  const result = parseGeoScene(value);
  if (!result.ok) throw new Error(formatSceneValidationErrors(prefix, result));
  return result.value;
}

function styleCommandKey(params: PresentCommand) {
  if (!['set_constant', 'set_step', 'set_continuous', 'set_categorical'].includes(params.command)) return null;
  return [params.visualizationId, params.command, params.layerId, params.channel].join('|');
}

function styleCommandDiagnostic(params: PresentCommand) {
  if (params.command === 'set_constant') return `value=${JSON.stringify(params.value)} type=${typeof params.value}`;
  if (params.command === 'set_categorical') {
    const outputs = Array.isArray(params.categories) ? params.categories.map((item: { output?: unknown }) => `${JSON.stringify(item.output)}:${typeof item.output}`) : [];
    return `outputs=[${outputs.join(', ')}] fallback=${JSON.stringify(params.fallback)}:${typeof params.fallback}`;
  }
  const outputs = Array.isArray(params.stops) ? params.stops.map((stop: { output?: unknown }) => `${JSON.stringify(stop.output)}:${typeof stop.output}`) : [];
  return `outputs=[${outputs.join(', ')}]${params.command === 'set_step' ? ` default=${JSON.stringify(params.defaultValue)}:${typeof params.defaultValue}` : ''}`;
}

function updateLayer(scene: GeoSceneSnapshot, layerId: string, updater: (layer: GeoLayer) => GeoLayer) {
  const index = scene.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) throw new Error(`Layer not found: ${layerId}`);
  const layers = scene.layers.slice();
  layers[index] = updater(layers[index]);
  return { ...scene, layers };
}

function assertSceneResources(cwd: string, scene: GeoSceneSnapshot) {
  for (const source of scene.sources) {
    if (source.type !== 'geojson-resource') continue;
    const manifest = path.join(resourceDirectory(cwd, source.resourceId), 'manifest.json');
    if (!fs.existsSync(manifest)) throw new Error(`Geo resource not found: ${source.resourceId}`);
  }
}

const InspectMapContextSchema = Type.Object({
  contextIds: Type.Optional(Type.Array(Type.String({ pattern: '^geoctx_[A-Za-z0-9_-]{12,64}$' }), { maxItems: 8 })),
  maxFeatures: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  includeProvenance: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const RequestGeoInputSchema = Type.Object({
  visualizationId: VisualizationIdSchema,
  sceneRevision: Type.Integer({ minimum: 1 }),
  mode: Type.Union([Type.Literal('feature'), Type.Literal('point'), Type.Literal('rectangle'), Type.Literal('viewport')]),
  prompt: Type.String({ minLength: 1, maxLength: 500 }),
  required: Type.Optional(Type.Boolean()),
  targetLayerIds: Type.Optional(Type.Array(ItemIdSchema, { minItems: 1, maxItems: 32 })),
  maxFeatures: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 30, maximum: 1800 })),
}, { additionalProperties: false });

const CaptureGeoScreenshotSchema = Type.Object({
  visualizationId: VisualizationIdSchema,
  sceneRevision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

function geoHost() {
  const endpoint = process.env.TAU_GEO_ENDPOINT;
  const sessionId = process.env.TAU_GEO_SESSION_ID;
  const token = process.env.TAU_GEO_TOKEN;
  if (!endpoint || !sessionId || !token) throw new Error('Geo Agent Host bridge is unavailable for this session.');
  return { endpoint, sessionId, token };
}

async function geoHostCall(pathname: 'inspect' | 'request' | 'screenshot', body: Record<string, unknown>, signal?: AbortSignal) {
  const host = geoHost();
  const response = await fetch(`${host.endpoint}/api/internal/geo/${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, sessionId: host.sessionId, token: host.token }),
    signal,
  });
  const payload = await response.json() as { error?: string; result?: unknown };
  if (!response.ok) throw new Error(payload.error || 'Geo Agent Host request failed.');
  return payload.result;
}

export default function geoVisualizationExtension(pi: ExtensionAPI) {
  const scenes = new Map<string, SceneState>();
  const failedValidations = new Map<string, { count: number; message: string }>();

  const restore = (ctx: ExtensionContext) => {
    scenes.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'message' || entry.message.role !== 'toolResult') continue;
      const details = entry.message.details as { visualization?: unknown } | undefined;
      const envelope = parseVisualizationEnvelope(details?.visualization);
      if (!envelope) continue;
      if ((scenes.get(envelope.visualizationId)?.revision || 0) < envelope.revision) {
        scenes.set(envelope.visualizationId, { revision: envelope.revision, scene: envelope.scene });
      }
    }
  };

  pi.on('session_start', async (_event, ctx) => restore(ctx));
  pi.on('session_tree', async (_event, ctx) => restore(ctx));

  pi.registerTool({
    name: 'inspect_map_context',
    label: 'Inspect Map Context',
    description: 'Read explicitly named Geo Contexts, or the Geo Contexts attached to the current user turn. Never falls back to a previous turn.',
    promptSnippet: 'Inspect verified map selections attached to the current user turn',
    promptGuidelines: ['Call this first when the current user message carries Geo Context IDs. Treat multiple Contexts separately; do not infer a union or intersection.'],
    parameters: InspectMapContextSchema,
    async execute(_toolCallId, params, signal) {
      const result = await geoHostCall('inspect', params as Record<string, unknown>, signal);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: { kind: 'tau-geo-context' as const, result } };
    },
  });

  pi.registerTool({
    name: 'request_geo_input',
    label: 'Request Map Input',
    description: 'Ask the user to select verified features, a WGS84 point, an axis-aligned rectangle, or the current viewport on an existing map, then wait for the terminal response.',
    promptSnippet: 'Request one structured map input when the user must identify a location, feature, or extent',
    promptGuidelines: ['Handle submitted, cancelled, expired, aborted, and invalidated as distinct outcomes. Do not ask the user to type coordinates that can be selected on the map.'],
    parameters: RequestGeoInputSchema,
    async execute(_toolCallId, params, signal) {
      const result = await geoHostCall('request', params as Record<string, unknown>, signal);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: { kind: 'tau-geo-interaction' as const, result } };
    },
  });

  pi.registerTool({
    name: 'capture_geo_screenshot',
    label: 'Capture Map Screenshot',
    description: 'Capture the finalized browser-rendered map, legend, and description as a PNG in the current task directory.',
    promptSnippet: 'Capture a finalized Geo visualization for use in reports or other task artifacts',
    promptGuidelines: [
      'Call this only after the map has its final scene revision and camera.',
      'Use the returned relativePath directly in Markdown image syntax when the screenshot belongs in a report.',
      'A screenshot is a presentation artifact, not a substitute for querying or validating the underlying GIS data.',
    ],
    parameters: CaptureGeoScreenshotSchema,
    async execute(_toolCallId, params, signal) {
      const result = await geoHostCall('screenshot', params as Record<string, unknown>, signal) as { status?: string; reason?: string; relativePath?: string };
      if (result.status !== 'captured' || !result.relativePath) throw new Error(`Map screenshot failed: ${result.reason || 'unknown error'}`);
      return {
        content: [{ type: 'text' as const, text: `Saved map screenshot to ${result.relativePath}. Use ![map description](${result.relativePath}) to include it in Markdown reports.` }],
        details: { kind: 'tau-geo-screenshot' as const, result },
      };
    },
  });

  pi.registerTool({
    name: 'publish_geodata',
    label: 'Publish GeoJSON',
    description: 'Publish a GeoJSON file from the current task as a session-scoped web map resource.',
    promptSnippet: 'Publish GeoJSON files for use in interactive maps',
    promptGuidelines: [
      'Read the geo-visualization-explanation skill before first using publish_geodata or present_visualization for a map task.',
      'Write generated GeoJSON in the current task working directory, then call publish_geodata with a path relative to that directory.',
    ],
    parameters: Type.Object({
      path: Type.String({ description: 'GeoJSON path inside the current task directory' }),
      title: Type.Optional(Type.String()),
      idField: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const requested = path.resolve(ctx.cwd, params.path.replace(/^@/, ''));
      const resolved = fs.realpathSync(requested);
      const root = fs.realpathSync(ctx.cwd);
      if (!isWithin(root, resolved)) throw new Error('GeoJSON path is outside the current task directory');
      if (!['.geojson', '.json'].includes(path.extname(resolved).toLowerCase())) throw new Error('Only .geojson and .json files can be published');
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) throw new Error('GeoJSON path is not a file');
      if (stat.size > MAX_BYTES) throw new Error(`GeoJSON file exceeds ${MAX_BYTES} bytes`);
      const raw = fs.readFileSync(resolved);
      const data = JSON.parse(raw.toString('utf8')) as unknown;
      if (!isFeatureCollection(data)) throw new Error('File is not a valid GeoJSON FeatureCollection');
      const inspection = inspectGeoJson(data, params.idField);
      const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
      const resourceId = `geo_${sha256.slice(0, 24)}`;
      const directory = resourceDirectory(ctx.cwd, resourceId);
      fs.mkdirSync(directory, { recursive: true });
      const dataPath = path.join(directory, 'data.geojson');
      const manifestPath = path.join(directory, 'manifest.json');
      if (!fs.existsSync(dataPath)) fs.copyFileSync(resolved, dataPath);
      const resource = {
        resourceId,
        title: params.title || path.basename(resolved),
        format: 'geojson',
        featureCount: data.features.length,
        geometryTypes: inspection.geometryTypes,
        bounds: inspection.bounds,
        idField: params.idField,
        bytes: raw.byteLength,
        sha256,
      };
      fs.writeFileSync(manifestPath, JSON.stringify(resource, null, 2));
      return {
        content: [{ type: 'text', text: `Published ${data.features.length} GeoJSON features as ${resourceId}.` }],
        details: { resource },
      };
    },
  });

  pi.registerTool({
    name: 'present_visualization',
    label: 'Present Map',
    description: 'Open an existing map in the Canvas with show_map, or create/update one revisioned declarative 2D map after GIS data preparation and analysis. The tool owns GeoScene mutations; it does not query or analyze source data.',
    promptSnippet: 'Maintain interactive maps with explicit scene, layer style, popup, control, view, selection, and clear commands',
    promptGuidelines: [
      'Read the geo-visualization-explanation skill before first using publish_geodata or present_visualization for a map task.',
      'Query, aggregate, compare, and validate GIS data before publishing it. present_visualization only turns an analyzed result into a revisioned GeoScene.',
      'Always call publish_geodata first, then pass its resourceId to command=create_map; never hand-write sources, layers, encoding, view, or metadata JSON.',
      'To activate an existing Canvas tab without changing its map or revision, call command=show_map with its visualizationId.',
      'Use create_map once per visualizationId. Afterwards change exactly one concern per command: layer, style, popup, controls, metadata, view, selection, or clear.',
      'Reuse the same visualizationId for follow-up requests about the same analysis. Create another visualizationId only when the user explicitly asks for a separate map.',
      'Use the channel names color, radius, opacity, strokeColor, strokeWidth, width, dash, outlineColor, textField, size, haloColor, and haloWidth exactly as declared by the command schema.',
      'Use add_chart_layer for point-based pie, donut, or bar symbols. valueFields drive the chart; bar charts also require maxValue. Charts default to collisionMode=show-all so every point remains visible; use hide-overlap only when occlusion is acceptable. Use labelFormat=text for name fields. Use set_chart to replace one chart layer configuration without rebuilding the map.',
      'Use remove_layer to remove one layer while retaining its data source, and use reorder_layers with the complete current layerId list to control draw order from bottom to top. Do not omit an existing layer from reorder_layers; it must be a complete permutation.',
      'Reuse the current visualizationId when the user asks to add or overlay content. If the same styling target fails validation twice, preserve the last successful map and stop retrying that command.',
    ],
    parameters: PresentVisualizationCommandSchema,
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const params = rawParams as PresentCommand;
      assertCommandParams(params);
      const current = scenes.get(params.visualizationId);
      if (params.command === 'show_map') {
        const scene = requireCurrentScene(current, params.visualizationId);
        const envelope: VisualizationEnvelope = {
          protocol: 'pi-visualization', version: '1.0', kind: 'geo',
          visualizationId: params.visualizationId, revision: current!.revision,
          operation: 'focus', scene, summary: { title: scene.metadata.title }, generatedAt: new Date().toISOString(),
        };
        return { content: [{ type: 'text' as const, text: `Showing map "${scene.metadata.title}" in Canvas.` }], details: { visualization: envelope, canvas: canvasPresentation(envelope) } };
      }
      let scene: GeoSceneSnapshot | null = null;
      let operation: VisualizationEnvelope['operation'] = 'patch';

      if (params.command === 'create_map') {
        const manifest = readResourceManifest(ctx.cwd, params.resourceId);
        const sourceId = params.sourceId || 'data';
        const layerId = params.layerId || 'layer';
        const source: GeoSource = {
          id: sourceId,
          type: 'geojson-resource',
          resourceId: params.resourceId,
          ...(params.idField || manifest.idField ? { idField: params.idField || manifest.idField } : {}),
        };
        scene = validatedScene({
          view: viewForBounds(manifest.bounds),
          basemap: { id: params.basemap || 'light' },
          sources: [source],
          layers: [initialLayer(params, sourceId, layerId)],
          metadata: {
            title: params.title,
            ...(params.description ? { description: params.description } : {}),
            ...(params.warnings ? { warnings: params.warnings } : {}),
          },
        }, 'Map creation failed validation:');
        operation = 'replace';
      } else if (params.command === 'clear') {
        scene = null;
        operation = 'clear';
      } else {
        const base = requireCurrentScene(current, params.visualizationId);
        let candidate: unknown = base;

        if (params.command === 'add_layer' || params.command === 'add_chart_layer') {
          const sources = new Map(base.sources.map((source) => [source.id, source]));
          if (params.resourceId) {
            const manifest = readResourceManifest(ctx.cwd, params.resourceId);
            sources.set(params.sourceId, {
              id: params.sourceId,
              type: 'geojson-resource',
              resourceId: params.resourceId,
              ...(params.idField || manifest.idField ? { idField: params.idField || manifest.idField } : {}),
            });
          } else if (!sources.has(params.sourceId)) {
            throw new Error(`Source not found: ${params.sourceId}. Provide resourceId when adding a new source.`);
          }
          const layers = new Map(base.layers.map((layer) => [layer.id, layer]));
          const layerParams = params.command === 'add_chart_layer' ? { ...params, layerType: 'chart' } : params;
          layers.set(params.layerId, initialLayer(layerParams, params.sourceId, params.layerId));
          candidate = { ...base, sources: Array.from(sources.values()), layers: Array.from(layers.values()) };
        } else if (params.command === 'set_chart') {
          candidate = updateLayer(base, params.layerId, (layer) => {
            if (layer.type !== 'chart') throw new Error(`Layer is not a chart layer: ${params.layerId}`);
            return { ...layer, chart: chartSettings(params) };
          });
        } else if (['set_constant', 'set_step', 'set_continuous', 'set_categorical'].includes(params.command)) {
          let value: GeoVisualValue;
          if (params.command === 'set_constant') value = { mode: 'constant', value: params.value };
          else if (params.command === 'set_step') value = { mode: 'step', field: params.field, default: params.defaultValue, stops: params.stops };
          else if (params.command === 'set_continuous') value = { mode: 'continuous', field: params.field, stops: params.stops };
          else value = { mode: 'categorical', field: params.field, categories: params.categories, fallback: params.fallback };
          candidate = updateLayer(base, params.layerId, (layer) => ({
            ...layer,
            encoding: { ...layer.encoding, [params.channel]: value },
          }));
        } else if (params.command === 'set_popup') {
          candidate = updateLayer(base, params.layerId, (layer) => ({ ...layer, popup: { fields: params.fields } }));
        } else if (params.command === 'set_controls') {
          const controls = { ...base.controls } as Record<string, boolean>;
          for (const key of ['navigation', 'fullscreen', 'layerSwitcher', 'legend', 'fitToData']) {
            if (typeof params[key] === 'boolean') controls[key] = params[key];
          }
          candidate = { ...base, controls };
        } else if (params.command === 'set_metadata') {
          candidate = {
            ...base,
            metadata: {
              ...base.metadata,
              ...(params.title !== undefined ? { title: params.title } : {}),
              ...(params.description !== undefined ? { description: params.description } : {}),
              ...(params.warnings !== undefined ? { warnings: params.warnings } : {}),
            },
          };
        } else if (params.command === 'set_camera') {
          candidate = { ...base, view: { mode: 'camera', center: params.center, zoom: params.zoom } };
          operation = 'focus';
        } else if (params.command === 'fit_bounds') {
          candidate = { ...base, view: { mode: 'bounds', bounds: params.bounds, ...(params.padding === undefined ? {} : { padding: params.padding }) } };
          operation = 'focus';
        } else if (params.command === 'set_visibility') {
          candidate = updateLayer(base, params.layerId, (layer) => ({ ...layer, visible: params.visible }));
        } else if (params.command === 'remove_layer') {
          if (!base.layers.some((layer) => layer.id === params.layerId)) throw new Error(`Layer not found: ${params.layerId}`);
          const layers = base.layers.filter((layer) => layer.id !== params.layerId);
          const selection = (base.selection || []).filter((entry) => entry.layerId !== params.layerId);
          candidate = {
            ...base,
            layers,
            ...(selection.length ? { selection } : { selection: [] }),
          };
        } else if (params.command === 'reorder_layers') {
          const currentIds = base.layers.map((layer) => layer.id);
          const requestedIds = params.layerIds as string[];
          if (requestedIds.length !== currentIds.length || new Set(requestedIds).size !== currentIds.length || requestedIds.some((id) => !currentIds.includes(id))) {
            throw new Error('reorder_layers requires layerIds to contain every existing layer exactly once, ordered from bottom to top.');
          }
          const layersById = new Map(base.layers.map((layer) => [layer.id, layer]));
          candidate = { ...base, layers: requestedIds.map((id) => layersById.get(id)!) };
        } else if (params.command === 'select') {
          candidate = {
            ...base,
            selection: [{
              sourceId: params.sourceId,
              ...(params.layerId ? { layerId: params.layerId } : {}),
              featureIds: params.featureIds,
            }],
          };
          operation = 'select';
        } else {
          throw new Error(`Unsupported map command: ${params.command}`);
        }
        const failureKey = styleCommandKey(params);
        try {
          scene = validatedScene(candidate, `Map command ${params.command} failed validation:`);
          if (failureKey) failedValidations.delete(failureKey);
        } catch (error) {
          if (!failureKey) throw error;
          const message = error instanceof Error ? error.message : String(error);
          const previous = failedValidations.get(failureKey);
          const count = previous?.message === message ? previous.count + 1 : 1;
          failedValidations.set(failureKey, { count, message });
          const diagnostic = `Runtime ${EXTENSION_RUNTIME_ID} loaded from ${fileURLToPath(import.meta.url)}; received ${styleCommandDiagnostic(params)}.`;
          if (count >= 2) {
            throw new Error(`${message}\n${diagnostic}\nThis styling target has failed ${count} times with the same validation error. Stop retrying it and preserve the last successful map.`);
          }
          throw new Error(`${message}\n${diagnostic}`);
        }
      }

      if (scene) assertSceneResources(ctx.cwd, scene);
      const revision = (current?.revision || 0) + 1;
      const title = scene?.metadata.title || current?.scene?.metadata.title || params.visualizationId;
      const envelope: VisualizationEnvelope = {
        protocol: 'pi-visualization',
        version: '1.0',
        kind: 'geo',
        visualizationId: params.visualizationId,
        revision,
        operation,
        scene,
        summary: { title },
        generatedAt: new Date().toISOString(),
      };
      scenes.set(params.visualizationId, { revision, scene });
      return {
        content: [{ type: 'text', text: scene ? `Map "${title}" updated (${scene.layers.length} layers, revision ${revision}).` : `Map "${title}" cleared.` }],
        details: { visualization: envelope, canvas: canvasPresentation(envelope) },
      };
    },
  });
}
