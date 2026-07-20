import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  isFeatureCollection,
  parseGeoScene,
  parseVisualizationEnvelope,
  type GeoJsonFeatureCollection,
  type GeoSceneSnapshot,
  type GeoSource,
  type GeoView,
  type VisualizationEnvelope,
} from '../../src/public/visualization/geo/protocol.ts';

type SceneState = { revision: number; scene: GeoSceneSnapshot | null };
type GeoPatch = {
  view?: GeoView;
  basemap?: GeoSceneSnapshot['basemap'];
  upsertSources?: GeoSource[];
  removeSourceIds?: string[];
  upsertLayers?: GeoSceneSnapshot['layers'];
  removeLayerIds?: string[];
  controls?: GeoSceneSnapshot['controls'];
  selection?: GeoSceneSnapshot['selection'];
  metadata?: Partial<GeoSceneSnapshot['metadata']>;
};

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FEATURES = 50_000;

const VisualValueSchema = Type.Union([
  Type.Object({ mode: Type.Literal('constant'), value: Type.Union([Type.String(), Type.Number(), Type.Array(Type.Number())]) }),
  Type.Object({
    mode: Type.Literal('categorical'), field: Type.String(),
    categories: Type.Array(Type.Object({ value: Type.Union([Type.String(), Type.Number(), Type.Boolean()]), output: Type.Union([Type.String(), Type.Number()]) })),
    fallback: Type.Union([Type.String(), Type.Number()]),
  }),
  Type.Object({
    mode: Type.Literal('step'), field: Type.String(), default: Type.Union([Type.String(), Type.Number()]),
    stops: Type.Array(Type.Object({ value: Type.Number(), output: Type.Union([Type.String(), Type.Number()]) })),
  }),
  Type.Object({
    mode: Type.Literal('continuous'), field: Type.String(),
    stops: Type.Array(Type.Object({ value: Type.Number(), output: Type.Union([Type.String(), Type.Number()]) })),
  }),
]);

const GeoViewSchema = Type.Union([
  Type.Object({ mode: Type.Literal('bounds'), bounds: Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()]), padding: Type.Optional(Type.Number()) }),
  Type.Object({ mode: Type.Literal('camera'), center: Type.Tuple([Type.Number(), Type.Number()]), zoom: Type.Number() }),
]);

const BasemapIdSchema = Type.Union(
  [Type.Literal('default'), Type.Literal('light'), Type.Literal('dark'), Type.Literal('none')],
  { description: 'Use light/default for most maps, dark for high-contrast dashboards, and none only for an intentionally blank or offline canvas' },
);

const GeoSourceSchema = Type.Union([
  Type.Object({
    id: Type.String(), type: Type.Literal('geojson-inline'),
    data: Type.Any({ description: 'RFC 7946 GeoJSON FeatureCollection object, not a JSON string' }),
    idField: Type.Optional(Type.String()),
  }),
  Type.Object({ id: Type.String(), type: Type.Literal('geojson-resource'), resourceId: Type.String(), idField: Type.Optional(Type.String()) }),
]);

const PopupSchema = Type.Object({
  fields: Type.Array(Type.Object({
    field: Type.String(), label: Type.String(),
    format: Type.Optional(Type.Union([Type.Literal('text'), Type.Literal('integer'), Type.Literal('decimal'), Type.Literal('percent')])),
  })),
});

const GeoLayerFields = {
  id: Type.String(),
  sourceId: Type.String({ description: 'ID of an entry in scene.sources' }),
  title: Type.Optional(Type.String()),
  visible: Type.Optional(Type.Boolean()),
  minZoom: Type.Optional(Type.Number()),
  maxZoom: Type.Optional(Type.Number()),
  popup: Type.Optional(PopupSchema),
};

