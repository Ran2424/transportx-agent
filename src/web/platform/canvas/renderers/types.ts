import type { LiveSession } from '../../../../public/app-types.js';
import type { CanvasView } from '../canvas-state.ts';
import type { DocumentPosition } from '../document-state.ts';

export type CanvasRendererProps = {
  session: LiveSession;
  view: CanvasView;
  active: boolean;
  documentPositions: Map<string, DocumentPosition>;
  onContextChange(target?: unknown, selection?: unknown): void;
};
