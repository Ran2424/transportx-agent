import type { Map as MapLibreMap } from 'maplibre-gl';

// Capture in the idle callback, after tiles, camera movement and transitions have rendered.
export function captureRenderedMap(map: MapLibreMap, capture: () => string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const canvas = map.getCanvas();
    let settled = false;
    const finish = (cause?: Error, dataUrl?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      map.off('idle', onIdle);
      map.off('remove', onRemove);
      map.off('error', onError);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      if (cause) reject(cause);
      else resolve(dataUrl!);
    };
    const onIdle = () => {
      try { finish(undefined, capture()); }
      catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
    };
    const onRemove = () => finish(new Error('Map was closed before screenshot capture'));
    const onError = () => finish(new Error('Map resources failed to load; retry the screenshot after the map is ready'));
    const onContextLost = () => finish(new Error('Map graphics context was lost; reopen the map and retry'));
    const timeout = setTimeout(() => finish(new Error('Map rendering timed out; wait for the map to load and retry')), timeoutMs);
    map.on('idle', onIdle);
    map.on('remove', onRemove);
    map.on('error', onError);
    canvas.addEventListener('webglcontextlost', onContextLost);
    try { map.resize(); map.triggerRepaint(); }
    catch (cause) { finish(cause instanceof Error ? cause : new Error(String(cause))); }
  });
}

export function assertMapCanvasRendered(canvas: HTMLCanvasElement) {
  if (!canvas.width || !canvas.height) throw new Error('Map screenshot has no dimensions; reopen the map and retry');
  const sample = document.createElement('canvas');
  sample.width = sample.height = 16;
  const ctx = sample.getContext('2d');
  if (!ctx) throw new Error('Screenshot canvas is unavailable');
  ctx.drawImage(canvas, 0, 0, 16, 16);
  const pixels = ctx.getImageData(0, 0, 16, 16).data;
  let transparent = true, black = true, white = true;
  for (let index = 0; index < pixels.length; index += 4) {
    transparent &&= pixels[index + 3] === 0;
    black &&= pixels[index] === 0 && pixels[index + 1] === 0 && pixels[index + 2] === 0;
    white &&= pixels[index] === 255 && pixels[index + 1] === 255 && pixels[index + 2] === 255;
  }
  if (transparent || black || white) throw new Error('Map screenshot is blank; wait for the map to render and retry');
}
