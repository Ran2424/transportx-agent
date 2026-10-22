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

export const pilotToolContracts = [
  { moduleId: "com.transportx.module-authoring", toolId: "module.package", piName: "tau_module_package", contractVersion: "1.0.0", semanticVersion: "module-task-package-v1", input: ModulePackageSchema, output: { protocol: "transportx-module-package", version: 1, detailsKind: "tau-module-package" } },
  { moduleId: "com.transportx.spatial-analysis", toolId: "spatial.execution", piName: "tau_spatial_execution", contractVersion: "1.0.0", semanticVersion: "spatial-owner-confirmation-v1", input: SpatialExecutionSchema, output: { protocol: "transportx-spatial-execution", version: 1, detailsKind: "tau-spatial-execution" } },
  { moduleId: "com.transportx.spatial-analysis", toolId: "spatial.analyze", piName: "tau_spatial_analyze", contractVersion: "1.0.0", semanticVersion: "spatial-explicit-crs-v1", input: SpatialAnalyzeSchema, output: { protocol: "transportx-spatial-analysis", version: 1, detailsKind: "tau-spatial-analysis" } },
  { moduleId: "com.transportx.citation", toolId: "citation.resolve", piName: "tau_resolve_citation", contractVersion: "1.0.0", semanticVersion: "citation-exclusive-sources-webUrls-v1", input: CitationResolveSchema, output: { protocol: "pi-citation", version: "3.0", detailsKind: "tau-citations" } },
];