const GeoLayerSchema = Type.Union([
  Type.Object({
    ...GeoLayerFields,
    type: Type.Literal('circle'),
    encoding: Type.Object({
      color: Type.Optional(VisualValueSchema), radius: Type.Optional(VisualValueSchema), opacity: Type.Optional(VisualValueSchema),
      strokeColor: Type.Optional(VisualValueSchema), strokeWidth: Type.Optional(VisualValueSchema),
    }, { description: 'Circle channels use these exact unprefixed names.' }),
  }),
  Type.Object({
    ...GeoLayerFields,
    type: Type.Literal('line'),
    encoding: Type.Object({
      color: Type.Optional(VisualValueSchema), width: Type.Optional(VisualValueSchema),
      opacity: Type.Optional(VisualValueSchema), dash: Type.Optional(VisualValueSchema),
    }),
  }),
  Type.Object({
    ...GeoLayerFields,
    type: Type.Literal('fill'),
    encoding: Type.Object({
      color: Type.Optional(VisualValueSchema), opacity: Type.Optional(VisualValueSchema), outlineColor: Type.Optional(VisualValueSchema),
    }),
  }),
  Type.Object({
    ...GeoLayerFields,
    type: Type.Literal('label'),
    encoding: Type.Object({
      textField: VisualValueSchema,
      color: Type.Optional(VisualValueSchema), size: Type.Optional(VisualValueSchema),
      haloColor: Type.Optional(VisualValueSchema), haloWidth: Type.Optional(VisualValueSchema),
    }, { description: 'For a property label, set textField to {mode:"constant",value:"propertyName"}.' }),
  }),
]);

const ControlsSchema = Type.Object({
  navigation: Type.Optional(Type.Boolean()), fullscreen: Type.Optional(Type.Boolean()),
  layerSwitcher: Type.Optional(Type.Boolean()), legend: Type.Optional(Type.Boolean()), fitToData: Type.Optional(Type.Boolean()),
});

const SelectionSchema = Type.Array(Type.Object({
  sourceId: Type.String(), layerId: Type.Optional(Type.String()),
  featureIds: Type.Array(Type.Union([Type.String(), Type.Number()])),
}));

const GeoSceneSchema = Type.Object({
  view: GeoViewSchema,
  basemap: Type.Object({ id: BasemapIdSchema }),
  sources: Type.Array(GeoSourceSchema),
  layers: Type.Array(GeoLayerSchema),
  controls: Type.Optional(ControlsSchema),
  selection: Type.Optional(SelectionSchema),
  metadata: Type.Object({ title: Type.String(), description: Type.Optional(Type.String()), warnings: Type.Optional(Type.Array(Type.String())) }),
}, { description: 'Declarative 2D GeoScene. Use sourceId and encoding mode objects; never use MapLibre source/paint/layout properties.' });

