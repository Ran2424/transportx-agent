import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { AppKernel } from '../../../public/kernel/app-kernel.js';
import { openCanvasResource, EMPTY_CANVAS, type CanvasState } from './canvas-state';

type Notices = ReturnType<AppKernel['stores']['session']['get']>['simulationBySession'];

export function useSimulationCanvas(activeSessionId: string | undefined, notices: Notices, commands: AppKernel['commands']['simulation'], setCanvases: Dispatch<SetStateAction<Record<string, CanvasState>>>) {
  const simulationSeen = useRef(new Set<string>());
  useEffect(() => {
    for (const [id, notice] of Object.entries(notices || {})) {
      const key = `${id}:${notice.canvas.viewId}`;
      if (simulationSeen.current.has(key)) continue;
      simulationSeen.current.add(key);
      setCanvases((current) => ({ ...current, [id]: openCanvasResource(current[id] ?? EMPTY_CANVAS, notice.canvas) }));
    }
  }, [notices, setCanvases]);
  useEffect(() => {
    if (!activeSessionId) return;
    const id = activeSessionId, controller = new AbortController();
    void commands.list(id, controller.signal).then(({ runs }) => {
      if (controller.signal.aborted) return;
      for (const { canvas: presentation } of runs) {
        const key = `${id}:${presentation.viewId}`;
        if (simulationSeen.current.has(key)) continue;
        simulationSeen.current.add(key);
        setCanvases((current) => {
          const previous = current[id] ?? EMPTY_CANVAS;
          const restored = openCanvasResource(previous, presentation);
          const hasNavigation = previous.presentationKey !== null || previous.tabIds.length > 0 || (previous.resources?.length ?? 0) > 0;
          return { ...current, [id]: hasNavigation ? { ...restored, tabIds: previous.tabIds, activeId: previous.activeId, open: previous.open } : restored };
        });
      }
    }).catch(() => { /* Conversations without this selected module have no Simulation resources. */ });
    return () => controller.abort();
  }, [activeSessionId, commands, setCanvases]);
}
