import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CAD_CANVAS_MAX_HANDLES, type CadCanvasSelection } from '../../../contracts/canvas-cad';
import { Icon } from '../../components/icons';
import type { CanvasRendererProps } from '../../platform/canvas/renderers/types';
import { openDrawing, retainViewer, detachViewer, viewerManager, currentTarget, emptySelection, selectionFor, layersFor, dropSelectionOnLayer, type CadLayerRow } from './cad-viewer';

type RevisionMark = { sessionId: string; viewId: string; revision: number };

export function CadWorkspace({ session, view, active, onContextChange }: CanvasRendererProps) {
  const { t } = useTranslation();
  const layerPanelId = useId();
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

  useEffect(() => retainViewer(), []);

  useEffect(() => {
    if (!active || !container.current || !cadView) {
      if (container.current) detachViewer(container.current);
      return;
    }
    const host = container.current;
    let cancelled = false;
    const controller = new AbortController();
    let detachSelection: (() => void) | undefined;
    let detachLayers: (() => void) | undefined;
    let detachViewport: (() => void) | undefined;
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
        const mgr = await openDrawing(host, session.id, cadView, controller.signal);
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
        mgr.curView.events.viewChanged.addEventListener(updateSelection);
        detachViewport = () => mgr.curView.events.viewChanged.removeEventListener(updateSelection);
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
      controller.abort();
      detachSelection?.();
      detachLayers?.();
      detachViewport?.();
      if (canvas) {
        if (onClick) canvas.removeEventListener('click', onClick);
        if (onPointerDown) canvas.removeEventListener('pointerdown', onPointerDown);
        if (onPointerUp) canvas.removeEventListener('pointerup', onPointerUp);
        if (onPointerCancel) canvas.removeEventListener('pointercancel', onPointerCancel);
      }
      detachViewer(host);
    };
  }, [active, retry, session.id, t, cadView?.id, cadView?.revision, cadView?.canvas.presentationId]);

  const visibleLayers = layers.filter((layer) => layer.isOn && !layer.isFrozen).length;
  const selectedLayers = new Set(selection.layers);

  const toggleLayer = (layer: CadLayerRow, visible: boolean) => {
    const manager = container.current && viewerManager(container.current);
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
    const manager = container.current && viewerManager(container.current);
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
          aria-controls={layerPanelId}
          onClick={() => setLegendOpen((value) => !value)}
        >
          <Icon name="layers" className="cad-canvas-tool-icon" />
          <span>{t('canvas.cad.layers')}</span>
          <span className="cad-canvas-tool-count">{visibleLayers}/{layers.length}</span>
        </button>
      </div>
      {legendOpen ? <div id={layerPanelId} className="cad-canvas-layers" role="group" aria-label={t('canvas.cad.layersPanel')}>
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
