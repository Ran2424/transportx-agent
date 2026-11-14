import { useEffect, useRef, useState } from 'react';
import { AttributionControl, Marker, type LngLatBounds, type Map as MapLibreMap, type GeoJSONSourceSpecification, type StyleSpecification } from 'maplibre-gl';
import { createSharedMap, applySharedMapView, setSharedGeoJSON, sharedMapStyle } from '../../../public/visualization/shared-map';
import type { SimulationFrame, SimulationNetworkView, SimulationQuery, SimulationRouteLink } from '../../../contracts/simulation';
import type { projectMapFrame, roadSpeedSamples } from './map-frame';

const isSimulationSource = (id: string) => id === 'simulation-network' || id === 'simulation-vehicles' || id === 'simulation-road-speed';
const hasBasemap = (map: MapLibreMap) => Object.keys(map.getStyle().sources).some(id => !isSimulationSource(id));
const railTypes = ['railway.subway', 'railway.rail', 'railway.conventional', 'railway.highspeed', 'railway.light_rail', 'railway.tram'];
export const speedColorStops = [0, 30, 60] as const;
const railLayer = 'simulation-rail';
const routeLayer = 'simulation-routes';
const speedLayer = 'simulation-road-speed';
const relatedRoutesLayer = 'simulation-related-routes';
const relatedNodesLayer = 'simulation-related-nodes';
const activePlatformLayer = 'simulation-active-platform';
type MapInputs = {
  active: boolean;
  geometry?: SimulationNetworkView;
  mapFrame?: ReturnType<typeof projectMapFrame> | false;
  currentFrame?: SimulationFrame;
  relatedRoutes: SimulationRouteLink[];
  relatedRail?: NonNullable<SimulationNetworkView['rail']>;
  selectedRailEdge?: string;
  activePlatform?: string;
  train?: SimulationFrame['vehicles'][string];
  trainState?: string;
  roadSamples?: ReturnType<typeof roadSpeedSamples>;
  selected: string;
  eventSequence?: number;
  query?: SimulationQuery;
  selectObject(id: string): void;
  setSelectedEdge(id: string): void;
};
export function useSimulationMap({ active, geometry, mapFrame, currentFrame, relatedRoutes, relatedRail, selectedRailEdge, activePlatform, train, trainState, roadSamples, selected, eventSequence, query, selectObject, setSelectedEdge }: MapInputs) {
  const locatedObject = useRef('');
  const [mapError, setMapError] = useState('');
  const [mapAttempt, setMapAttempt] = useState(0);
  const [mapReady, setMapReady] = useState(false);
  const [mapBounds, setMapBounds] = useState<LngLatBounds>();
  const [mapZoom, setMapZoom] = useState(15);
  const [showRoads, setShowRoads] = useState(true), [showRoutes, setShowRoutes] = useState(true);
  const [showVehicles, setShowVehicles] = useState(true), [showSpeeds, setShowSpeeds] = useState(false);
  const [showOsm, setShowOsm] = useState(false), [basemapStatus, setBasemapStatus] = useState('');
  const container = useRef<HTMLDivElement>(null), mapRef = useRef<MapLibreMap | null>(null);
  const resetBounds = useRef<[number, number, number, number] | null>(null);
  const mapMarkers = useRef(new Map<string, Marker>());
  useEffect(() => {
    if (!container.current || !geometry) return;
    setMapError('');
    const css = getComputedStyle(container.current), color = (name: string) => css.getPropertyValue(name).trim();
    const routeEdges = new Set(Object.values(geometry.routes).flat());
    const serviceEdges = [...new Set(Object.entries(geometry.routes).filter(([id]) => id !== 'route:road' && id !== geometry.rail?.lineId).flatMap(([, edges]) => edges))];
    const corridor = geometry.features.filter(({ properties }) => properties.nodeId || properties.edgeId && routeEdges.has(properties.edgeId));
    const coordinates = (corridor.length ? corridor : geometry.features).flatMap((feature) => feature.geometry.type === 'Point' ? [feature.geometry.coordinates] : feature.geometry.coordinates);
    const center = coordinates[0]; if (!center) return;
    const map = createSharedMap(container.current, { id: 'none' }, center, 15, color('--surface-canvas'));
    map.addControl(new AttributionControl({ compact: true }));
    mapRef.current = map;
    const target = container.current;
    const resize = new ResizeObserver(() => { if (target.clientWidth && target.clientHeight) map.resize(); });
    resize.observe(target);
    const paint = () => {
      if (!hasBasemap(map)) map.setPaintProperty('background', 'background-color', color('--surface-canvas'));
      map.setPaintProperty('simulation-network', 'line-color', color('--text-tertiary'));
      map.setPaintProperty(railLayer, 'line-color', ['match', ['get', 'networkType'], 'railway.subway', color('--status-info'),
        'railway.highspeed', color('--interactive-primary-bg'), 'railway.conventional', color('--status-success'), color('--text-secondary')]);
      map.setPaintProperty(routeLayer, 'line-color', color('--status-info'));
      map.setPaintProperty(relatedRoutesLayer, 'line-color', color('--interactive-primary-bg'));
      map.setPaintProperty(relatedNodesLayer, 'circle-color', color('--surface-raised'));
      map.setPaintProperty(relatedNodesLayer, 'circle-stroke-color', color('--interactive-primary-bg'));
      map.setPaintProperty(activePlatformLayer, 'circle-color', color('--surface-raised'));
      map.setPaintProperty(activePlatformLayer, 'circle-stroke-color', color('--status-success'));
      map.setPaintProperty(speedLayer, 'line-color', ['interpolate', ['linear'], ['get', 'kmh'], speedColorStops[0], color('--status-warning'), speedColorStops[1], color('--text-secondary'), speedColorStops[2], color('--status-info')]);
      map.setPaintProperty('simulation-nodes', 'circle-color', color('--surface-raised'));
      map.setPaintProperty('simulation-nodes', 'circle-stroke-color', color('--text-secondary'));
      map.setPaintProperty('simulation-vehicles', 'circle-color', ['match', ['get', 'kind'], 'bus', color('--status-info'), 'ridehail', color('--status-warning'), 'car', color('--interactive-primary-bg'), color('--text-secondary')]);
      map.setPaintProperty('simulation-vehicles', 'circle-stroke-color', color('--surface-canvas'));
    };
    const theme = new MutationObserver(() => { if (map.getLayer('simulation-vehicles')) paint(); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    map.once('load', () => {
      setSharedGeoJSON(map, 'simulation-network', geometry as GeoJSONSourceSpecification['data']);
      setSharedGeoJSON(map, 'simulation-vehicles', { type: 'FeatureCollection', features: [] });
      setSharedGeoJSON(map, speedLayer, { type: 'FeatureCollection', features: [] });
      map.addLayer({ id: 'simulation-network', source: 'simulation-network', type: 'line',
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['!', ['in', ['get', 'networkType'], ['literal', railTypes]]]],
        paint: { 'line-opacity': 0.72, 'line-width': ['interpolate', ['linear'], ['zoom'], 12,
          ['match', ['get', 'networkType'], ['highway.motorway', 'highway.trunk', 'highway.motorway_link', 'highway.trunk_link'], 3, 'highway.primary', 2, 1],
          16, ['match', ['get', 'networkType'], ['highway.motorway', 'highway.trunk', 'highway.motorway_link', 'highway.trunk_link'], 5, 'highway.primary', 4, 'highway.secondary', 3, 'highway.tertiary', 2, 1.5]] } });
      map.addLayer({ id: railLayer, source: 'simulation-network', type: 'line', filter: ['in', ['get', 'networkType'], ['literal', railTypes]],
        paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.2, 16, ['match', ['get', 'networkType'], 'railway.highspeed', 3, 'railway.subway', 2.5, 2]],
          'line-opacity': 0.64, 'line-dasharray': [2, 2] } });
      map.addLayer({ id: routeLayer, source: 'simulation-network', type: 'line', filter: ['in', ['get', 'edgeId'], ['literal', serviceEdges]],
        paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.3, 16, 2.6], 'line-opacity': 0.65 } });
      map.addLayer({ id: speedLayer, source: speedLayer, type: 'line', paint: { 'line-width': 4 } });
      map.addLayer({ id: relatedRoutesLayer, source: 'simulation-network', type: 'line', filter: ['==', ['get', 'edgeId'], ''],
        paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 16, 4], 'line-opacity': 0.82 } });
      map.addLayer({ id: 'simulation-nodes', source: 'simulation-network', type: 'circle', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4, 'circle-stroke-width': 2 } });
      map.addLayer({ id: relatedNodesLayer, source: 'simulation-network', type: 'circle', filter: ['==', ['get', 'nodeId'], ''], paint: { 'circle-radius': 7, 'circle-stroke-width': 3 } });
      map.addLayer({ id: activePlatformLayer, source: 'simulation-network', type: 'circle', filter: ['==', ['get', 'nodeId'], ''], paint: { 'circle-radius': 16, 'circle-stroke-width': 3 } });
      map.addLayer({ id: 'simulation-vehicles', source: 'simulation-vehicles', type: 'circle', paint: { 'circle-radius': ['match', ['get', 'kind'], 'bus', 6, 'ridehail', 5, 4], 'circle-stroke-width': 1 } });
      paint();
      const xs = coordinates.map((point) => point[0]), ys = coordinates.map((point) => point[1]);
      resetBounds.current = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      applySharedMapView(map, { mode: 'bounds', bounds: resetBounds.current }, 0);
      const updateBounds = () => { setMapBounds(map.getBounds()); setMapZoom(map.getZoom()); };
      map.on('moveend', updateBounds);
      updateBounds();
      map.on('click', (event) => {
        const picked = map.queryRenderedFeatures(event.point, { layers: ['simulation-vehicles', activePlatformLayer, relatedNodesLayer, 'simulation-nodes'] })[0];
        if (picked) { selectObject(String(picked.properties?.id || picked.properties?.nodeId)); return; }
        const [sample] = map.queryRenderedFeatures(event.point, { layers: [speedLayer] });
        if (sample?.properties?.edgeId) { setSelectedEdge(String(sample.properties.edgeId)); return; }
        const [routeEdge] = map.queryRenderedFeatures(event.point, { layers: [routeLayer] });
        const route = geometry.serviceRoutes?.find(item => geometry.routes[item.id].includes(routeEdge?.properties?.edgeId));
        if (route) { selectObject(route.id); return; }
        const [track] = map.queryRenderedFeatures(event.point, { layers: [railLayer] });
        if (geometry.rail?.edges.includes(track?.properties?.edgeId)) { selectObject(geometry.rail.lineId); return; }
        const [road] = map.queryRenderedFeatures(event.point, { layers: ['simulation-network'] });
        if (road?.properties?.edgeId) setSelectedEdge(String(road.properties.edgeId));
      });
      setMapReady(true);
    });
    map.on('error', (event) => setMapError(event.error?.message || '地图初始化失败'));
    const markers = mapMarkers.current;
    return () => {
      for (const marker of markers.values()) marker.remove();
      markers.clear();
      setMapReady(false); resize.disconnect(); theme.disconnect(); mapRef.current = null; resetBounds.current = null; map.remove();
    };
  }, [geometry, selectObject, setSelectedEdge, mapAttempt]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const background = container.current && getComputedStyle(container.current).getPropertyValue('--surface-canvas').trim();
    const base = sharedMapStyle({ id: showOsm ? 'default' : 'none' }, background || undefined);
    const apply = (next: StyleSpecification) => {
      const current = map.getStyle();
      map.setStyle({
        ...next,
        sources: { ...next.sources, ...Object.fromEntries(Object.entries(current.sources).filter(([id]) => isSimulationSource(id))) },
        layers: [...next.layers, ...current.layers.filter(layer => 'source' in layer && isSimulationSource(layer.source))],
      });
    };
    if (typeof base !== 'string') {
      if (hasBasemap(map)) apply(base);
      return;
    }
    const controller = new AbortController();
    setBasemapStatus('正在加载 OpenStreetMap 底图…');
    void fetch(base, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) }).then(response => {
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<StyleSpecification>;
    }).then(style => {
      if (controller.signal.aborted) return;
      apply(style);
      setBasemapStatus('');
    }).catch(() => {
      if (controller.signal.aborted) return;
      setBasemapStatus('OpenStreetMap 底图未能加载，仿真仍可回放。');
      setShowOsm(false);
    });
    return () => controller.abort();
  }, [mapReady, showOsm]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    for (const [id, visible] of [
      ['simulation-network', showRoads], [railLayer, showRoutes], [routeLayer, showRoutes],
      [relatedRoutesLayer, showRoutes], [relatedNodesLayer, showRoutes], [activePlatformLayer, showVehicles],
      ['simulation-vehicles', showVehicles], [speedLayer, showSpeeds],
    ] as const) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }, [mapReady, showRoads, showRoutes, showVehicles, showSpeeds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !geometry) return;
    const railEdges = selectedRailEdge && relatedRail?.edges.includes(selectedRailEdge) ? [selectedRailEdge] : relatedRail?.edges ?? [];
    const edgeIds = [...new Set([...relatedRoutes.flatMap(route => geometry.routes[route.id]), ...railEdges])];
    const nodeIds = [...new Set([...relatedRoutes.flatMap(route => [route.origin, route.target]), ...(relatedRail?.stops.map(stop => stop.platformId) ?? [])])];
    map.setFilter(relatedRoutesLayer, ['in', ['get', 'edgeId'], ['literal', edgeIds]]);
    map.setFilter(relatedNodesLayer, ['in', ['get', 'nodeId'], ['literal', nodeIds]]);
    map.setPaintProperty(railLayer, 'line-opacity', relatedRail || relatedRoutes.length ? 0.35 : 0.64);
    map.setPaintProperty(routeLayer, 'line-opacity', relatedRail || relatedRoutes.length ? 0.35 : 0.65);
  }, [mapReady, geometry, relatedRoutes, relatedRail, selectedRailEdge]);

  useEffect(() => {
    if (mapReady) mapRef.current?.setFilter(activePlatformLayer, ['==', ['get', 'nodeId'], activePlatform ?? '']);
  }, [mapReady, activePlatform]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !geometry) return;
    const features = !showSpeeds || !roadSamples ? [] : geometry.features.flatMap(feature => {
      const sample = feature.properties.edgeId && roadSamples.get(feature.properties.edgeId);
      if (!sample) return [];
      return [{ ...feature, properties: { ...feature.properties, kmh: 3.6 * sample.totalMetersPerSecond / sample.vehicleIds.length } }];
    });
    setSharedGeoJSON(map, speedLayer, { type: 'FeatureCollection', features });
  }, [mapReady, geometry, roadSamples, showSpeeds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !mapFrame || !active) return;
    setSharedGeoJSON(map, 'simulation-vehicles', { ...mapFrame.vehicles, features: mapFrame.vehicles.features.filter(feature => feature.properties.kind === 'vehicle') });
    const markers = mapMarkers.current;
    const routeIds = new Set(relatedRoutes.map(route => route.id));
    const detailed = mapFrame.markers.filter(marker => marker.kind === 'people'
      || showVehicles && mapBounds?.contains(marker.position));
    const visible = new Set(detailed.map(({ kind, id }) => `${kind}:${id}`));
    for (const [key, marker] of markers) {
      if (visible.has(key)) continue;
      marker.remove(); markers.delete(key);
    }
    for (const { id, kind, position, count, heading, people } of detailed) {
      const key = `${kind}:${id}`;
      let marker = markers.get(key);
      if (!marker) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `simulation-marker simulation-marker--${kind}`;
        if (kind !== 'people') {
          const glyph = document.createElement('i');
          glyph.className = `simulation-vehicle-icon simulation-vehicle-icon--${kind}`;
          glyph.setAttribute('aria-hidden', 'true');
          button.append(glyph);
        }
        button.append(document.createElement('span'));
        button.addEventListener('click', event => { event.stopPropagation(); selectObject(id); });
        marker = new Marker({ element: button, offset: kind === 'people' ? [0, -17] : [0, 0] }).setLngLat(position).addTo(map);
        markers.set(key, marker);
      } else marker.setLngLat(position);
      const button = marker.getElement();
      button.classList.toggle('simulation-marker--overview', mapZoom < 14 && (kind === 'car' || kind === 'ridehail'));
      const routeId = currentFrame?.fleet?.[id]?.route;
      button.toggleAttribute('data-related', selected !== id && (kind === 'metro' ? selected === relatedRail?.lineId || !!activePlatform && selected === activePlatform
        : !!routeId && routeIds.has(routeId)));
      button.setAttribute('aria-pressed', String(selected === id));
      const type = kind === 'metro' ? '地铁' : kind === 'bus' ? '公交' : kind === 'ridehail' ? '网约车' : '小汽车';
      const metroState = kind === 'metro' && trainState && train ? `${trainState}${activePlatform ? ` · ${activePlatform}` : ` · ${(train.speed * 3.6).toFixed(1)} km/h`}` : '';
      const label = kind === 'people' ? `${id} · 节点旅客 ${count} 人 · ${people?.join(' · ')}` : `${type} ${id}${count === undefined ? '' : ` · 载客 ${count} 人`}${metroState ? ` · ${metroState}` : ''}`;
      const glyph = button.querySelector('i');
      if (glyph) {
        glyph.toggleAttribute('data-heading', heading !== undefined);
        glyph.style.rotate = heading === undefined ? '' : `${heading}deg`;
      }
      if (button.title !== label) {
        button.querySelector('span')!.textContent = kind === 'metro' ? activePlatform ? '地铁 · 停站' : train ? `地铁 · ${train.speed > 0 ? `${(train.speed * 3.6).toFixed(1)} km/h` : '区间停车'}` : '地铁'
          : kind === 'bus' ? `公交 · ${count ?? '—'} 人` : kind === 'people' ? people?.length === 1 ? `${people[0]} 人` : `旅客 ${count} 人` : '';
        button.title = label;
        button.setAttribute('aria-label', label);
      }
    }
  }, [mapFrame, mapReady, active, selected, selectObject, mapBounds, mapZoom, showVehicles, train, trainState, activePlatform, currentFrame, relatedRoutes, relatedRail]);
  useEffect(() => { if (active) mapRef.current?.resize(); }, [active]);
  useEffect(() => {
    const map = mapRef.current;
    if (!active || !mapReady || !map || !query || !geometry) return;
    if (!selected) { locatedObject.current = ''; return; }
    const locationKey = `${selected}:${eventSequence ?? ''}`;
    if (locatedObject.current === locationKey) return;
    if (query.route?.id === selected && (geometry.serviceRoutes?.some(route => route.id === selected) || geometry.rail?.lineId === selected)) {
      const edges = new Set(query.route.edgeIds);
      const coordinates = geometry.features.flatMap(feature =>
        feature.geometry.type === 'LineString' && feature.properties.edgeId && edges.has(feature.properties.edgeId) ? feature.geometry.coordinates : []);
      if (coordinates.length) {
        const xs = coordinates.map(point => point[0]), ys = coordinates.map(point => point[1]);
        applySharedMapView(map, { mode: 'bounds', bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }, 0);
        locatedObject.current = locationKey;
      }
      return;
    }
    const nodeId = query.event?.nodeId ?? query.platformId ?? (query.node?.id === selected ? selected : undefined);
    const node = nodeId && geometry.features.find(item => item.properties.nodeId === nodeId);
    const position = node && node.geometry.type === 'Point' ? node.geometry.coordinates
      : query.vehicle?.id === selected ? query.vehicle.positionGeo : undefined;
    if (position) { map.panTo(position, { duration: 0 }); locatedObject.current = locationKey; }
  }, [active, mapReady, query, geometry, selected, eventSequence]);


  const resetView = () => { if (mapRef.current && resetBounds.current) applySharedMapView(mapRef.current, { mode: 'bounds', bounds: resetBounds.current }, 0); };
  return {
    container, mapBounds, mapReady, showRoads, setShowRoads, showRoutes, setShowRoutes, showVehicles, setShowVehicles,
    showSpeeds, setShowSpeeds, showOsm, setShowOsm, basemapStatus, setBasemapStatus, mapError, resetView,
    zoomIn: () => mapRef.current?.zoomIn(), zoomOut: () => mapRef.current?.zoomOut(),
    retryMap: () => setMapAttempt(value => value + 1),
  };
}
