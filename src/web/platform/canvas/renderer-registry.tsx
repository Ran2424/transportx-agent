import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { DOCUMENT_CANVAS_ADAPTER_ID, GEO_CANVAS_ADAPTER_ID, VIDEO_CANVAS_ADAPTER_ID } from '../../../contracts/canvas-document';
import type { CanvasView } from './canvas-state';
import { canvasAdapterForView } from './adapter-registry';
import type { CanvasRendererProps } from './renderers/types';

const loaders: Record<string, () => Promise<{ default: ComponentType<CanvasRendererProps> }>> = {
  [DOCUMENT_CANVAS_ADAPTER_ID]: () => import('./renderers/DocumentCanvasRenderer'),
  [GEO_CANVAS_ADAPTER_ID]: () => import('./renderers/GeoCanvasRenderer'),
  [VIDEO_CANVAS_ADAPTER_ID]: () => import('./renderers/VideoCanvasRenderer'),
};
const renderers = new Map<string, LazyExoticComponent<ComponentType<CanvasRendererProps>>>();

export function rendererForCanvasView(view: CanvasView) {
  const adapter = canvasAdapterForView(view);
  const load = adapter && loaders[adapter.adapterId];
  if (!adapter || !load) return null;
  let renderer = renderers.get(adapter.adapterId);
  if (!renderer) { renderer = lazy(load); renderers.set(adapter.adapterId, renderer); }
  return renderer;
}
