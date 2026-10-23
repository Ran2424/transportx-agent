import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AcApDocManager, AcEdOpenMode, MTEXT_RENDERER_WORKER_FILE } from '@mlightcad/cad-simple-viewer';
import {
  CAD_CANVAS_MAX_HANDLES,
  CAD_CANVAS_MAX_LAYERS,
  parseCadCanvasPayload,
  parseCadCanvasTarget,
  type CadCanvasSelection,
  type CadCanvasTarget,
} from '../../../../contracts/canvas-cad';
import { Icon } from '../../../components/icons';
import { sessionFileUrl } from '../../workspace/file-urls';
import type { CanvasRendererProps } from './types';

const MAX_CAD_BYTES = 50 * 1024 * 1024;
const MAX_CAD_ENTITIES = 20_000;

type CadLayerRow = {
  name: string;
  cssColor: string;
  isOn: boolean;
  isFrozen: boolean;
  isLocked: boolean;
};

type RevisionMark = {
  sessionId: string;
  viewId: string;
  revision: number;
};

let manager: AcApDocManager | null = null;
let managerHost: HTMLDivElement | null = null;
let mountedRenderers = 0;
let destroyTimer: ReturnType<typeof setTimeout> | null = null;

function ensureManager(): AcApDocManager {
  if (manager) return manager;
  if (!managerHost) {
    managerHost = document.createElement('div');
    managerHost.className = 'cad-canvas-host';
    managerHost.setAttribute('aria-label', 'CAD drawing');
  }
  const created = AcApDocManager.createInstance({
    container: managerHost,
    autoResize: true,
    useMainThreadDraw: true,
    disableExport: true,
    builtinOpenFileDialog: false,
    notificationCenter: false,
    checkWorkersOnInit: true,
    webworkerFileUrls: { mtextRender: `/workers/${MTEXT_RENDERER_WORKER_FILE}` },
  });
  if (!created) throw new Error('CAD viewer could not be initialized.');
  manager = created;
  return created;
}

function destroyManager() {
  const current = manager;
  manager = null;
  managerHost?.remove();
  managerHost = null;
  if (current) void current.destroy().catch((error) => console.error('CAD viewer cleanup failed', error));
}

function emptySelection(): CadCanvasSelection {
  return { kind: 'cad-selection', handles: [], layers: [], count: 0, truncated: false };
}

function currentTarget(mgr: AcApDocManager, view: Extract<CanvasRendererProps['view'], { kind: 'cad' }>): CadCanvasTarget {
  const payload = parseCadCanvasPayload(view.canvas.payload);
  const base = view.canvas.target === undefined ? null : parseCadCanvasTarget(view.canvas.target);
  const units = payload?.units ?? base?.units ?? 'm';
  let center: [number, number] = base?.center ?? [0, 0];
  try {
    const value = mgr.curView.center;
    if (Number.isFinite(value.x) && Number.isFinite(value.y)) center = [value.x, value.y];
  } catch { /* the view may not be ready yet */ }
  return { kind: 'viewport', center, zoom: base?.zoom ?? 1, units };
}

function selectionFor(mgr: AcApDocManager): CadCanvasSelection {
  let ids: string[] = [];
  try { ids = mgr.curView.selectionSet.ids; } catch { /* no active document */ }
  const handles = ids.slice(0, CAD_CANVAS_MAX_HANDLES);
  const layers = new Set<string>();
  try {
    const database = mgr.curDocument.database;
    for (const handle of handles) {
      const entity = database.getObjectById(handle) as { layer?: unknown } | undefined;
      if (entity && typeof entity.layer === 'string' && entity.layer) layers.add(entity.layer);
    }
  } catch { /* a stale selection can outlive its document */ }
  return {
    kind: 'cad-selection',
    handles,
    layers: [...layers].slice(0, CAD_CANVAS_MAX_LAYERS),
    count: ids.length,
    truncated: ids.length > handles.length || layers.size > CAD_CANVAS_MAX_LAYERS,
  };
}

function layersFor(mgr: AcApDocManager): CadLayerRow[] {
  try { return mgr.curDocument.layerStore.getLayers(); } catch { return []; }
}

function dropSelectionOnLayer(mgr: AcApDocManager, layerName: string) {
  try {
    const database = mgr.curDocument.database;
    const hidden = mgr.curView.selectionSet.ids.filter((handle) => {
      const entity = database.getObjectById(handle) as { layer?: unknown } | undefined;
      return entity && entity.layer === layerName;
    });
    if (hidden.length > 0) mgr.curView.selectionSet.delete(hidden);
  } catch { /* a stale selection can outlive its document */ }
}

