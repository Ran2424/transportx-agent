
import { type ContractDiagnostic } from './diagnostic.ts';
import { type CanvasPresentationV1 } from './canvas.ts';
import { CAD_DRAWING_PROTOCOL, CAD_DRAWING_VERSION, CAD_PROTOCOL, CAD_VERSION } from './version.ts';

export const CAD_MAX_OPERATIONS = 200;
export const CAD_MAX_MATCHED = 5_000;
export const CAD_MAX_HANDLES = 500;
export const CAD_MAX_DIAGNOSTICS = 200;
export const CAD_MAX_POINTS = 10_000;
export const CAD_MAX_TEXT_LENGTH = 500;
export const CAD_MAX_INPUT_BYTES = 50 * 1024 * 1024;
export const CAD_MAX_ENTITY_COUNT = 20_000;
export const CAD_MAX_PATH_LENGTH = 1_000;

export const CAD_ENTITY_TYPES = [
  'LINE',
  'LWPOLYLINE',
  'POLYLINE',
  'CIRCLE',
  'ARC',
  'TEXT',
  'MTEXT',
  'POINT',
  'INSERT',
  'HATCH',
] as const;

export type CadEntityType = typeof CAD_ENTITY_TYPES[number];
export type CadUnits = 'm' | 'mm';
export type CadPoint2 = [number, number];

export type CadTarget =
  | { kind: 'epsg'; code: string }
  | { kind: 'local'; origin: CadPoint2; rotationDeg: number; scale: number };

export type CadSelector =
  | { kind: 'handle'; handle: string }
  | { kind: 'layer'; layer: string; entityType?: CadEntityType }
  | { kind: 'bounds'; layer?: string; entityType?: CadEntityType; min: CadPoint2; max: CadPoint2 };

export type CadOperation =
  | { op: 'move'; selector: CadSelector; dx: number; dy: number }
  | { op: 'copy'; selector: CadSelector; dx: number; dy: number; count?: number }
  | { op: 'delete'; selector: CadSelector }
  | { op: 'setLayer'; selector: CadSelector; layer: string }
  | { op: 'drawPolyline'; layer: string; points: CadPoint2[]; closed?: boolean }
  | { op: 'drawText'; layer: string; position: CadPoint2; text: string; height: number; rotationDeg?: number }
  | { op: 'drawHatch'; layer: string; boundary: CadPoint2[] }
  | { op: 'insertBlock'; layer: string; name: string; position: CadPoint2; rotationDeg?: number; scale?: number };

export type CadDrawRequestV1 =
  | {
      protocol: typeof CAD_PROTOCOL;
      version: typeof CAD_VERSION;
      kind: 'from-geojson';
      fileId?: string;
      sourcePath: string;
      sourceCrs: string;
      target: CadTarget;
      units: 'm';
      layerKey?: string;
      layerMap: Record<string, string>;
      labelField?: string;
      labelLayer?: string;
      fillLayers?: string[];
      repairInvalid?: boolean;
      title?: string;
      dryRun: boolean;
      exportPreview?: boolean;
    }
  | {
      protocol: typeof CAD_PROTOCOL;
      version: typeof CAD_VERSION;
      kind: 'edit';
      fileId: string;
      baseRevision: number;
      expectedSha256: string;
      contextId?: string;
      operations: CadOperation[];
      units?: CadUnits;
      dryRun: boolean;
      exportPreview?: boolean;
    }
  | {
      protocol: typeof CAD_PROTOCOL;
      version: typeof CAD_VERSION;
      kind: 'commit-candidate';
      fileId: string;
      sourcePath: string;
      baseRevision: number;
      expectedSha256: string;
      candidateMode: 'rebuild' | 'based-on-current';
      dryRun: boolean;
      exportPreview?: boolean;
    }
  | {
      protocol: typeof CAD_PROTOCOL;
      version: typeof CAD_VERSION;
      kind: 'import';
      sourcePath: string;
      fileId?: string;
      title?: string;
      units?: CadUnits;
      dryRun: boolean;
      exportPreview?: boolean;
    };

export type CadInspectRequestV1 = {
  protocol: typeof CAD_PROTOCOL;
  version: typeof CAD_VERSION;
  fileId?: string;
  path?: string;
  include: Array<'summary' | 'layers' | 'entities' | 'blocks' | 'units' | 'extents' | 'textStyles' | 'geometry'>;
  selector?: CadSelector;
  limit: number;
  cursor?: string;
};

