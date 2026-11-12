import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AttributionControl, Marker, type LngLatBounds, type Map as MapLibreMap, type GeoJSONSourceSpecification, type StyleSpecification } from 'maplibre-gl';
import { createSharedMap, applySharedMapView, setSharedGeoJSON, sharedMapStyle } from '../../../public/visualization/shared-map';
import { parseSimulationCanvasTarget, type SimulationCanvasPayload, type SimulationRunSummary, type SimulationIndex, type SimulationFrame, type SimulationNetworkView, type SimulationQuery, type SimulationBlock, type SimulationExperiment, type SimulationEvent } from '../../../contracts/simulation';
import type { CanvasRendererProps } from '../../platform/canvas/renderers/types';
import { Icon } from '../../components/icons';
import { projectMapFrame, roadSpeedSamples } from './map-frame';
import { MetroTimetable } from './MetroTimetable';
import { SimulationDetailsDrawer } from './SimulationDetailsDrawer';

const message = (error: unknown) => error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
const isSimulationSource = (id: string) => id === 'simulation-network' || id === 'simulation-vehicles' || id === 'simulation-road-speed';
const hasBasemap = (map: MapLibreMap) => Object.keys(map.getStyle().sources).some(id => !isSimulationSource(id));
const railTypes = ['railway.subway', 'railway.rail', 'railway.conventional', 'railway.highspeed', 'railway.light_rail', 'railway.tram'];
const speedColorStops = [0, 30, 60] as const;
const railLayer = 'simulation-rail';
const routeLayer = 'simulation-routes';
const speedLayer = 'simulation-road-speed';
const relatedRoutesLayer = 'simulation-related-routes';
const relatedNodesLayer = 'simulation-related-nodes';
const activePlatformLayer = 'simulation-active-platform';
const stateLabels: Record<string, string> = { prepared: '已受理', running: '计算中', finalizing: '确认中', ended: '已结束', unknown: '结果待确认', waiting: '候车', blocked: '上游受阻', boarding: '登乘', riding: '车上', walking: '步行接续', connecting: '等待接续', external: '外部行程', completed: '完成全链', not_arrived: '尚未到达', inserting: '等待入网', available: '可用', commanded: '发车待确认', outbound: '去程', return_commanded: '返场待确认', returning: '返场' };
const terminationLabels = { completed: '已完成', cancelled: '已取消', failed: '运行失败' };

