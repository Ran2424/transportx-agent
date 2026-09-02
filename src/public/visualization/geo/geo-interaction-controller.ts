import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import type { GeoContextMode, GeoLayer, GeoPointV1, GeoRectangleV1 } from '../../../contracts/geo.js';
import { pointGeometry, rectangleGeometry, toggleFeatureIds, viewportSummary } from './geo-interaction-state.js';

export type GeoInteractionMode = 'browse' | GeoContextMode;
export type GeoUserDraft = {
  mode: GeoContextMode;
  selection?: { layerId: string; featureIds: Array<string | number> };
  geometry?: GeoPointV1 | GeoRectangleV1;
  summary: string;
};
export type GeoInteractionControllerEvent =
  | { type: 'draft_changed'; draft: GeoUserDraft | null }
  | { type: 'limit_reached'; limit: number }
  | { type: 'unselectable_layer'; layerId: string };

type BoundLayer = { layer: GeoLayer; renderedLayerId: string; sourceId: string; selectable: boolean };
type ModeOptions = { forRequest?: boolean; targetLayerIds?: string[]; maxFeatures?: number };
const DRAFT_SOURCE = 'tau-geo-user-draft';

export class GeoInteractionController {
  private mapCleanupCallbacks: Array<() => void> = [];
  private layerCleanupCallbacks: Array<() => void> = [];
  private popup: maplibregl.Popup | null = null;
  private mode: GeoInteractionMode = 'browse';
  private options: ModeOptions = {};
  private draft: GeoUserDraft | null = null;
  private boundLayers: BoundLayer[] = [];
  private dragStart: [number, number] | null = null;

  constructor(private map: MapLibreMap, private emit: (event: GeoInteractionControllerEvent) => void = () => {}) {
    this.mountDraftLayers();
    this.bindMapInput();
  }

  bindLayer(layer: GeoLayer, renderedLayerId: string, sourceId: string, selectable: boolean) {
    this.boundLayers.push({ layer, renderedLayerId, sourceId, selectable });
    let hoveredId: string | number | null = null;
    const onMove = (event: maplibregl.MapLayerMouseEvent) => {
      this.map.getCanvas().style.cursor = this.mode === 'feature' || layer.popup?.fields.length ? 'pointer' : '';
      const id = event.features?.[0]?.id;
      if (id === undefined || id === hoveredId) return;
      if (hoveredId !== null) this.map.setFeatureState({ source: sourceId, id: hoveredId }, { hovered: false });
      hoveredId = id;
      this.map.setFeatureState({ source: sourceId, id }, { hovered: true });
    };
    const onLeave = () => {
      this.map.getCanvas().style.cursor = this.mode === 'point' || this.mode === 'rectangle' ? 'crosshair' : '';
      if (hoveredId !== null) this.map.setFeatureState({ source: sourceId, id: hoveredId }, { hovered: false });
      hoveredId = null;
    };
    const onClick = (event: maplibregl.MapLayerMouseEvent) => {
      if (this.mode === 'feature') {
        event.preventDefault();
        this.toggleFeature(layer, sourceId, selectable, event.features?.[0]?.id);
        return;
      }
      if (!layer.popup?.fields.length) return;
      const feature = event.features?.[0];
      if (feature) this.showPopup(layer, feature, event.lngLat);
    };
    this.map.on('mousemove', renderedLayerId, onMove);
    this.map.on('mouseleave', renderedLayerId, onLeave);
    this.map.on('click', renderedLayerId, onClick);
    this.layerCleanupCallbacks.push(() => {
      this.map.off('mousemove', renderedLayerId, onMove);
      this.map.off('mouseleave', renderedLayerId, onLeave);
      this.map.off('click', renderedLayerId, onClick);
      if (hoveredId !== null && this.map.getSource(sourceId)) this.map.setFeatureState({ source: sourceId, id: hoveredId }, { hovered: false });
    });
  }

