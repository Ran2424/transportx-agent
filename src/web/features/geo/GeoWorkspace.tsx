import { useEffect, useMemo, useRef, useState } from 'react';
import type { LiveSession } from '../../../public/app-types.js';
import { useTranslation } from 'react-i18next';
import type { GeoClientContextV1, GeoContextMode, GeoInteractionRequestV1, VisualizationEnvelope } from '../../../contracts/geo.js';
import { useConversationState, useSessionState, useToolExecutionState } from '../../app/store-hooks';
import { appKernel } from '../../app/composition-root';
import { FeatureEmpty } from '../task/TaskBoard';
import { projectVisualizations } from './geo-projection';
import { geoContextStore } from './geo-context-store';

type GeoInteractionEvent =
  | { type: 'draft_changed'; draft: GeoClientContextV1 | null }
  | { type: 'draft_stale'; previousRevision: number; nextRevision: number }
  | { type: 'limit_reached'; limit: number }
  | { type: 'unselectable_layer'; layerId: string };
type GeoRuntime = {
  apply(envelope: VisualizationEnvelope, sessionId: string | null): Promise<void>;
  applyAgentSelection(input: { layerId: string; featureIds: Array<string | number>; fit?: boolean }): Promise<void>;
  setLayerVisibility(layerId: string, visible: boolean): void;
  setInteractionMode(mode: 'browse' | GeoContextMode, options?: { forRequest?: boolean; targetLayerIds?: string[]; maxFeatures?: number }): void;
  clearUserDraft(): void;
  getUserDraft(): GeoClientContextV1 | null;
  subscribe(listener: (event: GeoInteractionEvent) => void): () => void;
  fitToData(): void;
  resize(): void;
  destroy(): void;
};
type RuntimeModule = { createGeoMapRuntime(container: HTMLElement, onError: (message: string) => void): GeoRuntime };

const MODES: Array<'browse' | GeoContextMode> = ['browse', 'feature', 'point', 'rectangle', 'viewport'];