export type CadPreviewOptions = {
  bounds?: { min: CadPoint2; max: CadPoint2 };
  layers?: string[];
  width?: number;
  height?: number;
};

export type CadVerifyRequestV1 = {
  protocol: typeof CAD_PROTOCOL;
  version: typeof CAD_VERSION;
  fileId?: string;
  path?: string;
  revision?: number;
  policy: 'basic' | 'traffic-v1' | 'strict';
  exportPreview?: boolean;
  previewOptions?: CadPreviewOptions;
};

export type CadDiagnostic = {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  path?: string;
  entityHandle?: string;
  layer?: string;
  details?: Record<string, unknown>;
};

export type CadDrawingRefV1 = {
  fileId: string;
  revision: number;
  path: string;
  sha256: string;
  bytes: number;
  units: CadUnits;
  extents: { min: CadPoint2; max: CadPoint2 } | null;
  layerCount: number;
  entityCount: number;
};

export type CadPreviewV1 = {
  png: string;
  pdf?: string;
  width: number;
  height: number;
  dpi: number;
};

export type CadDrawResultV1 = {
  protocol: typeof CAD_PROTOCOL;
  version: typeof CAD_VERSION;
  ok: boolean;
  dryRun: boolean;
  drawing?: CadDrawingRefV1;
  plan?: {
    operationCount: number;
    matchedCount: number;
    sampleHandles: string[];
    wouldCreate: number;
    wouldModify: number;
    wouldDelete: number;
  };
  preview?: CadPreviewV1;
  checks?: CadVerifyCheck[];
  sourceRefs?: Array<{ kind: 'geojson' | 'dxf'; path: string; sha256: string }>;
  canvas?: CanvasPresentationV1;
  warnings: CadDiagnostic[];
  diagnostics: CadDiagnostic[];
};

export type CadInspectResultV1 = {
  protocol: typeof CAD_PROTOCOL;
  version: typeof CAD_VERSION;
  drawing?: { fileId: string; revision: number; sha256: string; sourceCrs?: string; target?: CadTarget };
  summary: {
    units: CadUnits | null;
    extents: { min: CadPoint2; max: CadPoint2 } | null;
    layerCount: number;
    entityCount: number;
    blockCount: number;
    sha256?: string;
  };
  layers?: Array<{ name: string; entityCount: number; color: number; linetype: string }>;
  entities?: Array<{
    handle: string;
    type: CadEntityType;
    layer: string;
    bounds?: { min: CadPoint2; max: CadPoint2 };
    text?: string;
    geometry?: import('./cad-geometry.ts').CadEntityGeometry;
    geometryTruncated?: boolean;
  }>;
  blocks?: Array<{ name: string; entityCount: number }>;
  textStyles?: Array<{ name: string; font: string }>;
  nextCursor?: string;
  warnings: CadDiagnostic[];
};

export type CadVerifyCheck = {
  id: string;
  status: 'pass' | 'warning' | 'fail';
  message: string;
  count?: number;
};

export type CadVerifyResultV1 = {
  preview?: CadPreviewV1;
  protocol: typeof CAD_PROTOCOL;
  version: typeof CAD_VERSION;
  ok: boolean;
  checks: CadVerifyCheck[];
  diagnostics: CadDiagnostic[];
};

export type CadDrawingManifestV1 = {
  protocol: typeof CAD_DRAWING_PROTOCOL;
  version: typeof CAD_DRAWING_VERSION;
  drawingId: string;
  fileId: string;
  title: string;
  currentRevision: number;
  revisions: Array<{
    revision: number;
    path: string;
    sha256: string;
    bytes: number;
    parentSha256?: string;
    units?: CadUnits | null;
    operationCount?: number;
    createdAt: string;
  }>;
  units: CadUnits | null;
  sourceCrs?: string;
  target?: CadTarget;
  transform?: Record<string, unknown>;
  sourceRefs?: Array<{ kind: 'geojson' | 'dxf'; path: string; sha256: string }>;
  createdAt: string;
  updatedAt: string;
};

export type CadParseResult<T> =
  | { ok: true; value: T; diagnostics: ContractDiagnostic[] }
  | { ok: false; value: null; diagnostics: ContractDiagnostic[] };
