import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { LiveSession } from '../../../public/app-types.js';
import type { GeoSceneSnapshot, VisualizationEnvelope } from '../../../contracts/geo.js';
import { useConversationState, useToolExecutionState } from '../../app/store-hooks';
import { FeatureEmpty } from '../task/TaskBoard';
import { projectVisualizations } from './geo-projection';

type GeoRuntime = { replace(scene: GeoSceneSnapshot, sessionId: string | null): Promise<void>; setLayerVisibility(layerId: string, visible: boolean): void; resize(): void; destroy(): void };
type RuntimeModule = { createGeoMapRuntime(container: HTMLElement, onError: (message: string) => void): GeoRuntime };

export function GeoWorkspace({ session, active }: { session: LiveSession | null; active: boolean }) {
  const conversation = useConversationState();
  const tools = useToolExecutionState();
  const items = useMemo(() => session ? projectVisualizations(conversation.bySession[session.id]?.snapshotEntries ?? [], Object.values(tools.bySession[session.id] ?? {})) : [], [conversation, session, tools]);
  const [selectedId, setSelectedId] = useState('');
  const runtime = useRef<GeoRuntime | null>(null);
  const selected = items.find((item) => item.visualizationId === selectedId) ?? items[0] ?? null;
  useEffect(() => { if (selected && selected.visualizationId !== selectedId) setSelectedId(selected.visualizationId); }, [selected, selectedId]);
  if (!session) return <FeatureEmpty mark="04" title="等待任务上下文" description="选择任务后，GIS 结果会按会话显示。" />;
  if (!selected?.scene) return <FeatureEmpty mark="04" title="当前任务还没有地图" description="Agent 发布 GIS 可视化后，地图和图层控制会在这里出现。" />;
  return <div className="geo-workspace"><div className="geo-toolbar"><select aria-label="选择地图" value={selected.visualizationId} onChange={(event) => setSelectedId(event.target.value)}>{items.map((item) => <option key={item.visualizationId} value={item.visualizationId}>{item.summary.title}</option>)}</select><small>revision {selected.revision} · {selected.scene.layers.length} 个图层</small></div><GeoMap envelope={selected} sessionId={session.id} active={active} runtime={runtime} /><div className="geo-layers">{[...selected.scene.layers].reverse().map((layer) => <GeoLayer key={layer.id} layer={layer} onVisibility={(visible) => runtime.current?.setLayerVisibility(layer.id, visible)} />)}</div>{selected.scene.metadata.description ? <p className="geo-description">{selected.scene.metadata.description}</p> : null}</div>;
}

function GeoMap({ envelope, sessionId, active, runtime }: { envelope: VisualizationEnvelope; sessionId: string; active: boolean; runtime: RefObject<GeoRuntime | null> }) {
  const container = useRef<HTMLDivElement>(null); const [error, setError] = useState('');
  useEffect(() => { if (!active || !container.current || !envelope.scene) return; let disposed = false; void import('../../../public/visualization/geo/geo-runtime-entry.js').then((module: RuntimeModule) => { if (disposed || !container.current) return; runtime.current ??= module.createGeoMapRuntime(container.current, setError); return runtime.current.replace(envelope.scene!, sessionId); }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); return () => { disposed = true; }; }, [active, envelope, sessionId]);
  useEffect(() => () => runtime.current?.destroy(), []);
  useEffect(() => { if (active) requestAnimationFrame(() => runtime.current?.resize()); }, [active]);
  return <><div ref={container} className="geo-map" aria-label="GIS 地图" />{error ? <p className="geo-error">地图加载失败：{error}</p> : null}</>;
}
function GeoLayer({ layer, onVisibility }: { layer: NonNullable<VisualizationEnvelope['scene']>['layers'][number]; onVisibility(visible: boolean): void }) { const [visible, setVisible] = useState(layer.visible !== false); return <label className={!visible ? 'is-muted' : ''}><input type="checkbox" checked={visible} onChange={(event) => { setVisible(event.target.checked); onVisibility(event.target.checked); }} /><span>{layer.title || layer.id}</span><small>{layer.type}</small></label>; }
