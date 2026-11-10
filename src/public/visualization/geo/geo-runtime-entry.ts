import maplibregl, {
  type IControl,
  type Map as MapLibreMap,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createSharedMap, applySharedMapView, setSharedGeoJSON } from '../shared-map.js';
import type {
  GeoClientContextV1,
  GeoContextMode,
  GeoLayer,
  GeoSceneSnapshot,
  GeoSource,
  GeoView,
  VisualizationEnvelope,
} from '../../../contracts/geo.js';
import {
  compileGeoLayer,
  geoRuntimeSourceId,
} from './geo-layer-compiler.js';
import { usesLocalBasemapName } from './geo-basemap-labels.js';
import { GeoChartImageManager } from './geo-chart-images.js';
import { GeoInteractionController } from './geo-interaction-controller.js';
import { assertMapCanvasRendered, captureRenderedMap } from './geo-screenshot.js';
import { geoLegendItems, geoLegendGroups, geoLegendCaption, drawGeoLegendRamp, drawGeoLegendSymbol, type GeoLegendSymbol, type GeoLegendSection } from './geo-legend.js';
import type { GeoInteractionControllerEvent, GeoUserDraft } from './geo-interaction-controller.js';
import {
  planGeoSceneUpdate,
  retainedLayerVisibility,
} from './geo-scene-reconciler.js';

export type GeoInteractionEvent =
  | { type: 'draft_changed'; draft: GeoClientContextV1 | null }
  | { type: 'draft_stale'; previousRevision: number; nextRevision: number }
  | { type: 'limit_reached'; limit: number }
  | { type: 'unselectable_layer'; layerId: string };

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

function composeScreenshot(
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
  measure.font = `11px ${fontFamily}`;
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
    ctx.font = `11px ${fontFamily}`; ctx.fillStyle = primary;
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
    ctx.font = `11px ${fontFamily}`; ctx.fillStyle = secondary;
    descriptionLines.forEach((line, index) => ctx.fillText(line, 13, cssHeight + 19 + index * 18));
  }
  return output.toDataURL('image/png');
}

class MapLibreGeoRuntime {
  private map: MapLibreMap | null = null;
  private scene: GeoSceneSnapshot | null = null;
  private sessionId: string | null = null;
  private revision = 0;
  private layerIds = new Map<string, string[]>();
  private visibilityOverrides = new Map<string, boolean>();
  private interactions: GeoInteractionController | null = null;
  private chartImages: GeoChartImageManager | null = null;
  private navigationControl: maplibregl.NavigationControl | null = null;
  private fullscreenControl: maplibregl.FullscreenControl | null = null;
  private scaleControl: maplibregl.ScaleControl | null = null;
  private updateQueue: Promise<void> = Promise.resolve();
  private destroyed = false;
  private visualizationId = '';
  private listeners = new Set<(event: GeoInteractionEvent) => void>();

  constructor(private container: HTMLElement, private onError: (message: string) => void, private stage: HTMLElement = container) {}

  apply(envelope: VisualizationEnvelope, sessionId: string | null) {
    if (this.destroyed) return Promise.resolve();
    const update = this.updateQueue.then(() => this.applyEnvelope(envelope, sessionId));
    this.updateQueue = update.catch(() => {});
    return update;
  }

