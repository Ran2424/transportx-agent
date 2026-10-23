import { Type } from "typebox";

export const SpatialAnalyzeSchema = Type.Object({
  operation: Type.Union([Type.Literal('buffer'), Type.Literal('nearest'), Type.Literal('spatial_join')]),
  inputPath: Type.Optional(Type.String({ maxLength: 1000 })),
  leftPath: Type.Optional(Type.String({ maxLength: 1000 })),
  rightPath: Type.Optional(Type.String({ maxLength: 1000 })),
  inputCrs: Type.Optional(Type.String({ maxLength: 120 })),
  leftCrs: Type.Optional(Type.String({ maxLength: 120 })),
  rightCrs: Type.Optional(Type.String({ maxLength: 120 })),
  metricCrs: Type.Optional(Type.String({ maxLength: 120 })),
  distanceMeters: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  maxDistanceMeters: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  dissolve: Type.Optional(Type.Boolean()),
  predicate: Type.Optional(Type.Union([Type.Literal('intersects'), Type.Literal('within'), Type.Literal('contains')])),
  cardinality: Type.Optional(Type.Union([Type.Literal('one-to-one'), Type.Literal('one-to-many')])),
  multipleMatchStrategy: Type.Optional(Type.Union([Type.Literal('error'), Type.Literal('first')])),
  rightFields: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 20 })),
  repairInvalid: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const Positive = Type.Integer({ minimum: 1 });
const Text = Type.String({ minLength: 1, maxLength: 4000 });
const Locator = Type.Union([
  Type.Object({ kind: Type.Literal('source') }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('document'), page: Type.Optional(Positive), printedPage: Type.Optional(Text), section: Type.Optional(Text), nodeId: Type.Optional(Text), lineStart: Type.Optional(Positive), lineEnd: Type.Optional(Positive) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('table'), rowStart: Type.Optional(Positive), rowEnd: Type.Optional(Positive), columns: Type.Optional(Type.Array(Text)), sheet: Type.Optional(Text), cell: Type.Optional(Text) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('result'), field: Text }, { additionalProperties: false }),
]);
const Source = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1000, description: 'Concrete original/result file relative to this session, or to the selected asset when assetId is supplied. Never a URL, directory or catalog candidate; register URLs with webUrls in a separate call.' }),
  assetId: Type.Optional(Type.String({ minLength: 1, maxLength: 180 })), title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  locator: Locator, contentKind: Type.Union([Type.Literal('excerpt'), Type.Literal('summary'), Type.Literal('result'), Type.Literal('source-only')]),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })),
  metadata: Type.Optional(Type.Object({ bibliographicType: Type.Optional(Type.Union([Type.Literal('S'), Type.Literal('R'), Type.Literal('M'), Type.Literal('J'), Type.Literal('EB/OL'), Type.Literal('DS'), Type.Literal('Z')])), author: Type.Optional(Type.Array(Text)), issuer: Type.Optional(Text), issuedAt: Type.Optional(Text), standardNumber: Type.Optional(Text), edition: Type.Optional(Text), url: Type.Optional(Text), version: Type.Optional(Text), timeRange: Type.Optional(Text), querySummary: Type.Optional(Text) }, { additionalProperties: false })),
  deliverable: Type.Optional(Type.Boolean({ description: 'True only for an intended final deliverable; delivery does not change source identity.' })),
}, { additionalProperties: false });

export const CitationResolveSchema = Type.Object({ sources: Type.Optional(Type.Array(Source, { minItems: 1, maxItems: 20, description: 'Local files only. Omit webUrls when supplying sources.' })), webUrls: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { minItems: 1, maxItems: 10, description: 'Public HTTPS page URLs. Omit sources when supplying webUrls.' })) }, { additionalProperties: false });

export const SpatialExecutionSchema = Type.Object({ action: Type.Union([Type.Literal('query'), Type.Literal('cancel')]), operationId: Type.Optional(Type.String({ pattern: '^spatial_[a-f0-9]{32}$' })), lookupToolCallId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }, { additionalProperties: false });

export const ModulePackageSchema = Type.Object({ action: Type.Union([Type.Literal('inspect'), Type.Literal('install')]), packagePath: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false });

const ResourceSchema = Type.Union([
  Type.Object({ scope: Type.Literal('session-file'), path: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false }),
  Type.Object({ scope: Type.Literal('capability'), moduleId: Type.String({ minLength: 1, maxLength: 200 }), resourceId: Type.String({ minLength: 1, maxLength: 160 }), revision: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
]);

export const CanvasPresentSchema = Type.Object({
  adapterId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  operation: Type.Optional(Type.Union([Type.Literal('present'), Type.Literal('focus'), Type.Literal('update'), Type.Literal('clear')])),
  resource: Type.Optional(ResourceSchema),
  target: Type.Optional(Type.Unknown()),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  viewId: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
}, { additionalProperties: false });

export const CanvasInspectSchema = Type.Object({
  contextIds: Type.Array(Type.String({ pattern: '^canvas_context_[a-f0-9-]+$' }), { minItems: 1, maxItems: 20 }),
}, { additionalProperties: false });


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

export const PresentVisualizationCommandSchema = Type.Object({
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
  center: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })),
  zoom: Type.Optional(Type.Number()),
  bounds: Type.Optional(Type.Array(Type.Number(), { minItems: 4, maxItems: 4 })),
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

export const InspectMapContextSchema = Type.Object({
  contextIds: Type.Optional(Type.Array(Type.String({ pattern: '^geoctx_[A-Za-z0-9_-]{12,64}$' }), { maxItems: 8 })),
  maxFeatures: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  includeProvenance: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const RequestGeoInputSchema = Type.Object({
  visualizationId: VisualizationIdSchema,
  sceneRevision: Type.Integer({ minimum: 1 }),
  mode: Type.Union([Type.Literal('feature'), Type.Literal('point'), Type.Literal('rectangle'), Type.Literal('viewport')]),
  prompt: Type.String({ minLength: 1, maxLength: 500 }),
  required: Type.Optional(Type.Boolean()),
  targetLayerIds: Type.Optional(Type.Array(ItemIdSchema, { minItems: 1, maxItems: 32 })),
  maxFeatures: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 30, maximum: 1800 })),
}, { additionalProperties: false });