export function SimulationWorkspace({ kernel, session, view, active, payload, onContextChange, onOpenDocument }: CanvasRendererProps & { payload: SimulationCanvasPayload }) {
  const runId = payload.runId, sessionId = session.id;
  const frameLabelId = useId();
  const [run, setRun] = useState<SimulationRunSummary>();
  const [index, setIndex] = useState<SimulationIndex | null>(null);
  const [geometry, setGeometry] = useState<SimulationNetworkView>();
  const [loaded, setLoaded] = useState<{ time: number; frame: SimulationFrame; sampleSeconds: number }>();
  const frame = loaded?.frame;
  const [queryResult, setQueryResult] = useState<{ data: SimulationQuery; selected: string; eventSequence?: number }>();
  const [experiment, setExperiment] = useState<SimulationExperiment>();
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(1);
  const [selected, setSelected] = useState(''), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [eventSequence, setEventSequence] = useState<number>();
  const currentFrame = loaded?.time === time ? frame : undefined;
  const frameQuery = queryResult?.data.requestedTime === time && queryResult.data.time === currentFrame?.time ? queryResult.data : undefined;
  const query = queryResult?.selected === selected && queryResult.eventSequence === eventSequence ? frameQuery : undefined;
  const [eventsOpen, setEventsOpen] = useState(false);
  const appliedPresentation = useRef('');
  const locatedObject = useRef('');
  const [mapReady, setMapReady] = useState(false);
  const [mapBounds, setMapBounds] = useState<LngLatBounds>();
  const [mapZoom, setMapZoom] = useState(15);
  const [showRoads, setShowRoads] = useState(true), [showRoutes, setShowRoutes] = useState(true);
  const [showVehicles, setShowVehicles] = useState(true), [showSpeeds, setShowSpeeds] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState('');
  const [showOsm, setShowOsm] = useState(false), [basemapStatus, setBasemapStatus] = useState('');
  const container = useRef<HTMLDivElement>(null), mapRef = useRef<MapLibreMap | null>(null);
  const resetBounds = useRef<[number, number, number, number] | null>(null);
  const mapMarkers = useRef(new Map<string, Marker>());
  const mapFrame = useMemo(() => frame && geometry && projectMapFrame(frame, geometry), [frame, geometry]);
  const fleetRoute = currentFrame?.fleet?.[selected]?.route;
  const relatedRoutes = useMemo(() => geometry?.serviceRoutes?.filter(route =>
    [route.id, route.origin, route.target].includes(selected) || route.id === fleetRoute) ?? [], [geometry, selected, fleetRoute]);
  const rail = geometry?.rail;
  const relatedRail = rail && (selected === rail.lineId || selected === rail.trainId || rail.stops.some(stop => stop.platformId === selected)) ? rail : undefined;
  const train = rail && currentFrame?.vehicles[rail.trainId];
  const activePlatform = train?.stopped ? rail?.stops.find(stop => train.lane === `${stop.edge}_${stop.lane}`)?.platformId : undefined;
  const trainState = activePlatform ? '站台停靠' : train ? train.speed > 0 ? '区间行驶' : '区间停车' : undefined;
  const selectedRailEdge = selected === rail?.trainId ? train?.edge : undefined;
  const roadSamples = useMemo(() => loaded?.time === time && frame && geometry ? roadSpeedSamples(frame, geometry) : undefined, [frame, geometry, loaded, time]);
  const cache = useRef(new Map<number, SimulationBlock>()), contextCallback = useRef(onContextChange);
  contextCallback.current = onContextChange;
  const subscribeSession = useCallback((changed: () => void) => kernel.stores.session.subscribe(changed), [kernel]);
  const notice = useSyncExternalStore(subscribeSession, () => kernel.stores.session.get().simulationBySession?.[sessionId]);
  const subscribeRuntime = useCallback((changed: () => void) => kernel.stores.runtime.subscribe(changed), [kernel]);
  const connection = useSyncExternalStore(subscribeRuntime, () => kernel.stores.runtime.get().connection);
  const commands = kernel.commands.simulation;
  const selectObject = useCallback((id: string) => { setSelectedEdge(''); setSelected(id); setEventSequence(undefined); }, []);
  const seekEvent = (event: SimulationEvent) => {
    setPlaying(false);
    setTime(event.time);
    selectObject(event.nodeId || event.objectId);
    setEventSequence(event.sequence);
  };

  useEffect(() => {
    const presentation = view.canvas;
    if (!active || !index || !presentation || appliedPresentation.current === presentation.presentationId) return;
    const target = parseSimulationCanvasTarget(presentation.target);
    if (!target || target.time > index.availableTime) return;
    appliedPresentation.current = presentation.presentationId;
    setPlaying(false);
    setTime(target.time);
    selectObject(target.objectId || '');
    setEventSequence(target.eventSequence);
  }, [active, index, selectObject, view.canvas]);

  useEffect(() => {
    if (!active || !payload.experimentId) return;
    const controller = new AbortController();
    void commands.experiment(sessionId, payload.experimentId, controller.signal).then(value => { if (!controller.signal.aborted && value.experimentId === payload.experimentId) setExperiment(value); }).catch(cause => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => controller.abort();
  }, [active, sessionId, payload.experimentId, notice?.runUpdatedAt, connection, refresh, commands]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void commands.index(sessionId, runId, controller.signal).then((value) => {
      if (controller.signal.aborted || value.run.runId !== runId || value.index && value.index.runId !== runId) return;
      setRun(value.run); setError('');
      setIndex((previous) => previous && value.index && previous.revision > value.index.revision ? previous : value.index);
    }).catch((cause) => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => controller.abort();
  }, [active, sessionId, runId, notice?.canvas.viewId === `simulation:${runId}` ? notice.runUpdatedAt : '', connection, refresh, commands]);

  useEffect(() => {
    if (!active || geometry) return;
    const controller = new AbortController();
    void commands.geometry(sessionId, runId, controller.signal).then((value) => { if (!controller.signal.aborted) setGeometry(value); }).catch((cause) => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => controller.abort();
  }, [active, sessionId, runId, geometry, commands, refresh]);

  useEffect(() => {
    if (!active || !index?.chunks.length) return;
    const controller = new AbortController();
    const sequence = index.chunks.reduce((found, entry, i) => entry.from <= time ? i : found, -1);
    const apply = (block: SimulationBlock) => {
      if (controller.signal.aborted || block.runId !== runId || block.networkSha256 !== index.networkSha256 || block.sequence !== sequence) return;
      const next = [...block.frames].reverse().find((item) => item.time <= time) || block.start;
      if (next.time <= time) setLoaded({ time, frame: next, sampleSeconds: block.sampleSeconds });
    };
    const cached = cache.current.get(sequence);
    if (cached) apply(cached);
    else void commands.chunk(sessionId, runId, sequence, controller.signal).then(({ block }) => {
      if (controller.signal.aborted) return;
      cache.current.set(sequence, block);
      while (cache.current.size > 3) cache.current.delete(cache.current.keys().next().value!);
      apply(block);
    }).catch((cause) => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => controller.abort();
  }, [active, time, index, runId, sessionId, commands]);

  useEffect(() => {
    if (!active) return;
    contextCallback.current();
    if (!frame || loaded?.time !== time) return;
    const controller = new AbortController();
    void commands.query(sessionId, runId, time, selected || undefined, controller.signal, eventSequence).then((value) => {
      if (controller.signal.aborted || value.runId !== runId || value.time !== frame.time || value.requestedTime !== time) return;
      setQueryResult({ data: value, selected, eventSequence }); setError('');
      contextCallback.current({ time, ...(selected ? { objectId: selected } : {}), ...(eventSequence === undefined ? {} : { eventSequence }) });
    }).catch((cause) => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => controller.abort();
  }, [active, loaded, frame, selected, eventSequence, time, runId, sessionId, commands]);

  useEffect(() => {
    if (!playing || !active || !index) return;
    let animation = 0, last = performance.now(), cursor = time;
    const tick = (wall: number) => {
      cursor += (wall - last) / 1000 * speed; last = wall;
      const next = Math.min(index.availableTime, Math.floor(cursor / 2) * 2);
      setTime((previous) => previous === next ? previous : next);
      if (cursor >= index.availableTime) { setTime(index.availableTime); setPlaying(false); return; }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playing, active, speed, index]);

  useEffect(() => {
    if (!container.current || !geometry) return;
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
    map.on('error', (event) => setError(event.error?.message || '地图初始化失败'));
    const markers = mapMarkers.current;
    return () => {
      for (const marker of markers.values()) marker.remove();
      markers.clear();
      setMapReady(false); resize.disconnect(); theme.disconnect(); mapRef.current = null; resetBounds.current = null; map.remove();
    };
  }, [geometry, selectObject]);

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

  const available = index?.availableTime || 0, counts = frameQuery?.countsByState || {};
  const sample = roadSamples?.get(selectedEdge);
  const roadClass = geometry?.features.find(feature => feature.id === selectedEdge)?.properties.networkType;
  const railClasses = new Set(geometry?.features.map(feature => feature.properties.networkType));
  const sampleEdges = new Set([...(roadSamples?.keys() ?? []), ...(selectedEdge ? [selectedEdge] : [])]);
  const inView = mapBounds && frame ? Object.values(frame.vehicles).filter(vehicle => vehicle.positionGeo && mapBounds.contains(vehicle.positionGeo)).length : undefined;
  const people = currentFrame?.travelers ? Object.values(currentFrame.travelers) : undefined;
  const countPeople = (...states: string[]) => people?.filter(person => states.includes(person.state)).length;
  const kpis = [{ label: '在网', value: currentFrame ? Object.keys(currentFrame.vehicles).length : undefined, unit: '辆', definition: '当前帧在仿真网络中的车辆总数，含实体列车' }];
  if (rail) {
    kpis.push({ label: '地铁在途', value: currentFrame && mapFrame?.metroRiders, unit: '人', definition: '当前帧已由实体地铁承运、尚未到达终点的旅客' },
      { label: '待接续', value: countPeople('connecting'), unit: '人', definition: '当前帧等待接续的旅客' },
      { label: '累计未接续', value: frameQuery?.missedConnections, unit: '人', definition: '截至当前帧已记录接续失败事件的旅客，按人去重' });
  } else if (frame?.travelers || run?.metrics?.service) {
    kpis.push({ label: '候车', value: countPeople('waiting', 'connecting'), unit: '人', definition: '当前帧等候上车及等候接续的旅客' },
      { label: '累计完成全链', value: countPeople('completed'), unit: '人', definition: '截至当前帧完成全链出行的旅客' },
      { label: '累计未接续', value: frameQuery?.missedConnections, unit: '人', definition: '截至当前帧已记录接续失败事件的旅客，按人去重' });
  } else if (frame) {
    kpis.push({ label: '零速车辆', value: currentFrame && Object.values(currentFrame.vehicles).filter(vehicle => vehicle.speed === 0).length, unit: '辆', definition: '当前帧速度为零的在网车辆，包含计划停靠' },
      { label: '累计入网', value: frameQuery?.insertedVehicles, unit: '辆', definition: '截至当前帧已入网的不同车辆' });
  }
  const finalMetrics = index?.final && run?.termination === 'completed' ? run.metrics : undefined;
  const source = payload.sourceKind === 'synthetic' ? '合成示例' : payload.sourceKind;
  let drawerSummary = selectedEdge ? `路段 ${selectedEdge}` : selected || '全场景';
  if (query?.event) drawerSummary += ` · ${query.event.observedTime ?? query.event.time} s · ${query.event.type}`;
  else if (query?.node) drawerSummary += ` · 候车 ${query.node.waiting} · 待接续 ${query.node.connecting}${query.node.reservedBerths === undefined ? '' : ` · 预留泊位 ${query.node.reservedBerths}`}`;
  else if (query?.fleet) drawerSummary += ` · ${stateLabels[query.fleet.state] || query.fleet.state} · 载客 ${query.fleet.occupants.length}/${query.fleet.capacity ?? '—'}`;
  else if (query?.vehicle) drawerSummary += ` · ${query.vehicle.speed.toFixed(1)} m/s`;
  else if (query?.route) drawerSummary += ` · 在网 ${query.route.vehicles.length} 辆`;
  else if (query?.traveler) drawerSummary += ` · ${stateLabels[query.traveler.state] || query.traveler.state}`;
  else if (selectedEdge && sample) drawerSummary += ` · ${(3.6 * sample.totalMetersPerSecond / sample.vehicleIds.length).toFixed(1)} km/h`;
  return <section className="simulation-workspace" data-testid="simulation-workspace" data-run-id={runId} data-frame-time={frame?.time ?? ''}>
    <header className="simulation-overview">
      <dl className="simulation-kpis" aria-label="当前帧运行概览" aria-describedby={frameLabelId}>
        {kpis.map(({ label, value, unit, definition }) => <div key={label} title={definition}><dt>{label}</dt><dd>{value === undefined ? '—' : <>{value} <span>{unit}</span></>}</dd></div>)}
      </dl>
      <span className="simulation-provenance" title={`${source} · 未校准 · 不用于推断真实运营收益`}>{source} · 未校准</span>
    </header>
    <div className="simulation-map-stage">
      <div className="simulation-map" ref={container} aria-label="交通仿真地图" />
      <div className="simulation-map-tools">
        <details className="simulation-layer-control">
          <summary><Icon name="layers" />图层</summary>
          <div className="simulation-layer-options">
            <button type="button" aria-pressed={showRoads} onClick={() => setShowRoads(value => !value)}>仿真道路</button>
            <button type="button" aria-pressed={showRoutes} onClick={() => setShowRoutes(value => !value)}>线路</button>
            <button type="button" aria-pressed={showVehicles} onClick={() => setShowVehicles(value => !value)}>车辆</button>
            <button type="button" aria-pressed={showSpeeds} onClick={() => setShowSpeeds(value => !value)}>路段速度</button>
          </div>
        </details>
        <button type="button" aria-label="OpenStreetMap 底图" title="OpenStreetMap 底图" aria-pressed={showOsm} disabled={!mapReady}
          onClick={() => { setBasemapStatus(''); setShowOsm(value => !value); }}><Icon name="map" />底图</button>
      </div>
      {basemapStatus ? <p className="simulation-basemap-status" role="status">{basemapStatus}</p> : null}
      <div className="simulation-map-navigation" role="group" aria-label="地图视角">
        <button type="button" aria-label="放大地图" title="放大地图" disabled={!mapReady} onClick={() => mapRef.current?.zoomIn()}><Icon name="plus" /></button>
        <button type="button" aria-label="缩小地图" title="缩小地图" disabled={!mapReady} onClick={() => mapRef.current?.zoomOut()}><Icon name="minimize" /></button>
        <button type="button" aria-label="重置地图视角" title="重置地图视角" disabled={!mapReady} onClick={() => {
          if (mapRef.current && resetBounds.current) applySharedMapView(mapRef.current, { mode: 'bounds', bounds: resetBounds.current }, 0);
        }}><Icon name="restore" /></button>
      </div>
      <details className="simulation-map-legend">
        <summary>图例<Icon name="chevron" /></summary>
        <ul className="simulation-legend" aria-label="仿真地图图例">
          {showRoads ? <li><i className="simulation-legend-road" aria-hidden="true" />道路 · 线宽按等级</li> : null}
          {showRoutes ? <>
            {geometry && Object.keys(geometry.routes).some(id => id !== 'route:road' && id !== rail?.lineId) ? <li><i className="simulation-legend-route" aria-hidden="true" />道路服务线路</li> : null}
            {railClasses.has('railway.subway') ? <li><i className="simulation-legend-rail is-metro" aria-hidden="true" />地铁轨道</li> : null}
            {railClasses.has('railway.highspeed') ? <li><i className="simulation-legend-rail is-highspeed" aria-hidden="true" />高铁</li> : null}
            {railClasses.has('railway.conventional') ? <li><i className="simulation-legend-rail is-conventional" aria-hidden="true" />普铁</li> : null}
            {['railway.rail', 'railway.tram', 'railway.light_rail'].some(type => railClasses.has(type)) ? <li><i className="simulation-legend-rail" aria-hidden="true" />其他轨道</li> : null}
          </> : null}
          {showVehicles ? <>
            <li><i className="simulation-vehicle-icon simulation-vehicle-icon--car" aria-hidden="true" />小汽车 {mapFrame?.cars ?? '—'}</li>
            {people ? <>
              <li><i className="simulation-vehicle-icon simulation-vehicle-icon--ridehail" aria-hidden="true" />网约车 {mapFrame?.ridehail ?? '—'}</li>
              <li><i className="simulation-vehicle-icon simulation-vehicle-icon--bus" aria-hidden="true" />公交 {mapFrame?.buses ?? '—'} · 标注载客</li>
            </> : null}
            {rail ? <li><i className="simulation-vehicle-icon simulation-vehicle-icon--metro" aria-hidden="true" />实体地铁 · {mapFrame?.metroRiders ?? '—'} 人在途</li> : null}
          </> : null}
          {people ? <li><i className="simulation-legend-people" aria-hidden="true">人</i>节点旅客</li> : null}
          {!rail && people && (geometry?.routes['route:shuttle'] || geometry?.serviceRoutes?.some(route => route.mode === 'bus'))
            ? <li>地铁接续 · {mapFrame?.metroRiders ?? '—'} 人在途（无列车坐标）</li> : null}
          {showSpeeds ? <li><i className="simulation-legend-speed" aria-hidden="true" />{speedColorStops.join(' · ')} km/h · {roadSamples ? `${frame?.time} s 单帧有向路段均速，含停驶` : '位置帧待加载'} · 无色带为无样本</li> : null}
        </ul>
      </details>
    </div>
    <div className="simulation-playback">
      <div className="simulation-timeline">
        <button type="button" disabled={!frame} onClick={() => { setEventSequence(undefined); setPlaying((value) => !value); }}>{playing ? '暂停观看' : '播放'}</button>
        <input aria-label="仿真观看时刻" type="range" min={0} max={available} step={1} value={time} onChange={(event) => { setPlaying(false); setEventSequence(undefined); setTime(Number(event.target.value)); }} />
        <output>{frame ? time : '—'} / {available} s</output>
        <select aria-label="回放速度" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>{[1, 4, 16].map((value) => <option key={value} value={value}>{value}×</option>)}</select>
      </div>
      <div className="simulation-progress">
        <span>{run?.termination ? terminationLabels[run.termination] : run ? stateLabels[run.state] : '读取运行记录'}</span>
        <span>已计算 {run?.latestComputedTime ?? '—'} s</span>
        <span>已发布 {available} s</span>
        <span id={frameLabelId} className={currentFrame?.time === time ? 'sr-only' : undefined}>{currentFrame ? `位置帧 ${currentFrame.time} s` : '位置帧待加载'}</span>
        {loaded ? <span>轨迹采样 {loaded.sampleSeconds} s</span> : null}
        <span>{index?.final ? '输出覆盖完整' : index ? '部分输出' : '等待首个完整时间块'}</span>
      </div>
      {error || run?.error ? <div className="simulation-recovery">
        <p role="status" className="simulation-error" title={error || run?.error?.message}>{error || run?.error?.message}</p>
        <button type="button" onClick={() => setRefresh((value) => value + 1)}>重取索引</button>
      </div> : null}
    </div>
    <SimulationDetailsDrawer summary={drawerSummary}>
      {showSpeeds || selectedEdge ? <>
        <label>路段 <select aria-label="查询有向路段" value={selectedEdge} onChange={event => setSelectedEdge(event.target.value)}>
          <option value="">选择有样本的路段或点击地图</option>
          {[...sampleEdges].sort().map(id => <option key={id} value={id}>{id}</option>)}
        </select></label>
        {selectedEdge ? <p data-testid="simulation-road-detail">
          有向路段 {selectedEdge} · {roadClass || '等级未标注'} · {sample
            ? `${frame?.time} s · ${(3.6 * sample.totalMetersPerSecond / sample.vehicleIds.length).toFixed(1)} km/h · ${sample.vehicleIds.length} 辆 · ${sample.vehicleIds.join('、')}`
            : roadSamples ? `${frame?.time} s · 无观测样本` : '位置帧待加载'}
        </p> : null}
      </> : null}
      <label>对象 <select aria-label="仿真查询对象" value={selected} onChange={(event) => selectObject(event.target.value)}><option value="">全场景</option>{[...new Set([...geometry?.features.flatMap(item => item.properties.nodeId ? [item.id] : []) || [], ...Object.keys(geometry?.routes || {}), ...Object.keys(frame?.vehicles || {}), ...Object.keys(frame?.fleet || {}), ...Object.keys(frame?.travelers || {}), ...(selected ? [selected] : [])])].map(id => <option key={id} value={id}>{id}</option>)}</select></label>
      {relatedRoutes.length ? <div className="simulation-related" aria-label="线路与站点">
        {relatedRoutes.map(route => <div key={route.id}>
          <button type="button" onClick={() => selectObject(route.id)} aria-pressed={selected === route.id}>{route.mode === 'bus' ? '公交线路' : '网约车线路'} {route.id}</button>
          <button type="button" onClick={() => selectObject(route.origin)} aria-pressed={selected === route.origin}>上车点 {route.origin}</button>
          <button type="button" onClick={() => selectObject(route.target)} aria-pressed={selected === route.target}>换乘站 {route.target}</button>
        </div>)}
      </div> : null}
      {relatedRail ? <div className="simulation-related" aria-label="列车与线路"><div>
        <button type="button" onClick={() => selectObject(relatedRail.lineId)} aria-pressed={selected === relatedRail.lineId}>地铁线路 {relatedRail.lineId}</button>
        <button type="button" onClick={() => selectObject(relatedRail.trainId)} aria-pressed={selected === relatedRail.trainId}>列车 {relatedRail.trainId}</button>
        {activePlatform ? <button type="button" onClick={() => selectObject(activePlatform)} aria-pressed={selected === activePlatform}>停靠站台 {activePlatform}</button> : null}
      </div></div> : null}
      {selected === rail?.trainId && trainState ? <p>{trainState}</p> : null}
      {query?.vehicle ? <p>{query.vehicle.id} · {query.vehicle.edge} · {query.vehicle.speed.toFixed(2)} m/s{query.vehicle.lanePositionMeters === undefined ? '' : ` · 车道沿程 ${query.vehicle.lanePositionMeters.toFixed(2)} m`}</p> : null}
      {query?.fleet ? <p>车队 · {stateLabels[query.fleet.state] || query.fleet.state} · 当前载客 {query.fleet.occupants.length}/{query.fleet.capacity ?? '—'} · 已确认发车 {query.fleet.observedTrips ?? '—'} 趟 · 已确认返场 {query.fleet.turnarounds?.length ?? '—'} 次{query.fleet.route ? ` · ${query.fleet.route}` : ''}</p> : null}
      {query?.node ? <p>{query.node.id} · 候车 {query.node.waiting} · 等待接续 {query.node.connecting}{query.node.blocked === undefined ? '' : ` · 上游受阻 ${query.node.blocked} · 候车容量 ${query.node.waitingCapacity} · 预留泊位 ${query.node.reservedBerths}`}</p> : null}
      {query?.node?.metro?.length ? <ul aria-label="地铁接续班次">{query.node.metro.map(trip => <li key={trip.id}>{trip.id} · 计划 {trip.time} s · 容量 {trip.capacity} 人</li>)}</ul> : null}
      {query?.route ? <><p>{query.route.id} · 车辆 {query.route.vehicles.join(', ') || '无'}</p>
        <details><summary>有向路段（{query.route.edgeIds.length}）</summary><p>{query.route.edgeIds.join(' → ')}</p></details></> : null}
      {query?.route?.departures?.length ? <ul aria-label="线路计划班次">{query.route.departures.map(trip => <li key={trip.id}>{trip.id} · 计划 {trip.time} s · <button type="button" className="simulation-event-link" onClick={() => selectObject(trip.vehicle)}>{trip.vehicle}</button></li>)}</ul> : null}
      {query?.route?.countsByState ? <p>线路同刻人数 · {Object.entries(query.route.countsByState).map(([state, count]) => `${stateLabels[state] || state} ${count}`).join(' · ')}</p> : null}
      {query?.traveler ? <p>{query.traveler.id} · {stateLabels[query.traveler.state] || query.traveler.state} · {query.traveler.location || '尚未到达'}</p> : null}
      {query?.traveler?.waitSeconds === undefined ? null : <p>已发生等待 {query.traveler.waitSeconds} s · 含枢纽与接续候车、受阻及登乘，排除步行和在途</p>}
      {query?.event ? <p className="simulation-event-focus">事件 {query.event.time} s · 位置帧 {query.time} s · {query.event.type} · {query.event.objectId}{query.event.service ? ` · ${query.event.service}` : ''}{query.event.reason ? ` · ${query.event.reason}` : ''}{query.event.observedTime !== undefined && query.event.observedTime !== query.event.time ? ` · SUMO 实际 ${query.event.observedTime} s` : ''}</p> : null}
      <details onToggle={event => setEventsOpen(event.currentTarget.open)}>
        <summary>截至该时刻的事件（{query?.events.length || 0}{query?.truncated ? '，已截断' : ''}）</summary>
        <ol>{query?.events.map((event) => <li key={event.sequence}><button type="button" className="simulation-event-link" onClick={() => seekEvent(event)}>{event.time} s · {event.objectId} · {event.type}</button></li>)}</ol>
      </details>
      {!eventsOpen && query?.events.length ? <ul className="simulation-recent-events" aria-label="最近事件">
        {query.events.slice(-2).reverse().map(event => <li key={event.sequence}><button type="button" className="simulation-event-link" onClick={() => seekEvent(event)}>{event.time} s · {event.objectId} · {event.type}</button></li>)}
      </ul> : null}
      {rail && geometry?.startTime && geometry.serviceDate && geometry.durationSeconds ? <MetroTimetable plan={rail} startTime={geometry.startTime} serviceDate={geometry.serviceDate}
        duration={geometry.durationSeconds} scenarioId={payload.scenarioId} runId={runId} sessionId={sessionId} observed={query?.railEvents ?? []}
        selected={selected} onSelect={selectObject} onEvent={seekEvent} /> : null}
      <details className="simulation-scene-details">
        <summary>{currentFrame ? `全场景统计 · 位置帧 ${currentFrame.time} s` : '全场景统计 · 位置帧待加载'}</summary>
        <p>视野内有坐标 {(currentFrame && inView) ?? '—'} · 在网 {currentFrame ? Object.keys(currentFrame.vehicles).length : '—'} · 登记车队 {currentFrame?.fleet ? Object.keys(currentFrame.fleet).length : '—'} · 累计入网 {frameQuery?.insertedVehicles ?? '—'}</p>
        {Object.keys(counts).length ? <dl className="simulation-counts" aria-label="全场景同刻人数">{Object.entries(counts).map(([state, count]) => <div key={state}><dt>{rail && state === 'external' ? '接续在途' : stateLabels[state] || state}</dt><dd>{count}</dd></div>)}</dl> : null}
        {!error && !run?.error ? <button type="button" className="simulation-event-link" onClick={() => setRefresh(value => value + 1)}>重取索引</button> : null}
      </details>
      {finalMetrics ? <details className="simulation-scene-details">
        <summary>全程结果 · 0–{available} s</summary>
        <p>道路车辆入网 {finalMetrics.road.inserted} 辆 · 到达 {finalMetrics.road.arrived} 辆</p>
        {finalMetrics.service ? <p>完成全链 {finalMetrics.service.completedJourneys} 人 · 接续失败或错过末班 {finalMetrics.service.missedConnections} 人</p> : null}
      </details> : null}
    {experiment ? <details className="simulation-comparison" open data-testid="simulation-comparison">
      <summary>配对实验 · 完整 {experiment.comparison.completePairs}/{experiment.comparison.plannedPairs} · {experiment.comparison.conclusionAvailable ? '合成差值可读' : '含未完成样本，不作收益结论'}</summary>
      <p>变体减基线；枢纽候车均值含所有已到达者，未离站者截于末时刻。以下为终点比较，观看时刻仍以当前 Run 为准。</p>
      <table><thead><tr><th>种子</th><th>状态</th><th>全链完成差（人）</th><th>枢纽候车差（s）</th><th>道路损失差（s）</th></tr></thead><tbody>{experiment.comparison.pairs.map(pair => <tr key={pair.seed}><td>{pair.seed}</td><td>{pair.status === 'complete' ? '完整' : '未完成'}</td><td>{pair.delta?.completedJourneys ?? '—'}</td><td>{pair.delta?.meanHubWaitSeconds.toFixed(2) ?? '—'}</td><td>{pair.delta?.meanRoadTimeLossSeconds.toFixed(2) ?? '—'}</td></tr>)}</tbody></table>
      {experiment.comparison.pairs.some(pair => pair.delta?.meanAllWaitSeconds !== undefined) ? <><p>全程等待含接续候车，未完成者计入已发生时长；P90 为最近秩。车队占用含未返场截尾。</p><table><thead><tr><th>种子</th><th>全程等待均值差（s）</th><th>全程等待 P90 差（s）</th><th>错过末班差（人）</th><th>车队占用差（车秒）</th></tr></thead><tbody>{experiment.comparison.pairs.map(pair => <tr key={pair.seed}><td>{pair.seed}</td><td>{pair.delta?.meanAllWaitSeconds?.toFixed(2) ?? '—'}</td><td>{pair.delta?.p90AllWaitSeconds?.toFixed(2) ?? '—'}</td><td>{pair.delta?.lastServiceMisses ?? '—'}</td><td>{pair.delta?.fleetBusyVehicleSeconds ?? '—'}</td></tr>)}</tbody></table></> : null}
      <ul>{experiment.slots.map(slot => <li key={slot.slot}>{slot.role === 'baseline' ? '基线' : '变体'} · seed {slot.seed} · {slot.run ? `${slot.run.runId} · ${stateLabels[slot.run.state]} / ${slot.run.termination || '待确认'}` : '尚未派发'}</li>)}</ul>
      {experiment.artifact && onOpenDocument ? <button type="button" onClick={() => onOpenDocument({ sessionId, path: experiment.artifact!.reportPath, title: '合成交通实验比较' })}>打开冻结比较报告</button> : null}
    </details> : null}
    </SimulationDetailsDrawer>
  </section>;
}
