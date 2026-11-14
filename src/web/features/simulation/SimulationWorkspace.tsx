import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { parseSimulationCanvasTarget, type SimulationCanvasPayload, type SimulationEvent } from '../../../contracts/simulation';
import type { CanvasRendererProps } from '../../platform/canvas/renderers/types';
import { Icon } from '../../components/icons';
import { projectMapFrame, roadSpeedSamples } from './map-frame';
import { MetroTimetable } from './MetroTimetable';
import { SimulationDetailsDrawer } from './SimulationDetailsDrawer';

import { useSimulationResources, simulationResourceLabels } from './useSimulationResources';
import { speedColorStops, useSimulationMap } from './useSimulationMap';
import { useSimulationPlayback } from './useSimulationPlayback';
const stateLabels: Record<string, string> = { prepared: '已受理', running: '计算中', finalizing: '确认中', ended: '已结束', unknown: '结果待确认', waiting: '候车', blocked: '上游受阻', boarding: '登乘', riding: '车上', walking: '步行接续', connecting: '等待接续', external: '外部行程', completed: '完成全链', not_arrived: '尚未到达', inserting: '等待入网', available: '可用', commanded: '发车待确认', outbound: '去程', return_commanded: '返场待确认', returning: '返场' };
const terminationLabels = { completed: '已完成', cancelled: '已取消', failed: '运行失败' };

export function SimulationWorkspace({ kernel, session, view, active, payload, onContextChange, onOpenDocument }: CanvasRendererProps & { payload: SimulationCanvasPayload }) {
  const runId = payload.runId, sessionId = session.id;
  const frameLabelId = useId();
  const [selected, setSelected] = useState('');
  const [time, setTime] = useState(0), [playing, setPlaying] = useState(false), [speed, setSpeed] = useState(1);
  const [eventSequence, setEventSequence] = useState<number>();
  const [eventsOpen, setEventsOpen] = useState(false);
  const appliedPresentation = useRef('');
  const [selectedEdge, setSelectedEdge] = useState('');
  const { run, index, geometry, loaded, frame, currentFrame, frameQuery, query, experiment, errors, pending, retry } = useSimulationResources({
    kernel, sessionId, runId, experimentId: payload.experimentId, active, time, selected, eventSequence, onContextChange,
  });
  useSimulationPlayback(active, playing, speed, time, index?.availableTime, setTime, setPlaying);
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

  const { container, mapBounds, mapReady, showRoads, setShowRoads, showRoutes, setShowRoutes, showVehicles, setShowVehicles, showSpeeds, setShowSpeeds, showOsm, setShowOsm, basemapStatus, mapError, resetView, retryMap, zoomIn, zoomOut, setBasemapStatus } = useSimulationMap({
    active, geometry, mapFrame, currentFrame, relatedRoutes, relatedRail, selectedRailEdge, activePlatform, train, trainState, roadSamples, selected, eventSequence, query, selectObject, setSelectedEdge,
  });
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
        <button type="button" aria-label="放大地图" title="放大地图" disabled={!mapReady} onClick={zoomIn}><Icon name="plus" /></button>
        <button type="button" aria-label="缩小地图" title="缩小地图" disabled={!mapReady} onClick={zoomOut}><Icon name="minimize" /></button>
        <button type="button" aria-label="重置地图视角" title="重置地图视角" disabled={!mapReady} onClick={resetView}><Icon name="restore" /></button>
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
      <div className="simulation-progress" aria-busy={pending.index || pending.chunk}>
        <span>{run?.termination ? terminationLabels[run.termination] : run ? stateLabels[run.state] : errors.index ? '运行索引读取失败' : '读取运行记录'}</span>
        <span>已计算 {run?.latestComputedTime ?? '—'} s</span>
        <span>已发布 {available} s</span>
        <span id={frameLabelId} className={currentFrame?.time === time ? 'sr-only' : undefined}>{currentFrame ? `位置帧 ${currentFrame.time} s` : '位置帧待加载'}</span>
        {loaded ? <span>轨迹采样 {loaded.sampleSeconds} s</span> : null}
        <span>{index?.final ? '输出覆盖完整' : index ? '部分输出' : '等待首个完整时间块'}</span>
      </div>
      {Object.entries(errors).map(([resource, error]) => {
        const kind = resource as keyof typeof simulationResourceLabels;
        return error ? <div className="simulation-recovery" key={kind}>
          <p role="status" className="simulation-error" title={error}>{simulationResourceLabels[kind]} · {error}</p>
          <button type="button" disabled={pending[kind]} onClick={() => retry(kind)}>{pending[kind] ? '正在重试' : '重试'}{simulationResourceLabels[kind]}</button>
        </div> : null;
      })}
      {mapError ? <div className="simulation-recovery"><p role="status" className="simulation-error">{mapError}</p><button type="button" onClick={retryMap}>重试地图</button></div> : null}
      {run?.error ? <p role="status" className="simulation-error">{run.error.message}</p> : null}
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
        {!errors.index && !run?.error ? <button type="button" className="simulation-event-link" onClick={() => retry('index')}>重取索引</button> : null}
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
