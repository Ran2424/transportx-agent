import maplibregl, {
  type GeoJSONSource,
  type IControl,
  type Map as MapLibreMap,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
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
import type { GeoInteractionControllerEvent, GeoUserDraft } from './geo-interaction-controller.js';
import {
  planGeoSceneUpdate,
  retainedLayerVisibility,
} from './geo-scene-reconciler.js';

const BASEMAP_STYLES: Record<Exclude<GeoSceneSnapshot['basemap']['id'], 'none'>, string> = {
  default: 'https://tiles.openfreemap.org/styles/positron',
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

export type GeoInteractionEvent =
  | { type: 'draft_changed'; draft: GeoClientContextV1 | null }
  | { type: 'draft_stale'; previousRevision: number; nextRevision: number }
  | { type: 'limit_reached'; limit: number }
  | { type: 'unselectable_layer'; layerId: string };

function blankStyle(basemap: GeoSceneSnapshot['basemap']) {
  const backgrounds = { default: '#eef3f8', light: '#f4f6f8', dark: '#17202b', none: '#f7f8fa' };
  return {
    version: 8 as const,
    sources: {},
    layers: [{ id: 'background', type: 'background' as const, paint: { 'background-color': backgrounds[basemap.id] } }],
  };
}

function styleForBasemap(basemap: GeoSceneSnapshot['basemap']) {
  return basemap.id === 'none' ? blankStyle(basemap) : BASEMAP_STYLES[basemap.id];
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

  constructor(private container: HTMLElement, private onError: (message: string) => void) {}

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

  captureScreenshot() {
    if (!this.map) throw new Error('Map is not ready');
    return this.map.getCanvas().toDataURL('image/png');
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
    const map = new maplibregl.Map({
      container: this.container,
      style: styleForBasemap(scene.basemap),
      center,
      zoom,
      attributionControl: scene.basemap.id === 'none' ? false : { compact: true },
      localIdeographFontFamily: '"Noto Sans CJK SC", "PingFang SC", sans-serif',
      dragRotate: false,
      pitchWithRotate: false,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
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
        (map.getSource(runtimeId) as GeoJSONSource).setData(this.sourceData(source, sessionId));
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
      : `/api/live-sessions/${encodeURIComponent(sessionId!)}/geo-resources/${encodeURIComponent(source.resourceId)}/data`;
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
      () => new maplibregl.FullscreenControl(),
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
    if (view.mode === 'bounds') {
      map.fitBounds(view.bounds, { padding: view.padding ?? 32, duration });
    } else if (duration > 0) {
      map.easeTo({ center: view.center, zoom: view.zoom, duration });
    } else {
      map.jumpTo({ center: view.center, zoom: view.zoom });
    }
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

export function createGeoMapRuntime(container: HTMLElement, onError: (message: string) => void) {
  return new MapLibreGeoRuntime(container, onError);
}