export const CaptureGeoScreenshotSchema = Type.Object({
  visualizationId: VisualizationIdSchema,
  sceneRevision: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });


export const PublishGeodataSchema = Type.Object({
  path: Type.String({ description: 'GeoJSON path inside the current task directory' }),
  title: Type.Optional(Type.String()),
  idField: Type.Optional(Type.String()),
});

const AskOptionSchema = Type.Object({
  value: Type.String({ minLength: 1, maxLength: 200 }),
  label: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
}, { additionalProperties: false });

export const AskUserSchema = Type.Object({
  kind: Type.Union([Type.Literal('confirm'), Type.Literal('select'), Type.Literal('input'), Type.Literal('editor')]),
  title: Type.String({ minLength: 1, maxLength: 300 }),
  message: Type.String({ minLength: 1, maxLength: 2000 }),
  options: Type.Optional(Type.Array(AskOptionSchema, { minItems: 2, maxItems: 20 })),
  required: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });


export const coreToolContracts = [
  { moduleId: "com.transportx.canvas", toolId: "canvas.present", piName: "canvas_present", contractVersion: "1.0.0", semanticVersion: "canvas.present-v1", input: CanvasPresentSchema, output: { protocol: "pi-canvas", version: "1.0", detailsKind: "tau-canvas" } },
  { moduleId: "com.transportx.canvas", toolId: "canvas.inspect", piName: "canvas_inspect_context", contractVersion: "1.0.0", semanticVersion: "canvas.inspect-v1", input: CanvasInspectSchema, output: { protocol: "pi-canvas-context", version: "1.0", detailsKind: "tau-canvas-contexts" } },
  { moduleId: "com.transportx.geo", toolId: "geo.inspect", piName: "inspect_map_context", contractVersion: "1.0.0", semanticVersion: "geo.inspect-v1", input: InspectMapContextSchema, output: { protocol: "transportx-geo-context", version: 1, detailsKind: "tau-geo-context" } },
  { moduleId: "com.transportx.geo", toolId: "geo.request", piName: "request_geo_input", contractVersion: "1.0.0", semanticVersion: "geo.request-v1", input: RequestGeoInputSchema, output: { protocol: "transportx-geo-interaction", version: 1, detailsKind: "tau-geo-interaction" } },
  { moduleId: "com.transportx.geo", toolId: "geo.screenshot", piName: "capture_geo_screenshot", contractVersion: "1.0.0", semanticVersion: "geo.screenshot-v1", input: CaptureGeoScreenshotSchema, output: { protocol: "transportx-geo-screenshot", version: 1, detailsKind: "tau-geo-screenshot" } },
  { moduleId: "com.transportx.geo", toolId: "geo.publish", piName: "publish_geodata", contractVersion: "1.0.0", semanticVersion: "geo.publish-v1", input: PublishGeodataSchema, output: { protocol: "transportx-geo-resource", version: 1, detailsKind: "tau-geo-resource" } },
  { moduleId: "com.transportx.geo", toolId: "geo.present", piName: "present_visualization", contractVersion: "1.0.0", semanticVersion: "geo.present-v1", input: PresentVisualizationCommandSchema, output: { protocol: "pi-visualization", version: "1.0", detailsKind: "tau-geo-visualization" } },
  { moduleId: "com.transportx.interaction", toolId: "interaction.ask", piName: "tau_ask_user", contractVersion: "1.0.0", semanticVersion: "interaction.ask-v1", input: AskUserSchema, output: { protocol: "transportx-interaction", version: 1, detailsKind: "tau-interaction" } },
  { moduleId: "com.transportx.module-authoring", toolId: "module.package", piName: "tau_module_package", contractVersion: "1.0.0", semanticVersion: "module-task-package-v1", input: ModulePackageSchema, output: { protocol: "transportx-module-package", version: 1, detailsKind: "tau-module-package" } },
  { moduleId: "com.transportx.spatial-analysis", toolId: "spatial.execution", piName: "tau_spatial_execution", contractVersion: "1.0.0", semanticVersion: "spatial-owner-confirmation-v1", input: SpatialExecutionSchema, output: { protocol: "transportx-spatial-execution", version: 1, detailsKind: "tau-spatial-execution" } },
  { moduleId: "com.transportx.spatial-analysis", toolId: "spatial.analyze", piName: "tau_spatial_analyze", contractVersion: "1.0.0", semanticVersion: "spatial-explicit-crs-v1", input: SpatialAnalyzeSchema, output: { protocol: "transportx-spatial-analysis", version: 1, detailsKind: "tau-spatial-analysis" } },
  { moduleId: "com.transportx.citation", toolId: "citation.resolve", piName: "tau_resolve_citation", contractVersion: "1.0.0", semanticVersion: "citation-exclusive-sources-webUrls-v1", input: CitationResolveSchema, output: { protocol: "pi-citation", version: "3.0", detailsKind: "tau-citations" } },
];
