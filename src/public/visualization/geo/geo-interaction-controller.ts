import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import type { GeoLayer } from '../../../contracts/geo.js';

export class GeoInteractionController {
  private cleanupCallbacks: Array<() => void> = [];
  private popup: maplibregl.Popup | null = null;

  constructor(private map: MapLibreMap) {}

  bindLayer(layer: GeoLayer, renderedLayerId: string, sourceId: string) {
    let hoveredId: string | number | null = null;
    const onMove = (event: maplibregl.MapLayerMouseEvent) => {
      this.map.getCanvas().style.cursor = layer.popup?.fields.length ? 'pointer' : '';
      const id = event.features?.[0]?.id;
      if (id === undefined || id === hoveredId) return;
      if (hoveredId !== null) this.map.setFeatureState({ source: sourceId, id: hoveredId }, { hover: false });
      hoveredId = id;
      this.map.setFeatureState({ source: sourceId, id }, { hover: true });
    };
    const onLeave = () => {
      this.map.getCanvas().style.cursor = '';
      if (hoveredId !== null) this.map.setFeatureState({ source: sourceId, id: hoveredId }, { hover: false });
      hoveredId = null;
    };
    this.map.on('mousemove', renderedLayerId, onMove);
    this.map.on('mouseleave', renderedLayerId, onLeave);
    this.cleanupCallbacks.push(() => {
      this.map.off('mousemove', renderedLayerId, onMove);
      this.map.off('mouseleave', renderedLayerId, onLeave);
      if (hoveredId !== null && this.map.getSource(sourceId)) {
        this.map.setFeatureState({ source: sourceId, id: hoveredId }, { hover: false });
      }
    });

    if (!layer.popup?.fields.length) return;
    const onClick = (event: maplibregl.MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature) return;
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
      this.popup = new maplibregl.Popup({ closeButton: true, maxWidth: '340px', offset: 10 })
        .setLngLat(event.lngLat)
        .setDOMContent(root)
        .addTo(this.map);
    };
    this.map.on('click', renderedLayerId, onClick);
    this.cleanupCallbacks.push(() => this.map.off('click', renderedLayerId, onClick));
  }

  clear() {
    for (const cleanup of this.cleanupCallbacks.splice(0)) cleanup();
    this.popup?.remove();
    this.popup = null;
    this.map.getCanvas().style.cursor = '';
  }
}

function formatPopupValue(value: unknown, format?: string) {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number') return String(value);
  if (format === 'integer') return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
  if (format === 'decimal') return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
  if (format === 'percent') return new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 }).format(value);
  return String(value);
}
