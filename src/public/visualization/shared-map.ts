import maplibregl, { type Map as MapLibreMap, type GeoJSONSource, type GeoJSONSourceSpecification, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { GeoSceneSnapshot, GeoView } from '../../contracts/geo.js';

const BASEMAP_STYLES = {
  default: 'https://tiles.openfreemap.org/styles/positron',
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
export function sharedMapStyle(basemap: GeoSceneSnapshot['basemap'], background = '#f7f8fa'): StyleSpecification | string {
  return basemap.id === 'none'
    ? { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': background } }] }
    : BASEMAP_STYLES[basemap.id];
}

export function createSharedMap(container: HTMLElement, basemap: GeoSceneSnapshot['basemap'], center: [number, number], zoom: number, background?: string) {
  return new maplibregl.Map({
    container, center, zoom,
    style: sharedMapStyle(basemap, background),
    attributionControl: basemap.id === 'none' ? false : { compact: true },
    localIdeographFontFamily: '"Noto Sans CJK SC", "PingFang SC", sans-serif',
    dragRotate: false, pitchWithRotate: false,
    canvasContextAttributes: { preserveDrawingBuffer: true },
  });
}
export function applySharedMapView(map: MapLibreMap, view: GeoView, duration: number) {
  if (view.mode === 'bounds') map.fitBounds(view.bounds, { padding: view.padding ?? 32, duration });
  else if (duration > 0) map.easeTo({ center: view.center, zoom: view.zoom, duration });
  else map.jumpTo({ center: view.center, zoom: view.zoom });
}
export function setSharedGeoJSON(map: MapLibreMap, id: string, data: GeoJSONSourceSpecification['data']) {
  const source = map.getSource(id) as GeoJSONSource | undefined;
  if (source) source.setData(data);
  else map.addSource(id, { type: 'geojson', data });
}
