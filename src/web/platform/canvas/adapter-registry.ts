import type { CanvasPresentationV1 } from '../../../contracts/canvas.ts';
import {
  CAD_CANVAS_ADAPTER_ID,
  parseCadCanvasPayload,
  parseCadCanvasTarget,
} from '../../../contracts/canvas-cad.ts';
import {
  DOCUMENT_CANVAS_ADAPTER_ID,
  GEO_CANVAS_ADAPTER_ID,
  VIDEO_CANVAS_ADAPTER_ID,
  parseDocumentCanvasPayload,
  parseDocumentCanvasTarget,
} from '../../../contracts/canvas-document.ts';
import { parseGeoCanvasTarget, parseVideoCanvasTarget } from '../../../contracts/canvas-media.ts';
import { parseVisualizationEnvelope } from '../../../contracts/geo.ts';
import { parseVideoEnvelopeStructured, parseVideoTimestamp } from '../../../contracts/video.ts';
import type { CanvasView } from './canvas-state.ts';
import { documentPath } from './document-state.ts';

export type CanvasProjectionContext = { sessionId: string; cwd: string };

export type CanvasAdapter = {
  adapterId: string;
  kind: CanvasView['kind'];
  reduce(previous: CanvasView | undefined, presentation: CanvasPresentationV1, context?: CanvasProjectionContext): CanvasView | null;
};

const documentAdapter: CanvasAdapter = {
  adapterId: DOCUMENT_CANVAS_ADAPTER_ID,
  kind: 'document',
  reduce(previous, presentation, context) {
    if (presentation.operation === 'clear') return null;
    if (!context) return null;
    const payload = parseDocumentCanvasPayload(presentation.payload);
    const target = presentation.target === undefined ? undefined : parseDocumentCanvasTarget(presentation.target) ?? undefined;
    if (!payload || presentation.target !== undefined && !target) return null;
    const primary = presentation.resources[0];
    const relativePath = primary?.scope === 'session-file' ? primary.path : payload.path;
    if (!relativePath) return null;
    const path = primary?.scope === 'session-file' ? documentPath(relativePath, context.cwd) : relativePath;
    const source = payload.source;
    if (primary?.scope === 'capability' && (primary.moduleId !== 'com.transportx.citation' || !source || source.sourceVersionId !== primary.resourceId)) return null;
    const navigationId = (previous?.kind === 'document' ? previous.navigationId : 0) + (target ? 1 : 0);
    const locator = target?.kind === 'page'
      ? { kind: 'document' as const, page: target.number }
      : target?.kind === 'locator'
        ? { kind: 'document' as const, ...(target.page ? { page: target.page } : {}), ...(target.section ? { section: target.section } : {}), ...(target.nodeId ? { nodeId: target.nodeId } : {}) }
        : target?.kind === 'rows' ? { kind: 'table' as const, rowStart: target.start, rowEnd: target.end, columns: target.columns } : undefined;
    return {
      id: presentation.viewId,
      kind: 'document',
      sessionId: context.sessionId,
      title: presentation.title,
      path,
      ...(source ? { source } : {}),
      format: payload.format,
      navigationId,
      revision: presentation.revision,
      canvasResources: presentation.resources,
      canvas: presentation,
      ...(target ? { canvasTarget: target } : {}),
      ...(locator ? { locator } : {}),
    };
  },
};

const geoAdapter: CanvasAdapter = {
  adapterId: GEO_CANVAS_ADAPTER_ID,
  kind: 'geo',
  reduce(_previous, presentation) {
    if (presentation.operation === 'clear') return null;
    const envelope = parseVisualizationEnvelope(presentation.payload);
    const target = presentation.target === undefined ? undefined : parseGeoCanvasTarget(presentation.target) ?? undefined;
    if (!envelope?.scene || presentation.target !== undefined && !target) return null;
    const projected = target
      ? { ...envelope, scene: { ...envelope.scene, view: { mode: 'bounds' as const, bounds: target.bounds } } }
      : envelope;
    return { id: presentation.viewId, kind: 'geo', title: presentation.title, envelope: projected, canvas: presentation };
  },
};

const videoAdapter: CanvasAdapter = {
  adapterId: VIDEO_CANVAS_ADAPTER_ID,
  kind: 'video',
  reduce(_previous, presentation) {
    if (presentation.operation === 'clear') return null;
    const envelope = parseVideoEnvelopeStructured(presentation.payload);
    if (!envelope.ok) return null;
    const target = presentation.target === undefined ? undefined : parseVideoCanvasTarget(presentation.target) ?? undefined;
    if (presentation.target !== undefined && !target) return null;
    const activeId = envelope.value.scene.activeVideoId ?? envelope.value.scene.videos.at(-1)?.id;
    const sourceItem = envelope.value.scene.videos.find((candidate) => candidate.id === activeId);
    if (!sourceItem) return null;
    const recordingStart = parseVideoTimestamp(sourceItem.recordingStartTime);
    const timestamp = target?.kind === 'timestamp' ? parseVideoTimestamp(target.at) : null;
    const seek = target?.kind === 'offset' ? target.seconds : timestamp && recordingStart ? (timestamp.epochMs - recordingStart.epochMs) / 1000 : undefined;
    if (seek !== undefined && (seek < 0 || seek > sourceItem.durationSeconds)) return null;
    const item = seek === undefined ? sourceItem : { ...sourceItem, initialSeekSeconds: seek };
    const compareItem = envelope.value.scene.videos.find((candidate) => candidate.id === envelope.value.scene.compareVideoId);
    return { id: presentation.viewId, kind: 'video', title: presentation.title, item, revision: presentation.revision, ...(compareItem ? { compareItem } : {}), canvas: presentation };
  },
};

const cadAdapter: CanvasAdapter = {
  adapterId: CAD_CANVAS_ADAPTER_ID,
  kind: 'cad',
  reduce(_previous, presentation) {
    if (presentation.operation === 'clear') return null;
    const payload = parseCadCanvasPayload(presentation.payload);
    const target = presentation.target === undefined ? undefined : parseCadCanvasTarget(presentation.target) ?? undefined;
    if (!payload || presentation.target !== undefined && !target) return null;
    return {
      id: presentation.viewId,
      kind: 'cad',
      title: presentation.title,
      revision: presentation.revision,
      canvas: presentation,
      ...(payload.preview ? { previewPath: payload.preview } : {}),
    };
  },
};

const adapters = new Map([documentAdapter, geoAdapter, videoAdapter, cadAdapter].map((adapter) => [adapter.adapterId, adapter]));

export function getCanvasAdapter(adapterId: string): CanvasAdapter | null {
  return adapters.get(adapterId) ?? null;
}

export function registeredCanvasAdapters(): readonly CanvasAdapter[] {
  return [...adapters.values()];
}

export function canvasAdapterForView(view: CanvasView): CanvasAdapter | null {
  return view.canvas ? getCanvasAdapter(view.canvas.adapterId) : [...adapters.values()].find((adapter) => adapter.kind === view.kind) ?? null;
}