  setLayerVisibility(layerId: string, visible: boolean) {
    this.visibilityOverrides.set(layerId, visible);
    for (const id of this.layerIds.get(layerId) || []) {
      if (this.map?.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }

  async applyAgentSelection(input: { layerId: string; featureIds: Array<string | number>; fit?: boolean }) {
    if (!this.scene || input.featureIds.length > 1000) throw new Error('Agent selection must contain at most 1,000 features');
    const layer = this.scene.layers.find((item) => item.id === input.layerId);
    const source = layer && this.scene.sources.find((item) => item.id === layer.sourceId);
    if (!layer || !source) throw new Error(`Layer not found: ${input.layerId}`);
    const runtimeSource = geoRuntimeSourceId(source.id);
    for (const id of input.featureIds) this.map?.setFeatureState({ source: runtimeSource, id }, { selectedByAgent: true });
    if (input.fit && this.map) {
      const selected = new Set(input.featureIds.map((id) => `${typeof id}:${String(id)}`));
      const bounds = new maplibregl.LngLatBounds();
      for (const feature of this.map.querySourceFeatures(runtimeSource)) {
        if (feature.id !== undefined && selected.has(`${typeof feature.id}:${String(feature.id)}`)) extendGeometry(bounds, feature.geometry);
      }
      if (!bounds.isEmpty()) this.map.fitBounds(bounds, { padding: 32, duration: 250 });
    }
  }

  setInteractionMode(mode: 'browse' | GeoContextMode, options: { forRequest?: boolean; targetLayerIds?: string[]; maxFeatures?: number } = {}) {
    this.interactions?.setMode(mode, options);
  }

  clearUserDraft() { this.interactions?.clearDraft(); }

  async captureScreenshot(expectedRevision: number, language = 'zh') {
    await this.updateQueue;
    await document.fonts.ready;
    const map = this.map, scene = this.scene;
    const revision = this.revision;
    if (!map || !scene || this.destroyed) throw new Error('Map is not ready');
    if (revision !== expectedRevision) throw new Error('Map scene changed; retry the screenshot');
    return captureRenderedMap(map, () => {
      if (this.map !== map || this.scene !== scene || this.revision !== revision) throw new Error('Map scene changed; retry the screenshot');
      assertMapCanvasRendered(map.getCanvas());
      return composeScreenshot(map.getCanvas(), this.container, this.stage, scene, this.visibilityOverrides, language);
    });
  }

  getUserDraft() {
    const draft = this.interactions?.getDraft();
    return draft ? this.clientContext(draft) : null;
  }

  subscribe(listener: (event: GeoInteractionEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  fitToScene() {
    if (this.scene) this.applyView(this.scene.view, 250);
  }

  fitToData() { this.fitToScene(); }

  resize() {
    this.map?.resize();
  }

  destroy() {
    this.destroyed = true;
    this.teardownMap();
    this.visibilityOverrides.clear();
    this.scene = null;
    this.sessionId = null;
    this.revision = 0;
    this.visualizationId = '';
    this.listeners.clear();
  }

  private async applyEnvelope(envelope: VisualizationEnvelope, sessionId: string | null) {
    if (this.destroyed || envelope.revision <= this.revision) return;
    if (this.interactions?.getDraft()) {
      const previousRevision = this.revision;
      this.interactions.clearDraft();
      this.publish({ type: 'draft_stale', previousRevision, nextRevision: envelope.revision });
    }
    this.visualizationId = envelope.visualizationId;
    if (!envelope.scene) {
      this.teardownMap();
      this.scene = null;
      this.revision = envelope.revision;
      return;
    }
    if (!this.map || !this.scene || this.sessionId !== sessionId) {
      await this.mount(envelope.scene, sessionId, true);
      this.revision = envelope.revision;
      return;
    }

    const plan = planGeoSceneUpdate(this.scene, envelope.scene, envelope.operation);
    if (plan.rebuildMap) {
      this.visibilityOverrides = retainedLayerVisibility(this.scene, envelope.scene, this.visibilityOverrides);
      await this.mount(envelope.scene, sessionId, false);
    } else {
      try {
        if (plan.reconcileContent) this.reconcile(this.scene, envelope.scene, sessionId);
        else if (plan.applySelection) this.applySelection(this.scene, envelope.scene);
        if (plan.applyView) this.applyView(envelope.scene.view, 250);
      } catch {
        await this.mount(envelope.scene, sessionId, false);
      }
    }
    this.scene = envelope.scene;
    this.sessionId = sessionId;
    this.revision = envelope.revision;
  }

  private async mount(scene: GeoSceneSnapshot, sessionId: string | null, resetLocalState: boolean) {
    this.teardownMap();
    if (resetLocalState) this.visibilityOverrides.clear();
    this.container.replaceChildren();
    const center = scene.view.mode === 'camera' ? scene.view.center : [0, 0] as [number, number];
    const zoom = scene.view.mode === 'camera' ? scene.view.zoom : 1;
    const map = createSharedMap(this.container, scene.basemap, center, zoom);
    this.map = map;
    map.on('error', (event) => {
      if (!map.isStyleLoaded()) this.onError(event.error?.message || 'MapLibre error');
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (cause?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        map.off('load', onLoad);
        if (cause) reject(cause);
        else resolve();
      };
      const onLoad = () => finish();
      const timeout = window.setTimeout(() => finish(new Error('Map initialization timed out')), 10_000);
      if (map.isStyleLoaded()) finish();
      else map.once('load', onLoad);
    });
    if (this.destroyed || this.map !== map) return;
    this.showOnlyLocalBasemapLabels(map);
    this.interactions = new GeoInteractionController(map, (event) => this.handleInteractionEvent(event));
    this.chartImages = new GeoChartImageManager(map);
    for (const source of scene.sources) this.addSource(source, sessionId);
    this.addLayers(scene);
    this.syncControls(scene);
    this.applySelection(null, scene);
    this.applyView(scene.view, 0);
    map.resize();
    this.scene = scene;
    this.sessionId = sessionId;
  }

  private showOnlyLocalBasemapLabels(map: MapLibreMap) {
    for (const layer of map.getStyle().layers ?? []) {
      if (layer.type !== 'symbol') continue;
      const textField = map.getLayoutProperty(layer.id, 'text-field');
      if (usesLocalBasemapName(textField)) {
        map.setLayoutProperty(layer.id, 'text-field', ['get', 'name:nonlatin']);
      }
    }
  }

  private reconcile(previous: GeoSceneSnapshot, next: GeoSceneSnapshot, sessionId: string | null) {
    const map = this.requireMap();
    this.visibilityOverrides = retainedLayerVisibility(previous, next, this.visibilityOverrides);
    this.removeLayers();
    this.reconcileSources(previous, next, sessionId);
    this.addLayers(next);
    this.syncControls(next);
    this.applySelection(previous, next);
    map.resize();
  }

  private reconcileSources(previous: GeoSceneSnapshot, next: GeoSceneSnapshot, sessionId: string | null) {
    const map = this.requireMap();
    const previousById = new Map(previous.sources.map((source) => [source.id, source]));
    const nextIds = new Set(next.sources.map((source) => source.id));
    for (const source of previous.sources) {
      const runtimeId = geoRuntimeSourceId(source.id);
      if (!nextIds.has(source.id) && map.getSource(runtimeId)) map.removeSource(runtimeId);
    }
    for (const source of next.sources) {
      const oldSource = previousById.get(source.id);
      const runtimeId = geoRuntimeSourceId(source.id);
      if (!oldSource || !map.getSource(runtimeId)) {
        this.addSource(source, sessionId);
        continue;
      }
      if (oldSource.type !== source.type || oldSource.idField !== source.idField) {
        map.removeSource(runtimeId);
        this.addSource(source, sessionId);
        continue;
      }
      if (sourceDataKey(oldSource) !== sourceDataKey(source)) {
        setSharedGeoJSON(map, runtimeId, this.sourceData(source, sessionId));
      }
    }
  }

  private addSource(source: GeoSource, sessionId: string | null) {
    if (source.type === 'geojson-resource' && !sessionId) throw new Error('This map resource requires a live session');
    this.requireMap().addSource(geoRuntimeSourceId(source.id), {
      type: 'geojson',
      data: this.sourceData(source, sessionId),
      ...(source.idField ? { promoteId: source.idField } : {}),
    });
  }

  private sourceData(source: GeoSource, sessionId: string | null): maplibregl.GeoJSONSourceSpecification['data'] {
    return source.type === 'geojson-inline'
      ? source.data as maplibregl.GeoJSONSourceSpecification['data']
      : `/api/conversations/${encodeURIComponent(sessionId!)}/geo-resources/${encodeURIComponent(source.resourceId)}/data`;
  }

  private addLayers(scene: GeoSceneSnapshot) {
    const map = this.requireMap();
    this.chartImages?.setLayers(scene.layers);
    const firstBasemapLabel = map.getStyle().layers?.find((layer) => layer.type === 'symbol')?.id;
    for (const originalLayer of scene.layers) {
      const override = this.visibilityOverrides.get(originalLayer.id);
      const layer: GeoLayer = override === undefined ? originalLayer : { ...originalLayer, visible: override };
      const sourceId = geoRuntimeSourceId(layer.sourceId);
      const rendered = compileGeoLayer(layer, sourceId, scene.basemap.id === 'dark');
      const beforeId = (layer.type === 'line' || layer.type === 'fill') ? firstBasemapLabel : undefined;
      for (const spec of rendered.specs) map.addLayer(spec, beforeId);
      this.layerIds.set(layer.id, rendered.specs.map((spec) => spec.id));
      const source = scene.sources.find((item) => item.id === layer.sourceId);
      this.interactions?.bindLayer(layer, rendered.interactiveId, sourceId, source?.type === 'geojson-resource');
    }
  }

  private removeLayers() {
    const map = this.requireMap();
    this.interactions?.clearLayerBindings();
    for (const ids of [...this.layerIds.values()].reverse()) {
      for (const id of [...ids].reverse()) if (map.getLayer(id)) map.removeLayer(id);
    }
    this.layerIds.clear();
  }

  private applySelection(previous: GeoSceneSnapshot | null, next: GeoSceneSnapshot) {
    const map = this.requireMap();
    for (const selection of previous?.selection || []) {
      const source = geoRuntimeSourceId(selection.sourceId);
      if (!map.getSource(source)) continue;
      for (const id of selection.featureIds.slice(0, 5000)) map.removeFeatureState({ source, id }, 'selectedByAgent');
    }
    for (const selection of next.selection || []) {
      const source = geoRuntimeSourceId(selection.sourceId);
      if (!map.getSource(source)) continue;
      for (const id of selection.featureIds.slice(0, 5000)) map.setFeatureState({ source, id }, { selectedByAgent: true });
    }
  }

  private syncControls(scene: GeoSceneSnapshot) {
    const map = this.requireMap();
    this.navigationControl = this.syncControl(
      this.navigationControl,
      scene.controls?.navigation !== false,
      () => new maplibregl.NavigationControl({ visualizePitch: false }),
      'top-right',
    );
    this.fullscreenControl = this.syncControl(
      this.fullscreenControl,
      scene.controls?.fullscreen === true,
      () => new maplibregl.FullscreenControl({ container: this.stage }),
      'top-right',
    );
    this.scaleControl = this.syncControl(
      this.scaleControl,
      true,
      () => new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }),
      'bottom-left',
    );
    map.resize();
  }

  private syncControl<T extends IControl>(
    current: T | null,
    enabled: boolean,
    create: () => T,
    position: maplibregl.ControlPosition,
  ) {
    const map = this.requireMap();
    if (enabled && !current) {
      const control = create();
      map.addControl(control, position);
      return control;
    }
    if (!enabled && current) {
      map.removeControl(current);
      return null;
    }
    return current;
  }

  private applyView(view: GeoView, duration: number) {
    const map = this.map;
    if (!map) return;
    applySharedMapView(map, view, duration);
  }

  private requireMap() {
    if (!this.map) throw new Error('Map is not initialized');
    return this.map;
  }

  private teardownMap() {
    this.interactions?.clear();
    this.interactions = null;
    this.chartImages?.destroy();
    this.chartImages = null;
    this.map?.remove();
    this.map = null;
    this.layerIds.clear();
    this.navigationControl = null;
    this.fullscreenControl = null;
    this.scaleControl = null;
  }

  private handleInteractionEvent(event: GeoInteractionControllerEvent) {
    if (event.type === 'draft_changed') this.publish({ type: 'draft_changed', draft: event.draft ? this.clientContext(event.draft) : null });
    else this.publish(event);
  }

  private clientContext(draft: GeoUserDraft): GeoClientContextV1 {
    const map = this.requireMap();
    const center = map.getCenter();
    const bounds = map.getBounds();
    const visibleLayerIds = (this.scene?.layers || []).filter((layer) => this.visibilityOverrides.get(layer.id) ?? (layer.visible !== false)).map((layer) => layer.id);
    return {
      version: 1,
      contextId: `geoctx_${globalThis.crypto?.randomUUID?.().replaceAll('-', '') || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`}`,
      visualizationId: this.visualizationId,
      sceneRevision: this.revision,
      mode: draft.mode,
      createdAt: new Date().toISOString(),
      view: { center: [center.lng, center.lat], zoom: map.getZoom(), bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()], bearing: map.getBearing(), pitch: map.getPitch() },
      visibleLayerIds,
      ...(draft.selection ? { selection: draft.selection } : {}),
      ...(draft.geometry ? { geometry: draft.geometry } : {}),
      summary: draft.summary,
    };
  }

  private publish(event: GeoInteractionEvent) { for (const listener of this.listeners) listener(event); }
}

function extendGeometryBounds(bounds: maplibregl.LngLatBounds, coordinates: unknown) {
  if (!Array.isArray(coordinates)) return;
  if (coordinates.length >= 2 && typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') { bounds.extend(coordinates as [number, number]); return; }
  for (const child of coordinates) extendGeometryBounds(bounds, child);
}

function extendGeometry(bounds: maplibregl.LngLatBounds, geometry: maplibregl.MapGeoJSONFeature['geometry']) {
  if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries) extendGeometry(bounds, child);
  } else {
    extendGeometryBounds(bounds, geometry.coordinates);
  }
}

function sourceDataKey(source: GeoSource) {
  return source.type === 'geojson-resource'
    ? source.resourceId
    : JSON.stringify(source.data);
}

export function createGeoMapRuntime(container: HTMLElement, onError: (message: string) => void, stage?: HTMLElement) {
  return new MapLibreGeoRuntime(container, onError, stage);
}