export default function CadCanvasRenderer({ session, view, active, onContextChange }: CanvasRendererProps) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const onContext = useRef(onContextChange);
  const lastRevision = useRef<RevisionMark | null>(null);
  const revisionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [retry, setRetry] = useState(0);
  const [selection, setSelection] = useState<CadCanvasSelection>(emptySelection);
  const [layers, setLayers] = useState<CadLayerRow[]>([]);
  const [legendOpen, setLegendOpen] = useState(false);
  const [revision, setRevision] = useState<number | null>(null);
  const [revisionNotice, setRevisionNotice] = useState<number | null>(null);
  const cadView = view.kind === 'cad' ? view : null;

  useEffect(() => {
    onContext.current = onContextChange;
  }, [onContextChange]);

  useEffect(() => () => {
    if (revisionTimer.current) clearTimeout(revisionTimer.current);
  }, []);

  useEffect(() => {
    mountedRenderers += 1;
    if (destroyTimer) {
      clearTimeout(destroyTimer);
      destroyTimer = null;
    }
    return () => {
      mountedRenderers -= 1;
      if (mountedRenderers === 0) {
        destroyTimer = setTimeout(() => {
          destroyTimer = null;
          if (mountedRenderers === 0) destroyManager();
        }, 300);
      }
    };
  }, []);

  useEffect(() => {
    if (!active || !container.current || !cadView) {
      if (managerHost?.parentElement === container.current) managerHost.remove();
      return;
    }
    const host = container.current;
    let cancelled = false;
    let detachSelection: (() => void) | undefined;
    let detachLayers: (() => void) | undefined;
    let canvas: HTMLCanvasElement | null = null;
    let onClick: ((event: MouseEvent) => void) | undefined;
    let onPointerDown: ((event: PointerEvent) => void) | undefined;
    let onPointerUp: ((event: PointerEvent) => void) | undefined;
    let onPointerCancel: (() => void) | undefined;
    setStatus('loading');
    setError('');
    setWarning('');
    setSelection(emptySelection());
    setLayers([]);

    void (async () => {
      try {
        const mgr = ensureManager();
        if (cancelled) return;
        if (!managerHost) throw new Error('CAD viewer host is unavailable.');
        host.appendChild(managerHost);
        const key = `${cadView.id}@r${cadView.revision}`;
        const existing = mgr.documents.find((document) => document.docTitle === key);
        if (existing) {
          await mgr.activateDocument(existing);
        } else {
          const payload = parseCadCanvasPayload(cadView.canvas.payload);
          if (!payload) throw new Error('CAD Canvas payload is invalid.');
          if (payload.entityCount > MAX_CAD_ENTITIES) setWarning(t('canvas.cad.largeDrawing'));
          const response = await fetch(sessionFileUrl(session.id, payload.path), { cache: 'no-store' });
          if (!response.ok) throw new Error(t('document.loadFailed', { status: response.status }));
          const length = Number(response.headers.get('content-length') || 0);
          if (length > MAX_CAD_BYTES) throw new Error(t('canvas.cad.tooLarge'));
          const content = await response.arrayBuffer();
          if (cancelled) return;
          const fileName = payload.path.split('/').pop() || 'drawing.dxf';
          const opened = await mgr.openDocument(fileName, content, { mode: AcEdOpenMode.Read, progressiveRendering: true });
          if (!opened) throw new Error(t('canvas.cad.openFailed'));
          mgr.curDocument.docTitle = key;
        }
        if (cancelled) return;
        mgr.curView.backgroundColor = 0xffffff;
        await mgr.curView.waitUntilIdle(5_000);
        mgr.curView.zoomToFitDrawing(2_000);
        if (cancelled) return;
        setStatus('ready');
        setRevision(cadView.revision);
        const target = currentTarget(mgr, cadView);
        setSelection(emptySelection());
        onContext.current(target, emptySelection());

        const layerStore = mgr.curDocument.layerStore;
        const updateLayers = () => {
          if (!cancelled) setLayers(layersFor(mgr));
        };
        updateLayers();
        layerStore.events.changed.addEventListener(updateLayers);
        detachLayers = () => layerStore.events.changed.removeEventListener(updateLayers);

        const selectionSet = mgr.curView.selectionSet;
        const updateSelection = () => {
          if (cancelled) return;
          const next = selectionFor(mgr);
          setSelection(next);
          onContext.current(currentTarget(mgr, cadView), next);
        };
        selectionSet.events.selectionAdded.addEventListener(updateSelection);
        selectionSet.events.selectionRemoved.addEventListener(updateSelection);
        detachSelection = () => {
          selectionSet.events.selectionAdded.removeEventListener(updateSelection);
          selectionSet.events.selectionRemoved.removeEventListener(updateSelection);
        };

        canvas = mgr.curView.canvas;
        let pointerStart: { x: number; y: number } | null = null;
        let suppressClick = false;
        onPointerDown = (event: PointerEvent) => {
          if (event.button !== 0) return;
          pointerStart = { x: event.clientX, y: event.clientY };
          suppressClick = false;
        };
        onPointerUp = (event: PointerEvent) => {
          if (!pointerStart) return;
          suppressClick = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4;
          pointerStart = null;
        };
        onPointerCancel = () => {
          pointerStart = null;
          suppressClick = false;
        };
        onClick = (event: MouseEvent) => {
          if (event.button !== 0 || suppressClick) {
            suppressClick = false;
            return;
          }
          if (cancelled) return;
          try {
            const rect = canvas?.getBoundingClientRect();
            if (!rect) return;
            const point = mgr.curView.screenToWorld({
              x: event.clientX - rect.left,
              y: event.clientY - rect.top,
            });
            const layers = new Map(layersFor(mgr).map((layer) => [layer.name, layer.isOn && !layer.isFrozen]));
            const hits = mgr.curView.pick(point);
            const visibleHit = hits.some((hit) => {
              const entity = mgr.curDocument.database.getObjectById(hit.id) as { layer?: unknown } | undefined;
              return !entity || typeof entity.layer !== 'string' || layers.get(entity.layer) !== false;
            });
            if (!visibleHit) {
              mgr.curView.selectionSet.clear();
              updateSelection();
            }
          } catch { /* no active document */ }
        };
        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('pointercancel', onPointerCancel);
        canvas.addEventListener('click', onClick);

        const previous = lastRevision.current;
        if (revisionTimer.current) {
          clearTimeout(revisionTimer.current);
          revisionTimer.current = null;
        }
        if (previous && previous.sessionId === session.id && previous.viewId === cadView.id && cadView.revision > previous.revision) {
          setRevisionNotice(cadView.revision);
          revisionTimer.current = setTimeout(() => {
            revisionTimer.current = null;
            setRevisionNotice(null);
          }, 4_000);
        } else {
          setRevisionNotice(null);
        }
        lastRevision.current = { sessionId: session.id, viewId: cadView.id, revision: cadView.revision };

        void mgr.areWorkersReady().then((ready) => {
          if (!ready && !cancelled) setWarning(t('canvas.cad.workerWarning'));
        }).catch(() => {
          if (!cancelled) setWarning(t('canvas.cad.workerWarning'));
        });
      } catch (reason) {
        if (!cancelled) {
          setStatus('error');
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    })();

    return () => {
      cancelled = true;
      detachSelection?.();
      detachLayers?.();
      if (canvas) {
        if (onClick) canvas.removeEventListener('click', onClick);
        if (onPointerDown) canvas.removeEventListener('pointerdown', onPointerDown);
        if (onPointerUp) canvas.removeEventListener('pointerup', onPointerUp);
        if (onPointerCancel) canvas.removeEventListener('pointercancel', onPointerCancel);
      }
      if (managerHost?.parentElement === host) managerHost.remove();
    };
  }, [active, retry, session.id, t, cadView?.id, cadView?.revision]);

  const visibleLayers = layers.filter((layer) => layer.isOn && !layer.isFrozen).length;
  const selectedLayers = new Set(selection.layers);

  const toggleLayer = (layer: CadLayerRow, visible: boolean) => {
    if (!manager) return;
    try {
      const store = manager.curDocument.layerStore;
      if (visible) {
        if (layer.isFrozen) store.setLayerFrozen(layer.name, false);
        if (!layer.isOn) store.setLayerOn(layer.name, true);
      } else {
        if (layer.isOn) store.setLayerOn(layer.name, false);
        dropSelectionOnLayer(manager, layer.name);
      }
    } catch (reason) {
      console.error('CAD layer visibility failed', reason);
    }
    if (manager) setLayers(layersFor(manager));
  };

  const showAllLayers = () => {
    if (!manager) return;
    try {
      const store = manager.curDocument.layerStore;
      for (const layer of store.getLayers()) {
        if (layer.isFrozen) store.setLayerFrozen(layer.name, false);
        if (!layer.isOn) store.setLayerOn(layer.name, true);
      }
    } catch (reason) {
      console.error('CAD layer visibility failed', reason);
    }
    if (manager) setLayers(layersFor(manager));
  };

  if (!cadView) return null;
  return <div className="cad-canvas" ref={container} data-testid="cad-canvas">
    {status !== 'ready' ? <div className="cad-canvas-overlay">
      <p className="document-notice">{status === 'error' ? error : t('common.loading')}</p>
      {status === 'error' ? <button type="button" className="cad-canvas-retry" onClick={() => setRetry((value) => value + 1)}>{t('common.retry')}</button> : null}
    </div> : null}
    {status === 'ready' ? <>
      <div className={`cad-canvas-selection${selection.count > 0 ? ' is-active' : ''}`} role="status" aria-live="polite">
        <span>{t('canvas.cad.selectedCount', { count: selection.count })}</span>
        {selection.count > 0 ? <>
          <span className="cad-canvas-selection-sep" aria-hidden="true">·</span>
          <span className="cad-canvas-selection-layers">{t('canvas.cad.selectedLayers', { count: selection.layers.length })}</span>
        </> : null}
        {selection.truncated ? <>
          <span className="cad-canvas-selection-sep" aria-hidden="true">·</span>
          <span className="cad-canvas-selection-truncated">{t('canvas.cad.selectionTruncated', { count: CAD_CANVAS_MAX_HANDLES })}</span>
        </> : null}
      </div>
      <div className="cad-canvas-tools">
        <button
          type="button"
          className="cad-canvas-tool"
          aria-expanded={legendOpen}
          aria-controls="cad-canvas-layer-panel"
          onClick={() => setLegendOpen((value) => !value)}
        >
          <Icon name="layers" className="cad-canvas-tool-icon" />
          <span>{t('canvas.cad.layers')}</span>
          <span className="cad-canvas-tool-count">{visibleLayers}/{layers.length}</span>
        </button>
      </div>
      {legendOpen ? <div id="cad-canvas-layer-panel" className="cad-canvas-layers" role="group" aria-label={t('canvas.cad.layersPanel')}>
        <div className="cad-canvas-layers-head">
          <strong>{t('canvas.cad.layers')}</strong>
          <span>{visibleLayers}/{layers.length}</span>
          <button type="button" onClick={showAllLayers} disabled={layers.length === 0 || visibleLayers === layers.length}>
            {t('canvas.cad.showAllLayers')}
          </button>
        </div>
        {layers.length === 0 ? <p className="cad-canvas-layers-empty">{t('canvas.cad.noLayers')}</p> : <ul className="cad-canvas-layer-list">
          {layers.map((layer) => {
            const visible = layer.isOn && !layer.isFrozen;
            const stateLabel = layer.isFrozen
              ? t('canvas.cad.layerFrozen')
              : layer.isLocked ? t('canvas.cad.layerLocked') : !layer.isOn ? t('canvas.cad.layerHidden') : undefined;
            return <li key={layer.name} className={selectedLayers.has(layer.name) ? 'is-selected' : undefined}>
              <label title={stateLabel ? `${layer.name} · ${stateLabel}` : layer.name}>
                <input
                  type="checkbox"
                  checked={visible}
                  aria-label={t('canvas.cad.toggleLayer', { name: layer.name })}
                  onChange={(event) => toggleLayer(layer, event.target.checked)}
                />
                <span className="cad-canvas-layer-swatch" style={{ background: layer.cssColor }} aria-hidden="true" />
                <span className="cad-canvas-layer-name">{layer.name}</span>
                {stateLabel ? <span className="cad-canvas-layer-state">{stateLabel}</span> : null}
              </label>
            </li>;
          })}
        </ul>}
      </div> : null}
    </> : null}
    {revisionNotice !== null ? <div className="cad-canvas-revision-notice" role="status" aria-live="polite">
      {t('canvas.cad.revisionUpdated', { revision: revisionNotice })}
    </div> : null}
    {warning ? <p className="cad-canvas-warning" role="status">{warning}</p> : null}
    <span className="cad-canvas-badge" title={t('canvas.cad.panHint')}>
      {t('canvas.cad.readOnly')}{revision !== null ? ` · r${revision}` : ''}
    </span>
  </div>;
}
