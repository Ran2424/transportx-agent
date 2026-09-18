import type { SessionEntry } from '../../../public/app-types.js';
import type { ToolExecution } from '../../../public/kernel/actions.js';
import { getVisualizationFromToolResult, type VisualizationEnvelope } from '../../../contracts/geo.ts';
import { getVideoSceneFromToolResult, type VideoSceneItemV1 } from '../../../contracts/video.ts';
import type { DocumentView } from './document-state.ts';

export type CanvasView =
  | DocumentView
  | { id: string; kind: 'geo'; title: string; envelope: VisualizationEnvelope }
  | { id: string; kind: 'video'; title: string; item: VideoSceneItemV1; revision: number; compareItem?: VideoSceneItemV1 };
export type CanvasContent = { views: CanvasView[]; presentation: { key: string; id: string } | null };
export type CanvasState = { tabIds: string[]; activeId: string | null; open: boolean; presentationKey: string | null; documents: DocumentView[] };
export const EMPTY_CANVAS: CanvasState = { tabIds: [], activeId: null, open: false, presentationKey: null, documents: [] };

export function openCanvasDocument(state: CanvasState, document: DocumentView): CanvasState {
  const previous = state.documents.find((view) => view.id === document.id);
  const next = { ...document, locator: document.locator ?? previous?.locator, navigationId: (previous?.navigationId ?? 0) + (document.locator ? 1 : 0) };
  const documents = previous ? state.documents.map((view) => view.id === next.id ? next : view) : [...state.documents, next];
  return activateCanvas({ ...state, documents }, next.id);
}

export function withCanvasDocuments(content: CanvasContent, state: CanvasState): CanvasContent {
  return { ...content, views: [...content.views, ...state.documents] };
}

// Presentation order follows tool results, never unrelated Geo/Video revision counters.
export function projectCanvas(entries: SessionEntry[], executions: ToolExecution[]): CanvasContent {
  const views = new Map<string, CanvasView>();
  const seen = new Set<string>();
  const geoRevisions = new Map<string, number>();
  let videoRevision = -1;
  let presentation: CanvasContent['presentation'] = null;
  const accept = (value: unknown, key: string) => {
    const geo = getVisualizationFromToolResult(value);
    if (geo) {
      const id = `geo:${geo.visualizationId}`;
      if ((geoRevisions.get(id) ?? -1) > geo.revision) return;
      geoRevisions.set(id, geo.revision);
      if (geo.scene) {
        views.set(id, { id, kind: 'geo', title: geo.summary.title, envelope: geo });
        presentation = { key: `${key}:geo:${geo.revision}`, id };
      } else views.delete(id);
    }
    const video = getVideoSceneFromToolResult(value);
    if (video && video.revision >= videoRevision) {
      videoRevision = video.revision;
      for (const item of video.scene.videos) {
        const id = `video:${item.id}`;
        const previous = views.get(id);
        if (previous?.kind === 'video' && previous.revision > video.revision) continue;
        const compareItem = item.id === video.scene.activeVideoId
          ? video.scene.videos.find((candidate) => candidate.id === video.scene.compareVideoId) : undefined;
        views.set(id, { id, kind: 'video', title: item.title, item, revision: video.revision, compareItem });
      }
      const activeId = video.scene.activeVideoId ?? video.scene.videos.at(-1)?.id;
      if (activeId) presentation = { key: `${key}:video:${video.revision}`, id: `video:${activeId}` };
    }
  };
  entries.forEach((entry, index) => {
    if (entry.message?.isError) return;
    const key = entry.message?.toolCallId;
    if (key) seen.add(key);
    accept(entry.message, key ?? entry.id ?? String(index));
  });
  executions.forEach((execution) => {
    if (!seen.has(execution.toolCallId) && execution.status === 'completed' && !execution.isError) accept(execution.result, execution.toolCallId);
  });
  return { views: [...views.values()], presentation };
}

export function activateCanvas(state: CanvasState, id: string): CanvasState {
  return { ...state, tabIds: state.tabIds.includes(id) ? state.tabIds : [...state.tabIds, id], activeId: id, open: true };
}

export function syncCanvas(state: CanvasState, content: CanvasContent): CanvasState {
  const available = new Set(content.views.map((view) => view.id));
  const tabIds = state.tabIds.filter((id) => available.has(id));
  let next = { ...state, tabIds, activeId: tabIds.includes(state.activeId ?? '') ? state.activeId : tabIds.at(-1) ?? null, open: state.open && tabIds.length > 0 };
  const target = content.presentation;
  if (target && target.key !== state.presentationKey) {
    next.presentationKey = target.key;
    // Restore existing results on first load; later publications open their own tab.
    if (state.presentationKey === null) next.tabIds = [...new Set([...next.tabIds, ...content.views.filter((view) => view.kind !== 'document').map((view) => view.id)])];
    if (available.has(target.id)) next = activateCanvas(next, target.id);
  }
  return JSON.stringify(next) === JSON.stringify(state) ? state : next;
}

export function closeCanvasTab(state: CanvasState, id: string): CanvasState {
  const index = state.tabIds.indexOf(id);
  const tabIds = state.tabIds.filter((item) => item !== id);
  return { ...state, tabIds, activeId: state.activeId === id ? tabIds[Math.min(index, tabIds.length - 1)] ?? null : state.activeId, open: state.open && tabIds.length > 0 };
}
