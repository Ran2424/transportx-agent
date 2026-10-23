import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AcApDocManager, AcEdOpenMode, MTEXT_RENDERER_WORKER_FILE } from '@mlightcad/cad-simple-viewer';
import { CAD_CANVAS_MAX_HANDLES, CAD_CANVAS_MAX_LAYERS, parseCadCanvasPayload, parseCadCanvasTarget, type CadCanvasSelection, type CadCanvasTarget } from '../../../../contracts/canvas-cad';
import { sessionFileUrl } from '../../workspace/file-urls';
import type { CanvasRendererProps } from './types';

const MAX_CAD_BYTES = 50 * 1024 * 1024;
const MAX_CAD_ENTITIES = 20_000;

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

export default function CadCanvasRenderer({ session, view, active, onContextChange }: CanvasRendererProps) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const onContext = useRef(onContextChange);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [retry, setRetry] = useState(0);
  const cadView = view.kind === 'cad' ? view : null;

  useEffect(() => {
    onContext.current = onContextChange;
  }, [onContextChange]);

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
    setStatus('loading');
    setError('');
    setWarning('');

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
        const target = currentTarget(mgr, cadView);
        onContext.current(target, emptySelection());
        const selectionSet = mgr.curView.selectionSet;
        const updateSelection = () => {
          if (!cancelled) onContext.current(currentTarget(mgr, cadView), selectionFor(mgr));
        };
        selectionSet.events.selectionAdded.addEventListener(updateSelection);
        selectionSet.events.selectionRemoved.addEventListener(updateSelection);
        detachSelection = () => {
          selectionSet.events.selectionAdded.removeEventListener(updateSelection);
          selectionSet.events.selectionRemoved.removeEventListener(updateSelection);
        };
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
      if (managerHost?.parentElement === host) managerHost.remove();
    };
  }, [active, retry, session.id, t, cadView?.id, cadView?.revision]);

  if (!cadView) return null;
  return <div className="cad-canvas" ref={container} data-testid="cad-canvas">
    {status !== 'ready' ? <div className="cad-canvas-overlay">
      <p className="document-notice">{status === 'error' ? error : t('common.loading')}</p>
      {status === 'error' ? <button type="button" className="cad-canvas-retry" onClick={() => setRetry((value) => value + 1)}>{t('common.retry')}</button> : null}
    </div> : null}
    {warning ? <p className="cad-canvas-warning" role="status">{warning}</p> : null}
    <span className="cad-canvas-badge">{t('canvas.cad.readOnly')}</span>
  </div>;
}
