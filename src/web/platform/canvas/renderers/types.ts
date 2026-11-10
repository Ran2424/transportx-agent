import type { ConversationView } from '../../../../public/app-types.js';
import type { CanvasView } from '../canvas-state.ts';
import type { DocumentPosition } from '../document-state.ts';
import type { AppKernel } from '../../../../public/kernel/app-kernel.js';

export type CanvasRendererProps = {
  kernel: AppKernel;
  session: ConversationView;
  view: CanvasView;
  active: boolean;
  documentPositions: Map<string, DocumentPosition>;
  onAttachContext?(): Promise<void>;
  contextStatus?: 'idle' | 'busy' | 'done' | 'error';
  onContextChange(target?: unknown, selection?: unknown): void;
};
