import { AcEdViewMode, type AcApDocManager } from '@mlightcad/cad-simple-viewer';
import { AcGeBox2d } from '@mlightcad/data-model';

export type CadSelectionMode = 'point' | 'box' | 'pan';
export type SelectionBox = { left: number; top: number; width: number; height: number };

/** Keep pointer selection modes in the CAD adapter; pan/zoom remain SDK-owned. */
export function connectCadSelection(manager: AcApDocManager, mode: () => CadSelectionMode, box: (value: SelectionBox | null) => void) {
  const view = manager.curView;
  const canvas = view.canvas;
  view.mode = AcEdViewMode.PAN;
  let start: { x: number; y: number; pointerId: number } | null = null;
  const point = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const stop = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || mode() === 'pan' || start) return;
    stop(event);
    start = { ...point(event), pointerId: event.pointerId };
    canvas.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    if (!start || start.pointerId !== event.pointerId) return;
    stop(event);
    if (mode() !== 'box') return;
    const end = point(event);
    box({ left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) });
  };
  const cancel = () => { start = null; box(null); };
  const up = (event: PointerEvent) => {
    if (!start || start.pointerId !== event.pointerId) return;
    stop(event);
    const origin = start;
    const end = point(event);
    cancel();
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    const action = event.shiftKey ? 'remove' : event.ctrlKey || event.metaKey ? 'add' : 'replace';
    if (mode() === 'box' && Math.hypot(end.x - origin.x, end.y - origin.y) > 4) {
      const a = view.screenToWorld(origin), b = view.screenToWorld(end);
      view.selectByBoxWithMode(new AcGeBox2d({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }), 'crossing', action);
    } else if (mode() === 'point' && Math.hypot(end.x - origin.x, end.y - origin.y) <= 4) {
      const layers = new Map(manager.curDocument.layerStore.getLayers().map((layer) => [layer.name, layer.isOn && !layer.isFrozen]));
      const hit = view.pick(view.screenToWorld(end)).find((item) => {
        const entity = manager.curDocument.database.getObjectById(item.id) as { layer?: string } | undefined;
        return !entity?.layer || layers.get(entity.layer) !== false;
      });
      view.applySelection(hit ? [hit.id] : [], action);
    }
  };
  const click = (event: MouseEvent) => { if (mode() !== 'pan' && event.button === 0) stop(event); };
  canvas.addEventListener('pointerdown', down, true);
  canvas.addEventListener('pointermove', move, true);
  canvas.addEventListener('pointerup', up, true);
  canvas.addEventListener('pointercancel', cancel);
  canvas.addEventListener('lostpointercapture', cancel);
  canvas.addEventListener('click', click, true);
  return () => {
    cancel();
    canvas.removeEventListener('pointerdown', down, true);
    canvas.removeEventListener('pointermove', move, true);
    canvas.removeEventListener('pointerup', up, true);
    canvas.removeEventListener('pointercancel', cancel);
    canvas.removeEventListener('lostpointercapture', cancel);
    canvas.removeEventListener('click', click, true);
  };
}
