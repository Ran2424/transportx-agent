import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { LiveSession } from '../../../public/app-types.js';
import type { VisualizationEnvelope } from '../../../contracts/geo.js';
import { useConversationState, useToolExecutionState } from '../../app/store-hooks';
import { FeatureEmpty } from '../task/TaskBoard';
import { projectVisualizations } from './geo-projection';

type GeoRuntime = {
  apply(envelope: VisualizationEnvelope, sessionId: string | null): Promise<void>;
  setLayerVisibility(layerId: string, visible: boolean): void;
  fitToScene(): void;
  resize(): void;
  destroy(): void;
};
type RuntimeModule = { createGeoMapRuntime(container: HTMLElement, onError: (message: string) => void): GeoRuntime };

export function GeoWorkspace({ session, active }: { session: LiveSession | null; active: boolean }) {
  const conversation = useConversationState();
  const tools = useToolExecutionState();
  const entries = session ? conversation.bySession[session.id]?.snapshotEntries : undefined;
  const executions = session ? tools.bySession[session.id] : undefined;
  const items = useMemo(
    () => projectVisualizations(entries ?? [], Object.values(executions ?? {})),
    [entries, executions],
  );
  const [selectedId, setSelectedId] = useState('');
  const runtime = useRef<GeoRuntime | null>(null);
  const selected = items.find((item) => item.visualizationId === selectedId) ?? items[0] ?? null;
  useEffect(() => {
    if (selected && selected.visualizationId !== selectedId) setSelectedId(selected.visualizationId);
  }, [selected, selectedId]);

  if (!session) return <FeatureEmpty mark="04" title="等待任务上下文" description="选择任务后，GIS 结果会按会话显示。" />;
  if (!selected?.scene) return <FeatureEmpty mark="04" title="当前任务还没有地图" description="Agent 发布 GIS 可视化后，地图和图层控制会在这里出现。" />;

  return (
    <div className="geo-workspace">
      <div className="geo-toolbar">
        <select aria-label="选择地图" value={selected.visualizationId} onChange={(event) => setSelectedId(event.target.value)}>
          {items.map((item) => <option key={item.visualizationId} value={item.visualizationId}>{item.summary.title}</option>)}
        </select>
        {selected.scene.controls?.fitToData !== false
          ? <button type="button" onClick={() => runtime.current?.fitToScene()}>回到范围</button>
          : null}
        <small>revision {selected.revision} · {selected.scene.layers.length} 个图层</small>
      </div>
      <GeoMap
        key={`${session.id}:${selected.visualizationId}`}
        envelope={selected}
        sessionId={session.id}
        active={active}
        runtime={runtime}
      />
      <div className="geo-layers" role="group" aria-label="地图图层" tabIndex={0}>
        {[...selected.scene.layers].reverse().map((layer) => (
          <GeoLayer
            key={`${selected.visualizationId}:${layer.id}`}
            layer={layer}
            onVisibility={(visible) => runtime.current?.setLayerVisibility(layer.id, visible)}
          />
        ))}
      </div>
      {selected.scene.metadata.description
        ? <p className="geo-description" role="region" aria-label="地图说明" tabIndex={0}>{selected.scene.metadata.description}</p>
        : null}
    </div>
  );
}

function GeoMap({
  envelope,
  sessionId,
  active,
  runtime,
}: {
  envelope: VisualizationEnvelope;
  sessionId: string;
  active: boolean;
  runtime: RefObject<GeoRuntime | null>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const latestEnvelope = useRef(envelope);
  const [error, setError] = useState('');
  const runtimeKey = `${sessionId}:${envelope.visualizationId}`;
  latestEnvelope.current = envelope;
  const resize = () => requestAnimationFrame(() => {
    runtime.current?.resize();
    requestAnimationFrame(() => runtime.current?.resize());
  });

  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!active || !container.current) return;
    let disposed = false;
    let currentRuntime: GeoRuntime | null = null;
    setError('');
    void import('../../../public/visualization/geo/geo-runtime-entry.js')
      .then(async (module: RuntimeModule) => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (disposed || !container.current) return;
        currentRuntime = module.createGeoMapRuntime(container.current, setError);
        runtime.current = currentRuntime;
        await currentRuntime.apply(latestEnvelope.current, sessionId);
        if (!disposed && runtime.current === currentRuntime) resize();
      })
      .catch((cause) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
      currentRuntime?.destroy();
      if (runtime.current === currentRuntime) runtime.current = null;
    };
  }, [active, runtimeKey, sessionId]);

  useEffect(() => {
    if (!active || !runtime.current) return;
    setError('');
    void runtime.current.apply(envelope, sessionId).then(resize).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [active, envelope, sessionId]);

  useEffect(() => {
    if (!active) return;
    resize();
    const timer = window.setTimeout(resize, 260);
    return () => window.clearTimeout(timer);
  }, [active, runtimeKey]);

  return (
    <>
      <div ref={container} className="geo-map" aria-label="GIS 地图" />
      {error ? <p className="geo-error">地图加载失败：{error}</p> : null}
    </>
  );
}

function GeoLayer({
  layer,
  onVisibility,
}: {
  layer: NonNullable<VisualizationEnvelope['scene']>['layers'][number];
  onVisibility(visible: boolean): void;
}) {
  const [visibilityOverride, setVisibilityOverride] = useState<boolean | null>(null);
  const visible = visibilityOverride ?? layer.visible !== false;
  const title = layer.title || layer.id;
  return (
    <label className={!visible ? 'is-muted' : ''}>
      <input
        type="checkbox"
        checked={visible}
        onChange={(event) => {
          setVisibilityOverride(event.target.checked);
          onVisibility(event.target.checked);
        }}
      />
      <span title={title}>{title}</span>
      <small>{layer.type}</small>
    </label>
  );
}
