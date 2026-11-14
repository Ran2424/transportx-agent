import type { Map as MapLibreMap } from 'maplibre-gl';
import type { GeoSceneSnapshot } from '../../../contracts/geo-scene.js';
import { geoLegendItems, geoLegendGroups, geoLegendCaption, drawGeoLegendRamp, drawGeoLegendSymbol, type GeoLegendSymbol, type GeoLegendSection } from './geo-legend.js';

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

function screenshotColor(style: CSSStyleDeclaration, name: string, fallback: string) {
  return style.getPropertyValue(name).trim() || fallback;
}

function wrapScreenshotText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  for (const paragraph of text.replaceAll('\t', '  ').split('\n')) {
    if (!paragraph) { lines.push(''); continue; }
    let line = '';
    let width = 0;
    for (const character of paragraph) {
      const characterWidth = ctx.measureText(character).width;
      if (line && width + characterWidth > maxWidth) {
        lines.push(line);
        line = character;
        width = characterWidth;
      } else {
        line += character;
        width += characterWidth;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

export function composeScreenshot(
  mapCanvas: HTMLCanvasElement,
  container: HTMLElement,
  stage: HTMLElement,
  scene: GeoSceneSnapshot,
  visibilityOverrides: ReadonlyMap<string, boolean>,
  language: string,
) {
  const cssWidth = mapCanvas.clientWidth || mapCanvas.width;
  const cssHeight = mapCanvas.clientHeight || mapCanvas.height;
  const scale = mapCanvas.width / Math.max(1, cssWidth);
  const style = getComputedStyle(container);
  const fontFamily = screenshotColor(style, '--tx-font-ui', 'sans-serif');
  const font = `${style.getPropertyValue('--font-size-secondary').trim() || '12px'} ${fontFamily}`;
  const surface = screenshotColor(style, '--surface-default', '#fbfbfa');
  const raised = screenshotColor(style, '--surface-raised', surface);
  const border = screenshotColor(style, '--border-default', 'rgba(36, 36, 36, 0.075)');
  const primary = screenshotColor(style, '--text-primary', '#242424');
  const secondary = screenshotColor(style, '--text-secondary', '#66635f');
  const layers = scene.controls?.legend === false ? [] : [...scene.layers].reverse().filter((layer) => visibilityOverrides.get(layer.id) ?? layer.visible !== false);
  const legendLayers = geoLegendItems(layers, scene.basemap.id === 'dark', language);
  const legendWidth = Math.min(260, cssWidth - 24);
  const measureCanvas = document.createElement('canvas');
  const measure = measureCanvas.getContext('2d');
  if (!measure) throw new Error('Screenshot canvas is unavailable');
  measure.font = font;
  const items: Array<{ x: number; y: number; text?: string; heading?: boolean; symbol?: GeoLegendSymbol; ramp?: GeoLegendSection['ramp'] }> = [];
  let legendY = 30;
  const addText = (text: string, x = 12, width = legendWidth - 24, heading = false) => {
    const lines = wrapScreenshotText(measure, text, Math.max(1, width));
    lines.forEach((line, row) => items.push({ x, y: legendY + row * 15, text: line, heading }));
    legendY += lines.length * 15;
  };
  // Export every visible key, independently of search, scrolling and collapsed groups.
  for (const legend of legendLayers) {
    const layer = legend.layer;
    items.push({ x: 10, y: legendY, symbol: legend.symbol });
    const top = legendY;
    addText(layer.title || layer.id, 46, legendWidth - 58, true);
    legendY = Math.max(legendY + 3, top + 26);
    for (const group of geoLegendGroups(legend.sections)) {
      if (group.title !== layer.title) addText(group.title, 12, legendWidth - 24, true);
      for (const section of group.sections) {
        if (section.channelTitle && (!section.ramp || group.sections.length > 1)) addText(geoLegendCaption(section, language));
        if (section.ramp) {
          items.push({ x: 12, y: legendY + 2, ramp: section.ramp });
          legendY += 14;
          items.push({ x: 12, y: legendY, text: section.ramp[0].label });
          const last = section.ramp[section.ramp.length - 1].label;
          items.push({ x: legendWidth - 12 - measure.measureText(last).width, y: legendY, text: last });
          legendY += 18;
        } else {
          const sizes = ['radius', 'width', 'size'].includes(section.channel || '');
          const columns = Math.min(sizes ? 3 : 2, section.entries.length) || 1;
          const columnWidth = (legendWidth - 24) / columns;
          for (let index = 0; index < section.entries.length; index += columns) {
            let rowHeight = 24;
            section.entries.slice(index, index + columns).forEach((entry, column) => {
              const x = 12 + column * columnWidth;
              items.push({ x: sizes ? x + (columnWidth - 30) / 2 : x, y: legendY, symbol: entry.symbol });
              const lines = wrapScreenshotText(measure, entry.label, Math.max(1, columnWidth - (sizes ? 5 : 38)));
              lines.forEach((line, row) => items.push({ x: sizes ? x + (columnWidth - measure.measureText(line).width) / 2 : x + 34, y: legendY + (sizes ? 21 : 3) + row * 14, text: line }));
              rowHeight = Math.max(rowHeight, lines.length * 14 + (sizes ? 24 : 6));
            });
            legendY += rowHeight;
          }
        }
        if (!section.field && section.note) addText(section.note);
        legendY += 5;
      }
    }
    legendY += 3;
  }
  const legendHeight = legendY + 5;
  if (legendLayers.length && (legendWidth < 180 || legendHeight > cssHeight - 24)) {
    throw new Error(language.startsWith('en') ? 'The complete legend does not fit. Enlarge the map or show fewer layers before saving.' : '完整图例超出地图范围，请放大地图或减少已显示图层后再保存。');
  }
  const panel = stage.querySelector<HTMLElement>('.geo-legend');
  const legendX = Math.max(12, Math.min(panel?.offsetLeft ?? 12, cssWidth - legendWidth - 12));
  const legendTop = Math.max(12, Math.min(panel?.offsetTop ?? 12, cssHeight - legendHeight - 12));
  const descriptionLines = scene.metadata.description ? wrapScreenshotText(measure, scene.metadata.description, Math.max(1, cssWidth - 26)) : [];
  const descriptionHeight = descriptionLines.length ? descriptionLines.length * 18 + 14 : 0;
  const output = document.createElement('canvas');
  output.width = mapCanvas.width;
  output.height = Math.ceil((cssHeight + descriptionHeight) * scale);
  const ctx = output.getContext('2d');
  if (!ctx) throw new Error('Screenshot canvas is unavailable');
  ctx.scale(scale, scale);
  ctx.drawImage(mapCanvas, 0, 0, cssWidth, cssHeight);
  if (legendLayers.length) {
    ctx.save(); ctx.translate(legendX, legendTop);
    ctx.fillStyle = raised; ctx.beginPath(); ctx.roundRect(0, 0, legendWidth, legendHeight, 12); ctx.fill();
    ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.stroke();
    ctx.font = font; ctx.fillStyle = primary;
    ctx.fillText(language.startsWith('en') ? 'Map legend' : '地图图例', 12, 19);
    for (const item of items) {
      if (item.symbol) {
        ctx.save(); ctx.translate(item.x, item.y); ctx.scale(0.75, 0.75);
        drawGeoLegendSymbol(ctx, item.symbol, 0, 0, 40, 28, raised); ctx.restore();
      }
      if (item.ramp) drawGeoLegendRamp(ctx, item.ramp, item.x, item.y, legendWidth - 24, 9);
      if (item.text !== undefined) {
        ctx.fillStyle = item.heading ? primary : secondary;
        ctx.fillText(item.text, item.x, item.y + 12);
      }
    }
    ctx.restore();
  }
  if (descriptionLines.length) {
    ctx.fillStyle = surface; ctx.fillRect(0, cssHeight, cssWidth, descriptionHeight);
    ctx.strokeStyle = border; ctx.beginPath(); ctx.moveTo(0, cssHeight + 0.5); ctx.lineTo(cssWidth, cssHeight + 0.5); ctx.stroke();
    ctx.font = font; ctx.fillStyle = secondary;
    descriptionLines.forEach((line, index) => ctx.fillText(line, 13, cssHeight + 19 + index * 18));
  }
  return output.toDataURL('image/png');
}
