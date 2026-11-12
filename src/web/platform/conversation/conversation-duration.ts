import { useEffect, useState } from 'react';

export function useElapsedMilliseconds(startedAt: number | null, durationMs: number | null) {
  const [elapsed, setElapsed] = useState<number | null>(() => durationMs ?? (startedAt === null ? null : Math.max(0, Date.now() - startedAt)));
  useEffect(() => {
    if (durationMs !== null || startedAt === null) {
      setElapsed(durationMs);
      return;
    }
    let frame = 0;
    let displayedTenth = -1;
    const baseline = Math.max(0, Date.now() - startedAt);
    const baselineClock = performance.now();
    const update = () => {
      const next = baseline + performance.now() - baselineClock;
      const tenth = Math.floor(next / 100);
      if (tenth !== displayedTenth) {
        displayedTenth = tenth;
        setElapsed(next);
      }
      frame = window.requestAnimationFrame(update);
    };
    update();
    return () => window.cancelAnimationFrame(frame);
  }, [durationMs, startedAt]);
  return durationMs ?? elapsed;
}

export function durationSeconds(durationMs: number) {
  return (durationMs / 1_000).toFixed(1);
}