const GeoPatchSchema = Type.Object({
  view: Type.Optional(GeoViewSchema),
  basemap: Type.Optional(Type.Object({ id: BasemapIdSchema })),
  upsertSources: Type.Optional(Type.Array(GeoSourceSchema)),
  removeSourceIds: Type.Optional(Type.Array(Type.String())),
  upsertLayers: Type.Optional(Type.Array(GeoLayerSchema)),
  removeLayerIds: Type.Optional(Type.Array(Type.String())),
  controls: Type.Optional(ControlsSchema),
  selection: Type.Optional(SelectionSchema),
  metadata: Type.Optional(Type.Object({ title: Type.Optional(Type.String()), description: Type.Optional(Type.String()), warnings: Type.Optional(Type.Array(Type.String())) })),
});

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
  if (data.features.length > MAX_FEATURES) throw new Error(`GeoJSON feature count exceeds ${MAX_FEATURES}`);
  const types = new Set<string>();
  const ids = new Set<string>();
  const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const feature of data.features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    types.add(geometry.type);
    if (idField) {
      const value = feature.properties?.[idField];
      if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`Feature is missing idField: ${idField}`);
      const key = String(value);
      if (ids.has(key)) throw new Error(`Duplicate idField value: ${key}`);
      ids.add(key);
    }
    const visit = (lng: number, lat: number) => {
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        throw new Error('GeoJSON coordinates must use WGS84 longitude/latitude');
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

function assertSceneResources(cwd: string, scene: GeoSceneSnapshot) {
  for (const source of scene.sources) {
    if (source.type !== 'geojson-resource') continue;
    const manifest = path.join(resourceDirectory(cwd, source.resourceId), 'manifest.json');
    if (!fs.existsSync(manifest)) throw new Error(`Geo resource not found: ${source.resourceId}`);
  }
}

function applyPatch(scene: GeoSceneSnapshot, patch: GeoPatch): GeoSceneSnapshot {
  const sources = new Map(scene.sources.map((source) => [source.id, source]));
  const layers = new Map(scene.layers.map((layer) => [layer.id, layer]));
  for (const source of patch.upsertSources || []) sources.set(source.id, source);
  for (const id of patch.removeSourceIds || []) sources.delete(id);
  for (const layer of patch.upsertLayers || []) layers.set(layer.id, layer);
  for (const id of patch.removeLayerIds || []) layers.delete(id);
  return {
    ...scene,
    ...(patch.view ? { view: patch.view } : {}),
    ...(patch.basemap ? { basemap: patch.basemap } : {}),
    sources: Array.from(sources.values()),
    layers: Array.from(layers.values()),
    ...(patch.controls ? { controls: patch.controls } : {}),
    ...(patch.selection ? { selection: patch.selection } : {}),
    metadata: { ...scene.metadata, ...(patch.metadata || {}) },
  };
}

export default function geoVisualizationExtension(pi: ExtensionAPI) {
  const scenes = new Map<string, SceneState>();

  const restore = (ctx: ExtensionContext) => {
    scenes.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'message' || entry.message.role !== 'toolResult' || entry.message.toolName !== 'present_visualization') continue;
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
    name: 'publish_geodata',
    label: 'Publish GeoJSON',
    description: 'Publish a GeoJSON file from the current task as a session-scoped web map resource.',
    promptSnippet: 'Publish GeoJSON files for use in interactive maps',
    promptGuidelines: ['Use publish_geodata before present_visualization when the GeoJSON is larger than a small inline feature collection.'],
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
    description: 'Create or update a declarative interactive 2D map in the Tau web workspace.',
    promptSnippet: 'Present GeoJSON sources as an interactive web map',
    promptGuidelines: [
      'Use present_visualization for spatial results that benefit from an interactive map.',
      'present_visualization accepts declarative GeoScene data only; never generate JavaScript, HTML, CSS, or MapLibre expressions.',
      'A scene view must include mode, basemap must be an {id} object, every layer uses sourceId, and every encoding channel uses a {mode,...} VisualValue object.',
      'Prefer basemap {id:"light"} or {id:"default"}; use {id:"none"} only when a blank offline canvas is intentional.',
      'Give GeoJSON features stable top-level ids or set source.idField so hover and selection feedback works reliably.',
      'For a small point set, add a separate label layer using textField {mode:"constant",value:"name"} (or another property name), plus a white halo; avoid labels for dense point clouds.',
      'Circle encoding keys are exactly color, radius, opacity, strokeColor, and strokeWidth; never prefix them with circle.',
      'The v1 scene has no filter channel, so put lines, ordinary points, and highlighted places in separate sources when they need different layers or styling.',
      'Use clear layer titles, restrained line widths, popup fields for details, and a bounds view with padding so the initial composition fits the data.',
    ],
    parameters: Type.Object({
      visualizationId: Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$' }),
      operation: Type.Union([
        Type.Literal('replace'),
        Type.Literal('patch'),
        Type.Literal('focus'),
        Type.Literal('select'),
        Type.Literal('clear'),
      ]),
      scene: Type.Optional(GeoSceneSchema),
      patch: Type.Optional(GeoPatchSchema),
      view: Type.Optional(GeoViewSchema),
      selection: Type.Optional(SelectionSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = scenes.get(params.visualizationId);
      let scene: GeoSceneSnapshot | null = null;
      if (params.operation === 'replace') {
        scene = parseGeoScene(params.scene);
        if (!scene) throw new Error('Invalid GeoScene for replace');
      } else if (params.operation === 'clear') {
        scene = null;
      } else {
        if (!current?.scene) throw new Error(`Visualization not found: ${params.visualizationId}`);
        if (params.operation === 'patch') scene = parseGeoScene(applyPatch(current.scene, (params.patch || {}) as GeoPatch));
        if (params.operation === 'focus') scene = parseGeoScene({ ...current.scene, view: params.view });
        if (params.operation === 'select') scene = parseGeoScene({ ...current.scene, selection: params.selection || [] });
        if (!scene) throw new Error(`Invalid GeoScene after ${params.operation}`);
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
        operation: params.operation,
        scene,
        summary: { title },
        generatedAt: new Date().toISOString(),
      };
      scenes.set(params.visualizationId, { revision, scene });
      return {
        content: [{ type: 'text', text: scene ? `Map "${title}" updated (${scene.layers.length} layers, revision ${revision}).` : `Map "${title}" cleared.` }],
        details: { visualization: envelope },
      };
    },
  });
}
