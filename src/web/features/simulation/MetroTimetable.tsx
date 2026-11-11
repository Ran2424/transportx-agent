import { useState } from 'react';
import type { PhysicalMetro, SimulationEvent } from '../../../contracts/simulation';
import { composerDraftStore } from '../../platform/conversation/composer-draft-store';

const day = 86400;
const seconds = (clock: string) => {
  const [hours, minutes, seconds = 0] = clock.split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
};
const clock = (value: number) => new Date((value % day) * 1000).toISOString().slice(11, 19);
const label = (start: number, value: number | undefined) => value === undefined ? '—' : `${start + value >= day ? '次日 ' : ''}${clock(start + value)}`;

export function MetroTimetable({ plan, startTime, serviceDate, duration, scenarioId, runId, sessionId, observed, selected, onSelect, onEvent }: {
  plan: PhysicalMetro; startTime: string; serviceDate: string; duration: number; scenarioId: string; runId: string; sessionId: string;
  observed: SimulationEvent[]; selected: string; onSelect(id: string): void; onEvent(event: SimulationEvent): void;
}) {
  const start = seconds(startTime);
  const [stopIndex, setStopIndex] = useState(plan.boardingStop);
  const [editedClock, setEditedClock] = useState('');
  const [notice, setNotice] = useState('');
  const stop = plan.stops[stopIndex];
  const departure = editedClock ? (seconds(editedClock) - start + day) % day : stop.departure;
  const latest = plan.stops[stopIndex + 1]?.arrival ?? duration;
  const valid = departure !== stop.departure && departure >= stop.arrival + stop.minDwell && departure <= latest;
  function prepare() {
    if (!valid) return;
    if (composerDraftStore.getMessage(sessionId).trim()) { setNotice('对话框已有草稿。发送或清空后再填入班表变更。'); return; }
    const base = `traffic-simulation/scenarios/${scenarioId}/scenario.json`;
    composerDraftStore.setMessage(sessionId, `请基于 Run ${runId} 的冻结场景 ${base} 新建班表变体。只把站台 ${stop.platformId} 的计划离站设为 ${label(start, departure)}（Asia/Shanghai，仿真秒 ${departure}）。保留原场景和其他约束；若是换乘站，同步 coordination.metro 中对应班次的计划离站。使用 traffic_prepare_scenario，parentScenarioId=${scenarioId}，interventions=["railTimetable"]。运行一次新变体并比较实际到发和接续。`);
    setNotice('班表变更已填入对话框。发送后由 Agent 提交新变体。');
  }
  return <details className="simulation-metro" open>
    <summary>实体地铁 · {plan.lineId} · {plan.serviceId}</summary>
    <p>{serviceDate} · Asia/Shanghai · <button type="button" className="simulation-event-link" onClick={() => onSelect(plan.trainId)}>{plan.trainId}</button></p>
    <table aria-label="实体地铁计划与实际到发">
      <thead><tr><th>站台</th><th>计划到 / 发</th><th>实际到 / 发</th><th>停站</th><th>离站偏差</th></tr></thead>
      <tbody>{plan.stops.map(item => {
        const arrived = observed.find(event => event.nodeId === item.platformId && event.type === 'metro_arrived');
        const departed = observed.find(event => event.nodeId === item.platformId && event.type === 'metro_departed');
        const dwell = arrived?.observedTime !== undefined && departed?.observedTime !== undefined ? departed.observedTime - arrived.observedTime : undefined;
        return <tr key={item.platformId}><td><button type="button" className="simulation-event-link" aria-pressed={selected === item.platformId} onClick={() => onSelect(item.platformId)}>{item.platformId}</button></td>
          <td>{label(start, item.arrival)} / {label(start, item.departure)}</td>
          <td>{[arrived, departed].map((event, i) => <span key={i}>{i ? ' / ' : ''}{event
            ? <button type="button" className="simulation-event-link" onClick={() => onEvent(event)}>{label(start, event.observedTime)}</button> : '—'}</span>)}</td>
          <td>{dwell === undefined ? `至少 ${item.minDwell} s` : `${dwell} s`}</td>
          <td>{departed?.observedTime === undefined ? '—' : `${departed.observedTime - item.departure} s`}</td>
        </tr>;
      })}</tbody>
    </table>
    <div className="simulation-metro-edit">
      <label>调整站台 <select value={stopIndex} onChange={event => { setStopIndex(Number(event.target.value)); setEditedClock(''); setNotice(''); }}>{plan.stops.map((item, i) => <option key={item.platformId} value={i}>{item.platformId}</option>)}</select></label>
      <label>计划离站 <input type="time" step={1} value={editedClock || clock(start + stop.departure)} onChange={event => { setEditedClock(event.target.value); setNotice(''); }} /></label>
      <button type="button" disabled={!valid} onClick={prepare}>填入班表变更</button>
    </div>
    {notice || editedClock && !valid ? <p role="status">{notice || (departure === stop.departure ? '计划离站时刻未改变。' : '请在最小停站结束后、下一站计划到站前选择离站时间。')}</p> : null}
  </details>;
}