  setMode(mode: GeoInteractionMode, options: ModeOptions = {}) {
    if (this.mode !== mode) this.clearDraft();
    this.mode = mode;
    this.options = options;
    this.dragStart = null;
    this.map.getCanvas().style.cursor = mode === 'point' || mode === 'rectangle' ? 'crosshair' : '';
    if (mode === 'rectangle') this.map.dragPan.disable(); else this.map.dragPan.enable();
    if (mode === 'viewport') this.captureViewport();
  }

  getDraft() { return this.draft; }

  clearDraft() {
    if (this.draft?.selection) this.applySelectionState(this.draft.selection, false);
    this.draft = null;
    this.setDraftGeometry(null);
    this.emit({ type: 'draft_changed', draft: null });
  }

  clear() {
    this.clearDraft();
    this.clearLayerBindings();
    for (const cleanup of this.mapCleanupCallbacks.splice(0)) cleanup();
    this.popup?.remove();
    this.popup = null;
    this.map.dragPan.enable();
    this.map.getCanvas().style.cursor = '';
    for (const id of ['tau-geo-draft-point', 'tau-geo-draft-fill', 'tau-geo-draft-line']) if (this.map.getLayer(id)) this.map.removeLayer(id);
    if (this.map.getSource(DRAFT_SOURCE)) this.map.removeSource(DRAFT_SOURCE);
  }

  clearLayerBindings() {
    for (const cleanup of this.layerCleanupCallbacks.splice(0)) cleanup();
    this.boundLayers = [];
  }

  private bindMapInput() {
    const onClick = (event: maplibregl.MapMouseEvent) => {
      if (this.mode !== 'point' || event.defaultPrevented) return;
      const geometry = pointGeometry(event.lngLat.lng, event.lngLat.lat);
      this.updateDraft({ mode: 'point', geometry, summary: `${geometry.coordinates[0].toFixed(6)}, ${geometry.coordinates[1].toFixed(6)}` });
    };
    const onDown = (event: maplibregl.MapMouseEvent) => {
      if (this.mode !== 'rectangle') return;
      event.preventDefault();
      this.dragStart = [event.lngLat.lng, event.lngLat.lat];
    };
    const onMove = (event: maplibregl.MapMouseEvent) => {
      if (this.mode === 'rectangle' && this.dragStart) this.updateRectangle(this.dragStart, [event.lngLat.lng, event.lngLat.lat]);
    };
    const onUp = (event: maplibregl.MapMouseEvent) => {
      if (this.mode !== 'rectangle' || !this.dragStart) return;
      this.updateRectangle(this.dragStart, [event.lngLat.lng, event.lngLat.lat]);
      this.dragStart = null;
    };
    this.map.on('click', onClick);
    this.map.on('mousedown', onDown);
    this.map.on('mousemove', onMove);
    this.map.on('mouseup', onUp);
    this.mapCleanupCallbacks.push(() => {
      this.map.off('click', onClick);
      this.map.off('mousedown', onDown);
      this.map.off('mousemove', onMove);
      this.map.off('mouseup', onUp);
    });
  }