export function GeoWorkspace({ session, active }: { session: LiveSession | null; active: boolean }) {
  const { t } = useTranslation();
  const conversation = useConversationState();
  const sessions = useSessionState();
  const tools = useToolExecutionState();
  const entries = session ? conversation.bySession[session.id]?.snapshotEntries : undefined;
  const executions = session ? tools.bySession[session.id] : undefined;
  const items = useMemo(() => projectVisualizations(entries ?? [], Object.values(executions ?? {})), [entries, executions]);
  const [selectedId, setSelectedId] = useState('');
  const [runtime, setRuntime] = useState<GeoRuntime | null>(null);
  const [mode, setMode] = useState<'browse' | GeoContextMode>('browse');
  const [draft, setDraft] = useState<GeoClientContextV1 | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const selected = items.find((item) => item.visualizationId === selectedId) ?? items[0] ?? null;
  const interaction = session ? sessions.geoInteractionBySession[session.id] : undefined;
  const request = interaction?.waitingRequest;

  useEffect(() => {
    if (request && request.visualizationId !== selectedId && items.some((item) => item.visualizationId === request.visualizationId)) setSelectedId(request.visualizationId);
    else if (selected && selected.visualizationId !== selectedId) setSelectedId(selected.visualizationId);
  }, [items, request, selected, selectedId]);

  useEffect(() => {
    if (!request) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [request?.requestId]);

  useEffect(() => {
    const response = interaction?.lastResponse;
    if (response?.status === 'invalidated' || response?.status === 'expired' || response?.status === 'aborted') {
      setNotice(t('geo.requestEnded', { status: response.status, reason: response.reason }));
    }
  }, [interaction?.lastResponse?.requestId, interaction?.lastResponse?.status, interaction?.lastResponse?.reason, t]);

  useEffect(() => {
    if (!runtime) return;
    if (request && selected?.visualizationId === request.visualizationId) {
      if (selected.revision !== request.sceneRevision) { void respondInvalidated('scene_revision_changed'); return; }
      setMode(request.mode);
      runtime.setInteractionMode(request.mode, { forRequest: true, targetLayerIds: request.targetLayerIds, maxFeatures: request.maxFeatures });
    } else {
      setMode('browse');
      runtime.setInteractionMode('browse');
    }
  }, [request?.requestId, request?.sceneRevision, runtime, selected?.revision, selected?.visualizationId]);

  async function respondInvalidated(reason: 'scene_revision_changed' | 'visualization_changed' | 'resource_changed') {
    if (!session || !request) return;
    try { await appKernel.commands.geo.respond(session.id, request.requestId, { status: 'invalidated', reason }); }
    catch (cause) { setNotice((cause as Error).message); }
  }

  function handleRuntimeEvent(event: GeoInteractionEvent) {
    if (event.type === 'draft_changed') { setDraft(event.draft); if (event.draft) setNotice(''); return; }
    if (event.type === 'draft_stale') { setDraft(null); setNotice(t('geo.draftStale')); if (request) void respondInvalidated('scene_revision_changed'); return; }
    if (event.type === 'limit_reached') setNotice(t('geo.limitReached', { count: event.limit }));
    if (event.type === 'unselectable_layer') setNotice(t('geo.unselectableLayer', { layer: event.layerId }));
  }

  function changeMode(next: 'browse' | GeoContextMode) {
    if (request) return;
    setMode(next); setNotice(''); runtime?.setInteractionMode(next);
  }

  async function attachDraft() {
    if (!session || !runtime) return;
    if (geoContextStore.get(session.id).length >= 8) { setNotice(t('geo.contextLimit')); return; }
    const current = runtime.getUserDraft();
    if (!current) return;
    setBusy(true); setNotice('');
    try {
      const reference = await appKernel.commands.geo.createContext(session.id, current);
      geoContextStore.attach(session.id, { reference, context: current });
      runtime.clearUserDraft(); setMode('browse'); runtime.setInteractionMode('browse');
    } catch (cause) { setNotice((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function submitRequest() {
    if (!session || !request || !runtime) return;
    const current = runtime.getUserDraft();
    if (!current) return;
    setBusy(true); setNotice('');
    try { await appKernel.commands.geo.respond(session.id, request.requestId, { status: 'submitted', context: current }); runtime.clearUserDraft(); }
    catch (cause) { setNotice((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function cancelRequest() {
    if (!session || !request) return;
    setBusy(true); setNotice('');
    try { await appKernel.commands.geo.respond(session.id, request.requestId, { status: 'cancelled' }); runtime?.clearUserDraft(); }
    catch (cause) { setNotice((cause as Error).message); }
    finally { setBusy(false); }
  }

  if (!session) return <FeatureEmpty mark="04" title={t('task.waitingContext')} description={t('geo.waitingDescription')} />;
  if (!selected?.scene) return <FeatureEmpty mark="04" title={t('geo.emptyTitle')} description={t('geo.emptyDescription')} />;
  const remaining = request ? Math.max(0, Math.ceil((Date.parse(request.expiresAt) - now) / 1000)) : 0;

  return <div className="geo-workspace">
    {request ? <GeoRequestBanner request={request} remaining={remaining} busy={busy} canSubmit={!!draft} onSubmit={() => void submitRequest()} onCancel={() => void cancelRequest()} /> : null}
    <div className="geo-toolbar">
      <select aria-label={t('geo.select')} value={selected.visualizationId} onChange={(event) => setSelectedId(event.target.value)} disabled={!!request}>
        {items.map((item) => <option key={item.visualizationId} value={item.visualizationId}>{item.summary.title}</option>)}
      </select>
      {MODES.map((item) => <button key={item} className={mode === item ? 'is-active' : ''} type="button" disabled={!!request && request.mode !== item} onClick={() => changeMode(item)}>{t(`geo.mode.${item}`)}</button>)}
      <button type="button" disabled={!draft} onClick={() => runtime?.clearUserDraft()}>{t('geo.clear')}</button>
      {selected.scene.controls?.fitToData !== false ? <button type="button" onClick={() => runtime?.fitToData()}>{t('geo.fit')}</button> : null}
      <button type="button" disabled={!draft || busy || !!request} onClick={() => void attachDraft()}>{t('geo.attach')}</button>
      <small>rev {selected.revision}</small>
    </div>
    <GeoMap key={`${session.id}:${selected.visualizationId}`} envelope={selected} sessionId={session.id} active={active} onReady={setRuntime} onEvent={handleRuntimeEvent} />
    {draft ? <div className="geo-context-tray" role="status"><strong>{t(`geo.mode.${draft.mode}`)}</strong><span>{draft.summary}</span><small>{t('geo.contextMeta', { revision: draft.sceneRevision, count: draft.visibleLayerIds.length })}</small><button type="button" onClick={() => runtime?.clearUserDraft()}>{t('geo.clear')}</button>{request ? <button type="button" disabled={busy} onClick={() => void submitRequest()}>{t('geo.submit')}</button> : <button type="button" disabled={busy} onClick={() => void attachDraft()}>{t('geo.attach')}</button>}</div> : null}
    {notice ? <p className="geo-error" role="alert">{notice}</p> : null}
    <div className="geo-layers" role="group" aria-label={t('geo.layers')} tabIndex={0}>{[...selected.scene.layers].reverse().map((layer) => <GeoLayer key={`${selected.visualizationId}:${layer.id}`} layer={layer} onVisibility={(visible) => runtime?.setLayerVisibility(layer.id, visible)} />)}</div>
    {selected.scene.metadata.description ? <p className="geo-description" role="region" aria-label={t('geo.description')} tabIndex={0}>{selected.scene.metadata.description}</p> : null}
  </div>;
}

function GeoRequestBanner({ request, remaining, busy, canSubmit, onSubmit, onCancel }: { request: GeoInteractionRequestV1; remaining: number; busy: boolean; canSubmit: boolean; onSubmit(): void; onCancel(): void }) {
  const { t } = useTranslation();
  return <div className="geo-request-banner" role="alert"><div><strong>{t('geo.requestTitle', { mode: t(`geo.mode.${request.mode}`) })}</strong><span>{request.prompt}</span></div><small>{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</small><button type="button" disabled={!canSubmit || busy} onClick={onSubmit}>{t('geo.submit')}</button><button type="button" disabled={busy} onClick={onCancel}>{t('geo.cancel')}</button></div>;
}

function GeoMap({ envelope, sessionId, active, onReady, onEvent }: { envelope: VisualizationEnvelope; sessionId: string; active: boolean; onReady(runtime: GeoRuntime | null): void; onEvent(event: GeoInteractionEvent): void }) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const runtime = useRef<GeoRuntime | null>(null);
  const latestEnvelope = useRef(envelope);
  const latestEvent = useRef(onEvent);
  const resizeFrame = useRef<number | null>(null);
  const [error, setError] = useState('');
  const runtimeKey = `${sessionId}:${envelope.visualizationId}`;
  latestEnvelope.current = envelope; latestEvent.current = onEvent;
  const resize = () => { if (resizeFrame.current !== null) return; resizeFrame.current = requestAnimationFrame(() => { resizeFrame.current = null; runtime.current?.resize(); }); };

  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const observer = new ResizeObserver(resize); observer.observe(node);
    return () => { observer.disconnect(); if (resizeFrame.current !== null) cancelAnimationFrame(resizeFrame.current); resizeFrame.current = null; };
  }, []);

  useEffect(() => {
    if (!active || !container.current) return;
    let disposed = false, unsubscribe = () => {};
    setError('');
    void import('../../../public/visualization/geo/geo-runtime-entry.js').then(async (module: RuntimeModule) => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (disposed || !container.current) return;
      const instance = module.createGeoMapRuntime(container.current, setError);
      runtime.current = instance; unsubscribe = instance.subscribe((event) => latestEvent.current(event));
      await instance.apply(latestEnvelope.current, sessionId);
      if (!disposed && runtime.current === instance) { onReady(instance); resize(); }
    }).catch((cause) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; unsubscribe(); runtime.current?.destroy(); runtime.current = null; onReady(null); };
  }, [active, runtimeKey, sessionId]);

  useEffect(() => { if (active && runtime.current) { setError(''); void runtime.current.apply(envelope, sessionId).then(resize).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))); } }, [active, envelope, sessionId]);
  useEffect(() => { if (!active) return; resize(); const timer = window.setTimeout(resize, 260); return () => window.clearTimeout(timer); }, [active, runtimeKey]);
  return <><div ref={container} className="geo-map" aria-label={t('geo.map')} />{error ? <p className="geo-error">{t('geo.loadFailed', { error })}</p> : null}</>;
}

function GeoLayer({ layer, onVisibility }: { layer: NonNullable<VisualizationEnvelope['scene']>['layers'][number]; onVisibility(visible: boolean): void }) {
  const [visibilityOverride, setVisibilityOverride] = useState<boolean | null>(null);
  const visible = visibilityOverride ?? layer.visible !== false;
  const title = layer.title || layer.id;
  return <label className={!visible ? 'is-muted' : ''}><input type="checkbox" checked={visible} onChange={(event) => { setVisibilityOverride(event.target.checked); onVisibility(event.target.checked); }} /><span title={title}>{title}</span><small>{layer.type}</small></label>;
}
