import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Marker, type Map as MapLibreMap, type GeoJSONSourceSpecification } from 'maplibre-gl';
import { createSharedMap, applySharedMapView, setSharedGeoJSON } from '../../../public/visualization/shared-map';
import type { SimulationCanvasPayload, SimulationRunSummary, SimulationIndex, SimulationFrame, SimulationGeometry, SimulationQuery, SimulationBlock, SimulationExperiment } from '../../../contracts/simulation';
import type { CanvasRendererProps } from '../../platform/canvas/renderers/types';
import { projectMapFrame } from './map-frame';

const message = (error: unknown) => error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
const stateLabels: Record<string, string> = { prepared: '已受理', running: '计算中', finalizing: '确认中', ended: '已结束', unknown: '结果待确认', waiting: '候车', blocked: '上游受阻', boarding: '登乘', riding: '车上', walking: '步行接续', connecting: '等待接续', external: '外部行程', completed: '完成全链', not_arrived: '尚未到达', inserting: '等待入网', available: '可用', commanded: '发车待确认', outbound: '去程', return_commanded: '返场待确认', returning: '返场' };

export function SimulationWorkspace({ kernel, session, active, payload, onContextChange, onOpenDocument }: CanvasRendererProps & { payload: SimulationCanvasPayload }) {
  const runId = payload.runId, sessionId = session.id;
  const [run, setRun] = useState<SimulationRunSummary>();
  const [index, setIndex] = useState<SimulationIndex | null>(null);
  const [geometry, setGeometry] = useState<SimulationGeometry>();
  const [frame, setFrame] = useState<SimulationFrame>();
  const [query, setQuery] = useState<SimulationQuery>();
  const [experiment, setExperiment] = useState<SimulationExperiment>();
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(1);
  const [selected, setSelected] = useState(''), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  const [mapReady, setMapReady] = useState(false);
  const container = useRef<HTMLDivElement>(null), mapRef = useRef<MapLibreMap | null>(null);
  const mapMarkers = useRef(new Map<string, Marker>());
  const mapFrame = useMemo(() => frame && geometry && projectMapFrame(frame, geometry), [frame, geometry]);
  const cache = useRef(new Map<number, SimulationBlock>()), contextCallback = useRef(onContextChange);
  contextCallback.current = onContextChange;
  const subscribeSession = useCallback((changed: () => void) => kernel.stores.session.subscribe(changed), [kernel]);
  const notice = useSyncExternalStore(subscribeSession, () => kernel.stores.session.get().simulationBySession?.[sessionId]);
  const subscribeRuntime = useCallback((changed: () => void) => kernel.stores.runtime.subscribe(changed), [kernel]);
  const connection = useSyncExternalStore(subscribeRuntime, () => kernel.stores.runtime.get().connection);
  const commands = kernel.commands.simulation;

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
    const routeEdges = new Set(Object.values(geometry.routes).flat());
    const corridor = geometry.features.filter(({ properties }) => properties.nodeId || properties.edgeId && routeEdges.has(properties.edgeId));
    const coordinates = (corridor.length ? corridor : geometry.features).flatMap((feature) => feature.geometry.type === 'Point' ? [feature.geometry.coordinates] : feature.geometry.coordinates);
    const center = coordinates[0]; if (!center) return;
    const map = createSharedMap(container.current, { id: 'none' }, center, 15, color('--surface-canvas'));
    mapRef.current = map;
    const resize = new ResizeObserver(() => map.resize()); resize.observe(container.current);
    const paint = () => {
      map.setPaintProperty('background', 'background-color', color('--surface-canvas'));
      map.setPaintProperty('network', 'line-color', color('--text-tertiary'));
      map.setPaintProperty('nodes', 'circle-color', color('--surface-raised'));
      map.setPaintProperty('nodes', 'circle-stroke-color', color('--text-secondary'));
      map.setPaintProperty('vehicles', 'circle-color', ['case', ['boolean', ['get', 'car'], false], color('--interactive-primary-bg'), color('--text-secondary')]);
      map.setPaintProperty('vehicles', 'circle-stroke-color', color('--surface-canvas'));
    };
    const theme = new MutationObserver(() => { if (map.getLayer('vehicles')) paint(); });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    map.once('load', () => {
      setSharedGeoJSON(map, 'network', geometry as GeoJSONSourceSpecification['data']);
      setSharedGeoJSON(map, 'vehicles', { type: 'FeatureCollection', features: [] });
      map.addLayer({ id: 'network', source: 'network', type: 'line', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-width': 2 } });
      map.addLayer({ id: 'nodes', source: 'network', type: 'circle', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4, 'circle-stroke-width': 2 } });
      map.addLayer({ id: 'vehicles', source: 'vehicles', type: 'circle', paint: { 'circle-radius': 5, 'circle-stroke-width': 1 } });
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
    const markers = mapMarkers.current;
    return () => {
      for (const marker of markers.values()) marker.remove();
      markers.clear();
      setMapReady(false); resize.disconnect(); theme.disconnect(); mapRef.current = null; map.remove();
    };
  }, [geometry]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !mapFrame || !active) return;
    setSharedGeoJSON(map, 'vehicles', mapFrame.vehicles);
    const markers = mapMarkers.current;
    const visible = new Set(mapFrame.markers.map(({ kind, id }) => `${kind}:${id}`));
    for (const [key, marker] of markers) {
      if (visible.has(key)) continue;
      marker.remove(); markers.delete(key);
    }
    for (const { id, kind, position, count } of mapFrame.markers) {
      const key = `${kind}:${id}`;
      let marker = markers.get(key);
      if (!marker) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `simulation-marker simulation-marker--${kind}`;
        button.addEventListener('click', event => { event.stopPropagation(); setSelected(id); });
        marker = new Marker({ element: button, offset: kind === 'people' ? [0, -17] : [0, 0] }).setLngLat(position).addTo(map);
        markers.set(key, marker);
      } else marker.setLngLat(position);
      const button = marker.getElement();
      const label = kind === 'bus' ? `公交 ${id} · 载客 ${count} 人` : `${id} · 节点旅客 ${count} 人`;
      if (button.title !== label) {
        button.textContent = kind === 'bus' ? `公交 · ${count} 人` : `人 ${count}`;
        button.title = label;
        button.setAttribute('aria-label', label);
      }
    }
  }, [mapFrame, mapReady, active]);
  useEffect(() => { if (active) mapRef.current?.resize(); }, [active]);

  const available = index?.availableTime || 0, counts = query?.countsByState || {};
  return <section className="simulation-workspace" data-testid="simulation-workspace" data-run-id={runId} data-frame-time={frame?.time ?? ''}>
    <div className="simulation-status"><span>{run ? stateLabels[run.state] : '读取运行记录'}{run?.termination ? ` · ${run.termination}` : ''}</span><button type="button" onClick={() => setRefresh((value) => value + 1)}>重取索引</button></div>
    <div className="simulation-provenance">{payload.sourceKind === 'synthetic' ? '合成示例' : payload.sourceKind} · 未校准 · 不用于推断真实运营收益</div>
    <div className="simulation-map" ref={container} aria-label="交通仿真地图" />
    <ul className="simulation-legend" aria-label="仿真地图图例">
      <li><i className="simulation-legend-car" aria-hidden="true" />小汽车 {mapFrame?.cars ?? '—'}</li>
      <li><i className="simulation-legend-bus" aria-hidden="true" />公交 {mapFrame?.buses ?? '—'} · 标注载客</li>
      <li><i className="simulation-legend-people" aria-hidden="true">人</i>节点旅客</li>
      <li>地铁接续{frame?.travelers && mapFrame ? ` · ${mapFrame.metroRiders} 人在途` : ''}（无列车坐标）</li>
    </ul>
    <div className="simulation-timeline">
      <button type="button" disabled={!frame} onClick={() => setPlaying((value) => !value)}>{playing ? '暂停观看' : '播放'}</button>
      <input aria-label="仿真观看时刻" type="range" min={0} max={available} step={1} value={time} onChange={(event) => { setPlaying(false); setTime(Number(event.target.value)); }} />
      <output>{frame?.time ?? '—'} / {available} s</output>
      <select aria-label="回放速度" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>{[1, 4, 16].map((value) => <option key={value} value={value}>{value}×</option>)}</select>
    </div>
    <div className="simulation-coverage">已计算 {run?.latestComputedTime ?? '—'} s · 已发布 {available} s · 观看 {frame?.time ?? '—'} s · {index?.final ? '输出覆盖完整' : '部分输出'} · 轨迹采样 2 s</div>
    <div className="simulation-details">
      <label>对象 <select aria-label="仿真查询对象" value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">全场景</option>{geometry?.features.filter((item) => item.properties.nodeId).map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}{Object.keys(geometry?.routes || {}).map((id) => <option key={id} value={id}>{id}</option>)}{[...new Set([...Object.keys(frame?.vehicles || {}), ...Object.keys(frame?.fleet || {})])].map((id) => <option key={id} value={id}>{id}</option>)}{Object.keys(frame?.travelers || {}).map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
      <p>全场景同刻人数</p><dl className="simulation-counts">{Object.entries(counts).map(([state, count]) => <div key={state}><dt>{stateLabels[state] || state}</dt><dd>{count}</dd></div>)}</dl>
      {query?.vehicle ? <p>{query.vehicle.id} · {query.vehicle.edge} · {query.vehicle.speed.toFixed(2)} m/s{query.vehicle.lanePositionMeters === undefined ? '' : ` · 车道沿程 ${query.vehicle.lanePositionMeters.toFixed(2)} m`}</p> : null}
      {query?.fleet ? <p>车队 · {stateLabels[query.fleet.state] || query.fleet.state} · 当前载客 {query.fleet.occupants.length}/{query.fleet.capacity ?? '—'} · 已确认发车 {query.fleet.observedTrips ?? '—'} 趟 · 已确认返场 {query.fleet.turnarounds?.length ?? '—'} 次{query.fleet.route ? ` · ${query.fleet.route}` : ''}</p> : null}
      {query?.node ? <p>{query.node.id} · 候车 {query.node.waiting} · 等待接续 {query.node.connecting}{query.node.blocked === undefined ? '' : ` · 上游受阻 ${query.node.blocked} · 候车容量 ${query.node.waitingCapacity} · 预留泊位 ${query.node.reservedBerths}`}</p> : null}
      {query?.route ? <p>{query.route.id} · 车辆 {query.route.vehicles.join(', ') || '无'} · {query.route.edgeIds.join(' → ')}</p> : null}
      {query?.route?.countsByState ? <p>线路同刻人数 · {Object.entries(query.route.countsByState).map(([state, count]) => `${stateLabels[state] || state} ${count}`).join(' · ')}</p> : null}
      {query?.traveler ? <p>{query.traveler.id} · {stateLabels[query.traveler.state] || query.traveler.state} · {query.traveler.location || '尚未到达'}</p> : null}
      {query?.traveler?.waitSeconds === undefined ? null : <p>已发生等待 {query.traveler.waitSeconds} s · 含枢纽与接续候车、受阻及登乘，排除步行和在途</p>}
      <details><summary>截至该时刻的事件（{query?.events.length || 0}{query?.truncated ? '，已截断' : ''}）</summary><ol>{query?.events.map((event) => <li key={event.sequence}>{event.time} s · {event.objectId} · {event.type}</li>)}</ol></details>
    </div>
    {experiment ? <details className="simulation-comparison" open data-testid="simulation-comparison">
      <summary>配对实验 · 完整 {experiment.comparison.completePairs}/{experiment.comparison.plannedPairs} · {experiment.comparison.conclusionAvailable ? '合成差值可读' : '含未完成样本，不作收益结论'}</summary>
      <p>变体减基线；枢纽候车均值含所有已到达者，未离站者截于末时刻。以下为终点比较，观看时刻仍以当前 Run 为准。</p>
      <table><thead><tr><th>种子</th><th>状态</th><th>全链完成差（人）</th><th>枢纽候车差（s）</th><th>道路损失差（s）</th></tr></thead><tbody>{experiment.comparison.pairs.map(pair => <tr key={pair.seed}><td>{pair.seed}</td><td>{pair.status === 'complete' ? '完整' : '未完成'}</td><td>{pair.delta?.completedJourneys ?? '—'}</td><td>{pair.delta?.meanHubWaitSeconds.toFixed(2) ?? '—'}</td><td>{pair.delta?.meanRoadTimeLossSeconds.toFixed(2) ?? '—'}</td></tr>)}</tbody></table>
      {experiment.comparison.pairs.some(pair => pair.delta?.meanAllWaitSeconds !== undefined) ? <><p>全程等待含接续候车，未完成者计入已发生时长；P90 为最近秩。车队占用含未返场截尾。</p><table><thead><tr><th>种子</th><th>全程等待均值差（s）</th><th>全程等待 P90 差（s）</th><th>错过末班差（人）</th><th>车队占用差（车秒）</th></tr></thead><tbody>{experiment.comparison.pairs.map(pair => <tr key={pair.seed}><td>{pair.seed}</td><td>{pair.delta?.meanAllWaitSeconds?.toFixed(2) ?? '—'}</td><td>{pair.delta?.p90AllWaitSeconds?.toFixed(2) ?? '—'}</td><td>{pair.delta?.lastServiceMisses ?? '—'}</td><td>{pair.delta?.fleetBusyVehicleSeconds ?? '—'}</td></tr>)}</tbody></table></> : null}
      <ul>{experiment.slots.map(slot => <li key={slot.slot}>{slot.role === 'baseline' ? '基线' : '变体'} · seed {slot.seed} · {slot.run ? `${slot.run.runId} · ${stateLabels[slot.run.state]} / ${slot.run.termination || '待确认'}` : '尚未派发'}</li>)}</ul>
      {experiment.artifact && onOpenDocument ? <button type="button" onClick={() => onOpenDocument({ sessionId, path: experiment.artifact!.reportPath, title: '合成交通实验比较' })}>打开冻结比较报告</button> : null}
    </details> : null}
    {!index ? <p className="simulation-coverage">等待首个完整时间块。隐藏视图或暂停观看不会停止计算。</p> : null}
    {error || run?.error ? <p role="status" className="simulation-error">{error || run?.error?.message}</p> : null}
  </section>;
}
