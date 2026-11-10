import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Map as MapLibreMap, GeoJSONSourceSpecification } from 'maplibre-gl';
import { createSharedMap, applySharedMapView, setSharedGeoJSON } from '../../../public/visualization/shared-map';
import type { SimulationCanvasPayload, SimulationRunSummary, SimulationIndex, SimulationFrame, SimulationGeometry, SimulationQuery, SimulationBlock } from '../../../contracts/simulation';
import type { CanvasRendererProps } from '../../platform/canvas/renderers/types';

const message = (error: unknown) => error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
const stateLabels: Record<string, string> = { prepared: '已受理', running: '计算中', finalizing: '确认中', ended: '已结束', unknown: '结果待确认', waiting: '候车', boarding: '登乘', riding: '车上', walking: '步行接续', connecting: '等待接续', external: '外部行程', completed: '完成全链', not_arrived: '尚未到达' };

export function SimulationWorkspace({ kernel, session, active, payload, onContextChange }: CanvasRendererProps & { payload: SimulationCanvasPayload }) {
  const runId = payload.runId, sessionId = session.id;
  const [run, setRun] = useState<SimulationRunSummary>();
  const [index, setIndex] = useState<SimulationIndex | null>(null);
  const [geometry, setGeometry] = useState<SimulationGeometry>();
  const [frame, setFrame] = useState<SimulationFrame>();
  const [query, setQuery] = useState<SimulationQuery>();
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(1);
  const [selected, setSelected] = useState(''), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [mapReady, setMapReady] = useState(false);
  const container = useRef<HTMLDivElement>(null), mapRef = useRef<MapLibreMap | null>(null);
  const cache = useRef(new Map<number, SimulationBlock>()), contextCallback = useRef(onContextChange);
  contextCallback.current = onContextChange;
  const subscribeSession = useCallback((changed: () => void) => kernel.stores.session.subscribe(changed), [kernel]);
  const notice = useSyncExternalStore(subscribeSession, () => kernel.stores.session.get().simulationBySession?.[sessionId]);
  const subscribeRuntime = useCallback((changed: () => void) => kernel.stores.runtime.subscribe(changed), [kernel]);
  const connection = useSyncExternalStore(subscribeRuntime, () => kernel.stores.runtime.get().connection);
  const commands = kernel.commands.simulation;

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
      setFrame(next);
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
    if (!active || !frame) return;
    const controller = new AbortController(); setQuery(undefined);
    contextCallback.current({ time: frame.time, ...(selected ? { objectId: selected } : {}) });
    void commands.query(sessionId, runId, frame.time, selected || undefined, controller.signal).then((value) => {
      if (controller.signal.aborted || value.runId !== runId || value.time !== frame.time) return;
      setQuery(value); setError('');
      contextCallback.current({ time: value.time, ...(selected ? { objectId: selected } : {}) });
    }).catch((cause) => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => controller.abort();
  }, [active, frame, selected, runId, sessionId, commands]);

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
    const coordinates = geometry.features.flatMap((feature) => feature.geometry.type === 'Point' ? [feature.geometry.coordinates] : feature.geometry.coordinates);
    const center = coordinates[0]; if (!center) return;
    const map = createSharedMap(container.current, { id: 'none' }, center, 15, color('--surface-canvas'));
    mapRef.current = map;
    const resize = new ResizeObserver(() => map.resize()); resize.observe(container.current);
    const paint = () => {
      map.setPaintProperty('background', 'background-color', color('--surface-canvas'));
      for (const [layer, property, token] of [['network', 'line-color', '--text-tertiary'], ['nodes', 'circle-color', '--status-info'], ['vehicles', 'circle-color', '--interactive-primary-bg']] as const) map.setPaintProperty(layer, property, color(token));
    };
    const theme = new MutationObserver(() => { if (map.isStyleLoaded()) paint(); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    map.once('load', () => {
      setSharedGeoJSON(map, 'network', geometry as GeoJSONSourceSpecification['data']);
      setSharedGeoJSON(map, 'vehicles', { type: 'FeatureCollection', features: [] });
      map.addLayer({ id: 'network', source: 'network', type: 'line', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-width': 5 } });
      map.addLayer({ id: 'nodes', source: 'network', type: 'circle', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 7 } });
      map.addLayer({ id: 'vehicles', source: 'vehicles', type: 'circle', paint: { 'circle-radius': ['case', ['==', ['get', 'id'], 'bus-0'], 7, 4] } });
      paint();
      const xs = coordinates.map((point) => point[0]), ys = coordinates.map((point) => point[1]);
      applySharedMapView(map, { mode: 'bounds', bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }, 0);
      map.on('click', (event) => {
        const picked = map.queryRenderedFeatures(event.point, { layers: ['vehicles', 'nodes'] })[0];
        if (picked) setSelected(String(picked.properties?.id || picked.properties?.nodeId));
      });
      setMapReady(true);
    });
    map.on('error', (event) => setError(event.error?.message || '地图初始化失败'));
    return () => { setMapReady(false); resize.disconnect(); theme.disconnect(); mapRef.current = null; map.remove(); };
  }, [geometry]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !frame || !active) return;
    setSharedGeoJSON(map, 'vehicles', { type: 'FeatureCollection', features: Object.entries(frame.vehicles).flatMap(([id, vehicle]) => vehicle.positionGeo ? [{ type: 'Feature' as const, id, properties: { id }, geometry: { type: 'Point' as const, coordinates: vehicle.positionGeo } }] : []) });
  }, [frame, mapReady, active]);
  useEffect(() => { if (active) mapRef.current?.resize(); }, [active]);

  const available = index?.availableTime || 0, counts = query?.countsByState || {};
  return <section className="simulation-workspace" data-testid="simulation-workspace" data-run-id={runId} data-frame-time={frame?.time ?? ''}>
    <div className="simulation-status"><span>{run ? stateLabels[run.state] : '读取运行记录'}{run?.termination ? ` · ${run.termination}` : ''}</span><button type="button" onClick={() => setRefresh((value) => value + 1)}>重取索引</button></div>
    <div className="simulation-provenance">{payload.sourceKind === 'synthetic' ? '合成示例' : payload.sourceKind} · 未校准 · 不用于推断真实虹桥收益</div>
    <div className="simulation-map" ref={container} aria-label="交通仿真地图" />
    <div className="simulation-timeline">
      <button type="button" disabled={!frame} onClick={() => setPlaying((value) => !value)}>{playing ? '暂停观看' : '播放'}</button>
      <input aria-label="仿真观看时刻" type="range" min={0} max={available} step={1} value={time} onChange={(event) => { setPlaying(false); setTime(Number(event.target.value)); }} />
      <output>{frame?.time ?? '—'} / {available} s</output>
      <select aria-label="回放速度" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>{[1, 4, 16].map((value) => <option key={value} value={value}>{value}×</option>)}</select>
    </div>
    <div className="simulation-coverage">已计算 {run?.latestComputedTime ?? '—'} s · 已发布 {available} s · 观看 {frame?.time ?? '—'} s · {index?.final ? '输出覆盖完整' : '部分输出'} · 轨迹采样 2 s</div>
    <div className="simulation-details">
      <label>对象 <select aria-label="仿真查询对象" value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">全场景</option>{geometry?.features.filter((item) => item.properties.nodeId).map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}{Object.keys(geometry?.routes || {}).map((id) => <option key={id} value={id}>{id}</option>)}{Object.keys(frame?.vehicles || {}).map((id) => <option key={id} value={id}>{id}</option>)}{Object.keys(frame?.travelers || {}).map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
      <dl className="simulation-counts">{Object.entries(counts).map(([state, count]) => <div key={state}><dt>{stateLabels[state] || state}</dt><dd>{count}</dd></div>)}</dl>
      {query?.vehicle ? <p>{query.vehicle.id} · {query.vehicle.edge} · {query.vehicle.speed.toFixed(2)} m/s{query.vehicle.lanePositionMeters === undefined ? '' : ` · 车道沿程 ${query.vehicle.lanePositionMeters.toFixed(2)} m`}</p> : null}
      {query?.node ? <p>{query.node.id} · 候车 {query.node.waiting} · 等待接续 {query.node.connecting}</p> : null}
      {query?.route ? <p>{query.route.id} · 车辆 {query.route.vehicles.join(', ') || '无'} · {query.route.edgeIds.join(' → ')}</p> : null}
      {query?.traveler ? <p>{query.traveler.id} · {stateLabels[query.traveler.state] || query.traveler.state} · {query.traveler.location || '尚未到达'}</p> : null}
      <details><summary>截至该时刻的事件（{query?.events.length || 0}{query?.truncated ? '，已截断' : ''}）</summary><ol>{query?.events.map((event) => <li key={event.sequence}>{event.time} s · {event.objectId} · {event.type}</li>)}</ol></details>
    </div>
    {!index ? <p className="simulation-coverage">等待首个完整时间块。隐藏视图或暂停观看不会停止计算。</p> : null}
    {error || run?.error ? <p role="status" className="simulation-error">{error || run?.error?.message}</p> : null}
  </section>;
}
