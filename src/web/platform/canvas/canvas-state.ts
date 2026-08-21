export type CanvasItemKind = 'geo' | 'video';

export type CanvasItem = {
  id: string;
  kind: CanvasItemKind;
  resourceId: string;
  revision: number;
  title?: string;
};

export type CanvasState = {
  items: CanvasItem[];
  activeItemId: string | null;
  isOpen: boolean;
};

export type CanvasAction =
  | { type: 'itemsSynced'; items: CanvasItem[]; openLatest: boolean }
  | { type: 'itemActivated'; itemId: string }
  | { type: 'opened' }
  | { type: 'closed' };

export const INITIAL_CANVAS_STATE: CanvasState = { items: [], activeItemId: null, isOpen: false };

export function reduceCanvasState(state: CanvasState, action: CanvasAction): CanvasState {
  if (action.type === 'itemsSynced') {
    const activeItemId = action.items.some((item) => item.id === state.activeItemId)
      ? state.activeItemId
      : action.items[0]?.id ?? null;
    return {
      ...state,
      items: action.items,
      activeItemId: action.openLatest && action.items.length ? action.items[0].id : activeItemId,
      isOpen: action.openLatest && action.items.length ? true : state.isOpen && action.items.length > 0,
    };
  }
  if (action.type === 'itemActivated') {
    return state.items.some((item) => item.id === action.itemId)
      ? { ...state, activeItemId: action.itemId, isOpen: true }
      : state;
  }
  if (action.type === 'opened') return state.items.length ? { ...state, isOpen: true } : state;
  return { ...state, isOpen: false };
}
