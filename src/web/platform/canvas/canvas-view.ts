import type { CanvasPresentationV1 } from '../../../contracts/canvas.ts';
import type { VisualizationEnvelope } from '../../../contracts/geo.ts';
import type { VideoSceneItemV1 } from '../../../contracts/video.ts';
import type { DocumentView } from './document-state.ts';

export type CanvasView =
  | DocumentView
  | { id: string; kind: 'geo'; title: string; envelope: VisualizationEnvelope; canvas?: CanvasPresentationV1 }
  | { id: string; kind: 'video'; title: string; item: VideoSceneItemV1; revision: number; compareItem?: VideoSceneItemV1; canvas?: CanvasPresentationV1 }
  | { id: string; kind: 'cad'; title: string; revision: number; canvas: CanvasPresentationV1; previewPath?: string }
  | { id: string; kind: 'simulation'; title: string; revision: number; canvas: CanvasPresentationV1 };
