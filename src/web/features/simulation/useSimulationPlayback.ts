import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';

export function useSimulationPlayback(active: boolean, playing: boolean, speed: number, time: number, availableTime: number | undefined, setTime: Dispatch<SetStateAction<number>>, setPlaying: Dispatch<SetStateAction<boolean>>) {
  const clock = useRef(time);
  clock.current = time;
  useEffect(() => {
    if (!playing || !active || availableTime === undefined) return;
    let animation = 0, last = performance.now(), cursor = clock.current;
    const tick = (wall: number) => {
      cursor += (wall - last) / 1000 * speed; last = wall;
      const next = Math.min(availableTime, Math.floor(cursor / 2) * 2);
      setTime((previous) => previous === next ? previous : next);
      if (cursor >= availableTime) { setTime(availableTime); setPlaying(false); return; }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playing, active, speed, availableTime, setTime, setPlaying]);
}