  private mountDraftLayers() {
    this.map.addSource(DRAFT_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    this.map.addLayer({ id: 'tau-geo-draft-fill', type: 'fill', source: DRAFT_SOURCE, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#2563eb', 'fill-opacity': 0.16 } });
    this.map.addLayer({ id: 'tau-geo-draft-line', type: 'line', source: DRAFT_SOURCE, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': '#2563eb', 'line-width': 2, 'line-dasharray': [2, 1] } });
    this.map.addLayer({ id: 'tau-geo-draft-point', type: 'circle', source: DRAFT_SOURCE, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': '#2563eb', 'circle-radius': 7, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
  }

  private toggleFeature(layer: GeoLayer, sourceId: string, selectable: boolean, id: string | number | undefined) {
    if (!selectable || id === undefined) { this.emit({ type: 'unselectable_layer', layerId: layer.id }); return; }
    if (this.options.targetLayerIds?.length && !this.options.targetLayerIds.includes(layer.id)) { this.emit({ type: 'unselectable_layer', layerId: layer.id }); return; }
    const previous = this.draft?.selection;
    if (previous && previous.layerId !== layer.id) this.applySelectionState(previous, false);
    const limit = Math.min(1000, this.options.maxFeatures ?? 1000);
    const toggled = toggleFeatureIds(previous?.layerId === layer.id ? previous.featureIds : [], id, limit);
    if (toggled.limitReached) { this.emit({ type: 'limit_reached', limit }); return; }
    const ids = toggled.ids;
    if (previous?.layerId === layer.id) this.applySelectionState(previous, false);
    if (!ids.length) { this.updateDraft(null); return; }
    const selection = { layerId: layer.id, featureIds: ids };
    this.applySelectionState(selection, true, sourceId);
    this.updateDraft({ mode: 'feature', selection, summary: `${layer.title || layer.id} · ${ids.length} features` }, false);
  }

  private applySelectionState(selection: { layerId: string; featureIds: Array<string | number> }, selected: boolean, knownSourceId?: string) {
    const sourceId = knownSourceId || this.boundLayers.find((item) => item.layer.id === selection.layerId)?.sourceId;
    if (!sourceId || !this.map.getSource(sourceId)) return;
    const key = this.options.forRequest ? 'selectedForRequest' : 'selectedByUser';
    for (const id of selection.featureIds) this.map.setFeatureState({ source: sourceId, id }, { [key]: selected });
  }

  private updateRectangle(start: [number, number], end: [number, number]) {
    const geometry = rectangleGeometry(start, end);
    if (!geometry) return;
    const [west, south] = geometry.coordinates[0][0], [east, north] = geometry.coordinates[0][2];
    this.updateDraft({ mode: 'rectangle', geometry, summary: viewportSummary([west, south, east, north]) });
  }

  private captureViewport() {
    const bounds = this.map.getBounds();
    this.updateDraft({ mode: 'viewport', summary: viewportSummary([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]) });
  }

  private updateDraft(draft: GeoUserDraft | null, updateGeometry = true) {
    this.draft = draft;
    if (updateGeometry) this.setDraftGeometry(draft?.geometry || null);
    this.emit({ type: 'draft_changed', draft });
  }

  private setDraftGeometry(geometry: GeoPointV1 | GeoRectangleV1 | null) {
    const source = this.map.getSource(DRAFT_SOURCE) as maplibregl.GeoJSONSource | undefined;
    source?.setData({ type: 'FeatureCollection', features: geometry ? [{ type: 'Feature', properties: {}, geometry }] : [] });
  }

  private showPopup(layer: GeoLayer, feature: maplibregl.MapGeoJSONFeature, lngLat: maplibregl.LngLat) {
    const root = document.createElement('div');
    root.className = 'geo-popup';
    const header = document.createElement('div');
    header.className = 'geo-popup-header';
    const title = document.createElement('strong');
    title.textContent = layer.title || layer.id;
    header.append(title);
    root.appendChild(header);
    const fields = document.createElement('div');
    fields.className = 'geo-popup-fields';
    for (const field of layer.popup!.fields) {
      const row = document.createElement('div');
      row.className = 'geo-popup-row';
      const label = document.createElement('span');
      label.textContent = field.label;
      const value = document.createElement('strong');
      value.textContent = formatPopupValue(feature.properties?.[field.field], field.format);
      row.append(label, value);
      fields.appendChild(row);
    }
    root.appendChild(fields);
    this.popup?.remove();
    this.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '340px', offset: 10 }).setLngLat(lngLat).setDOMContent(root).addTo(this.map);
  }
}

function formatPopupValue(value: unknown, format?: string) {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number') return String(value);
  const locale = document.documentElement.lang || 'zh-CN';
  if (format === 'integer') return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
  if (format === 'decimal') return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  if (format === 'percent') return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value);
  return String(value);
}
