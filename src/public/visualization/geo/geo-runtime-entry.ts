import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { GeoLayer, GeoSceneSnapshot, GeoVisualValue } from './protocol.js';

type Expression = unknown;
type LayerSpec = maplibregl.LayerSpecification;

const BASEMAP_STYLES: Record<Exclude<GeoSceneSnapshot['basemap']['id'], 'none'>, string> = {
  default: 'https://tiles.openfreemap.org/styles/positron',
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

function compile(value: GeoVisualValue | undefined, fallback: string | number | number[]): Expression {
  if (!value) return fallback;
  if (value.mode === 'constant') return value.value;
  if (value.mode === 'categorical') {
    return ['match', ['get', value.field], ...value.categories.flatMap((item) => [item.value, item.output]), value.fallback];
  }
  if (value.mode === 'step') {
    return ['step', ['to-number', ['get', value.field]], value.default, ...value.stops.flatMap((item) => [item.value, item.output])];
  }
  return ['interpolate', ['linear'], ['to-number', ['get', value.field]], ...value.stops.flatMap((item) => [item.value, item.output])];
}

function selectedColor(normal: Expression) {
  return ['case', ['boolean', ['feature-state', 'selected'], false], '#f59e0b', normal];
}

function interactiveSize(normal: Expression, hoverDelta: number, selectedDelta = hoverDelta) {
  return ['+', normal,
    ['case', ['boolean', ['feature-state', 'selected'], false], selectedDelta,
      ['boolean', ['feature-state', 'hover'], false], hoverDelta, 0],
  ];
}

function interactiveOpacity(normal: Expression) {
  return ['case',
    ['boolean', ['feature-state', 'selected'], false], 0.72,
    ['boolean', ['feature-state', 'hover'], false], 0.62,
    normal,
  ];
}

function runtimeSourceId(sourceId: string) {
  return `tau-source-${sourceId}`;
}

function runtimeLayerId(layerId: string, suffix = '') {
  return `tau-layer-${layerId}${suffix}`;
}

function layerBase(layer: GeoLayer, id: string, sourceId: string) {
  return {
    id,
    source: sourceId,
    minzoom: layer.minZoom,
    maxzoom: layer.maxZoom,
    layout: { visibility: layer.visible === false ? 'none' : 'visible' },
  };
}

function mapLayers(layer: GeoLayer, sourceId: string, darkBasemap: boolean): { specs: LayerSpec[]; interactiveId: string } {
  const id = runtimeLayerId(layer.id);
  const base = layerBase(layer, id, sourceId);
  if (layer.type === 'circle') {
    const radius = compile(layer.encoding.radius, 6);
    const color = compile(layer.encoding.color, '#2563eb');
    return {
      interactiveId: id,
      specs: [
        {
          ...base,
          id: runtimeLayerId(layer.id, '-halo'),
          type: 'circle',
          paint: {
            'circle-color': selectedColor(color),
            'circle-radius': interactiveSize(radius, 4, 5),
            'circle-opacity': 0.2,
            'circle-blur': 0.55,
          },
        } as LayerSpec,
        {
          ...base,
          type: 'circle',
          paint: {
            'circle-color': selectedColor(color),
            'circle-radius': interactiveSize(radius, 1.5, 2),
            'circle-opacity': compile(layer.encoding.opacity, 0.96),
            'circle-stroke-color': compile(layer.encoding.strokeColor, darkBasemap ? '#0f172a' : '#ffffff'),
            'circle-stroke-width': interactiveSize(compile(layer.encoding.strokeWidth, 2), 0.8, 1),
          },
        } as LayerSpec,
      ],
    };
  }
  if (layer.type === 'line') {
    const width = compile(layer.encoding.width, 3.5);
    const layout = { visibility: layer.visible === false ? 'none' : 'visible', 'line-cap': 'round', 'line-join': 'round' } as const;
    return {
      interactiveId: id,
      specs: [
        {
          ...base,
          id: runtimeLayerId(layer.id, '-casing'),
          type: 'line',
          layout,
          paint: {
            'line-color': darkBasemap ? '#111827' : '#ffffff',
            'line-width': ['+', width, 3.2],
            'line-opacity': 0.9,
          },
        } as LayerSpec,
        {
          ...base,
          type: 'line',
          layout,
          paint: {
            'line-color': selectedColor(compile(layer.encoding.color, '#2563eb')),
            'line-width': interactiveSize(width, 1.2, 1.8),
            'line-opacity': compile(layer.encoding.opacity, 0.94),
            'line-blur': 0.1,
            ...(layer.encoding.dash ? { 'line-dasharray': compile(layer.encoding.dash, [2, 1]) } : {}),
          },
        } as LayerSpec,
      ],
    };
  }
  if (layer.type === 'fill') return {
    interactiveId: id,
    specs: [{
      ...base,
      type: 'fill',
      paint: {
        'fill-color': selectedColor(compile(layer.encoding.color, '#60a5fa')),
        'fill-opacity': interactiveOpacity(compile(layer.encoding.opacity, 0.5)),
        'fill-outline-color': compile(layer.encoding.outlineColor, '#ffffff'),
      },
    } as LayerSpec],
  };
  const textValue = layer.encoding.textField;
  const textField = textValue?.mode === 'constant' && typeof textValue.value === 'string'
    ? ['coalesce', ['to-string', ['get', textValue.value]], textValue.value]
    : compile(textValue, '');
  return {
    interactiveId: id,
    specs: [{
      ...base,
      type: 'symbol',
      layout: {
        ...base.layout as object,
        'text-field': textField,
        'text-size': compile(layer.encoding.size, 12),
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
        'text-radial-offset': 0.85,
        'text-justify': 'auto',
        'text-padding': 3,
        'text-max-width': 12,
        'text-allow-overlap': false,
        'text-optional': true,
      },
      paint: {
        'text-color': selectedColor(compile(layer.encoding.color, darkBasemap ? '#f8fafc' : '#172033')),
        'text-halo-color': compile(layer.encoding.haloColor, darkBasemap ? '#111827' : '#ffffff'),
        'text-halo-width': compile(layer.encoding.haloWidth, 1.6),
        'text-halo-blur': 0.25,
      },
    } as unknown as LayerSpec],
  };
}

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
  private layerIds = new Map<string, string[]>();

  constructor(private container: HTMLElement, private onError: (message: string) => void) {}

  async replace(scene: GeoSceneSnapshot, sessionId: string | null) {
    this.destroy();
    this.container.replaceChildren();
    this.layerIds.clear();
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
    });
    this.map = map;
    map.on('error', (event) => {
      if (!map.isStyleLoaded()) this.onError(event.error?.message || 'MapLibre error');
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Map initialization timed out')), 10_000);
      map.once('load', () => {
        window.clearTimeout(timeout);
        resolve();
      });
    });
    if (this.map !== map) return;
    const sourceIds = new Map<string, string>();
    for (const source of scene.sources) {
      if (source.type === 'geojson-resource' && !sessionId) throw new Error('This map resource requires a live session');
      const sourceId = runtimeSourceId(source.id);
      sourceIds.set(source.id, sourceId);
      const data = source.type === 'geojson-inline'
        ? source.data
        : `/api/live-sessions/${encodeURIComponent(sessionId!)}/geo-resources/${encodeURIComponent(source.resourceId)}/data`;
      map.addSource(sourceId, {
        type: 'geojson',
        data: data as maplibregl.GeoJSONSourceSpecification['data'],
        ...(source.idField ? { promoteId: source.idField } : {}),
      });
    }
    const firstBasemapLabel = map.getStyle().layers?.find((layer) => layer.type === 'symbol')?.id;
    for (const layer of scene.layers) {
      const sourceId = sourceIds.get(layer.sourceId)!;
      const rendered = mapLayers(layer, sourceId, scene.basemap.id === 'dark');
      const beforeId = (layer.type === 'line' || layer.type === 'fill') ? firstBasemapLabel : undefined;
      for (const spec of rendered.specs) map.addLayer(spec, beforeId);
      this.layerIds.set(layer.id, rendered.specs.map((spec) => spec.id));
      this.bindPopup(map, layer, rendered.interactiveId, sourceId);
    }
    if (scene.controls?.navigation !== false) map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    if (scene.controls?.fullscreen) map.addControl(new maplibregl.FullscreenControl(), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');
    for (const selection of scene.selection || []) {
      const sourceId = sourceIds.get(selection.sourceId);
      if (sourceId) for (const id of selection.featureIds.slice(0, 5000)) map.setFeatureState({ source: sourceId, id }, { selected: true });
    }
    map.resize();
    if (scene.view.mode === 'bounds') map.fitBounds(scene.view.bounds, { padding: scene.view.padding ?? 32, duration: 0 });
  }

  setLayerVisibility(layerId: string, visible: boolean) {
    for (const id of this.layerIds.get(layerId) || []) {
      if (this.map?.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }

  resize() {
    this.map?.resize();
  }

  destroy() {
    this.map?.remove();
    this.map = null;
  }

  private bindPopup(map: MapLibreMap, layer: GeoLayer, renderedLayerId: string, sourceId: string) {
    let hoveredId: string | number | null = null;
    map.on('mousemove', renderedLayerId, (event) => {
      map.getCanvas().style.cursor = layer.popup?.fields.length ? 'pointer' : '';
      const id = event.features?.[0]?.id;
      if (id === undefined || id === hoveredId) return;
      if (hoveredId !== null) map.setFeatureState({ source: sourceId, id: hoveredId }, { hover: false });
      hoveredId = id;
      map.setFeatureState({ source: sourceId, id }, { hover: true });
    });
    map.on('mouseleave', renderedLayerId, () => {
      map.getCanvas().style.cursor = '';
      if (hoveredId !== null) map.setFeatureState({ source: sourceId, id: hoveredId }, { hover: false });
      hoveredId = null;
    });
    if (!layer.popup?.fields.length) return;
    map.on('click', renderedLayerId, (event) => {
      const feature = event.features?.[0];
      if (!feature) return;
      const root = document.createElement('div');
      root.className = 'geo-popup';
      const header = document.createElement('div');
      header.className = 'geo-popup-header';
      const eyebrow = document.createElement('span');
      eyebrow.textContent = '空间要素';
      const title = document.createElement('strong');
      title.textContent = layer.title || layer.id;
      header.append(eyebrow, title);
      root.appendChild(header);
      for (const field of layer.popup!.fields) {
        const row = document.createElement('div');
        row.className = 'geo-popup-row';
        const label = document.createElement('span');
        label.textContent = field.label;
        const value = document.createElement('strong');
        const raw = feature.properties?.[field.field];
        value.textContent = this.formatPopupValue(raw, field.format);
        row.append(label, value);
        root.appendChild(row);
      }
      new maplibregl.Popup({ closeButton: true, maxWidth: '340px', offset: 10 }).setLngLat(event.lngLat).setDOMContent(root).addTo(map);
    });
  }

  private formatPopupValue(value: unknown, format?: string) {
    if (value === null || value === undefined) return '—';
    if (typeof value !== 'number') return String(value);
    if (format === 'integer') return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
    if (format === 'decimal') return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
    if (format === 'percent') return new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 }).format(value);
    return String(value);
  }
}

export function createGeoMapRuntime(container: HTMLElement, onError: (message: string) => void) {
  return new MapLibreGeoRuntime(container, onError);
}
