import { AcApDocManager, AcEdOpenMode, MTEXT_RENDERER_WORKER_FILE } from '@mlightcad/cad-simple-viewer';
import { AcCmColor, AcDbSysVarManager } from '@mlightcad/data-model';
import { CAD_CANVAS_MAX_HANDLES, CAD_CANVAS_MAX_LAYERS, parseCadCanvasPayload, parseCadCanvasTarget, type CadCanvasSelection, type CadCanvasTarget } from '../../../contracts/canvas-cad';
import type { CanvasView } from '../../platform/canvas/canvas-state';
import { sessionFileUrl } from '../../platform/workspace/file-urls';

type CadView = Extract<CanvasView, { kind: 'cad' }>;
export type CadLayerRow = { name: string; cssColor: string; isOn: boolean; isFrozen: boolean; isLocked: boolean };
let manager: AcApDocManager | null = null;
let managerHost: HTMLDivElement | null = null;
let mountedRenderers = 0;
let destroyTimer: ReturnType<typeof setTimeout> | null = null;
let opening: Promise<unknown> = Promise.resolve();
let attached: { host: HTMLDivElement; key: string; view: CadView; ready: boolean } | null = null;
const displayStates = new Map<string, { target: CadCanvasTarget; layers: CadLayerRow[] }>();

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
  attached = null;
  displayStates.clear();
  if (current) void current.destroy().catch((error) => console.error('CAD viewer cleanup failed', error));
}

export function retainViewer() {
  mountedRenderers++;
  if (destroyTimer) clearTimeout(destroyTimer);
  return () => {
    mountedRenderers--;
    if (!mountedRenderers) destroyTimer = setTimeout(() => {
      destroyTimer = null;
      if (!mountedRenderers) void opening.finally(() => { if (!mountedRenderers) destroyManager(); });
    }, 300);
  };
}

export function viewerManager(host: HTMLDivElement) {
  return attached?.host === host && managerHost?.parentElement === host ? manager : null;
}

export function detachViewer(host: HTMLDivElement) {
  const mgr = viewerManager(host);
  if (mgr && attached?.ready) {
    displayStates.set(attached.key, { target: currentTarget(mgr, attached.view), layers: layersFor(mgr) });
  }
  if (attached?.host === host) attached = null;
  if (managerHost?.parentElement === host) managerHost.remove();
}

export function openDrawing(host: HTMLDivElement, sessionId: string, view: CadView, signal: AbortSignal): Promise<AcApDocManager> {
  const load = async () => {
    signal.throwIfAborted();
    const payload = parseCadCanvasPayload(view.canvas.payload);
    if (!payload) throw new Error('CAD Canvas payload is invalid.');
    const mgr = ensureManager();
    const stateKey = JSON.stringify([sessionId, view.id]);
    const documentKey = JSON.stringify([sessionId, view.id, view.revision, payload.sha256]);
    if (attached) detachViewer(attached.host);
    host.appendChild(managerHost!);
    attached = { host, key: stateKey, view, ready: false };
    try {
      const existing = mgr.documents.find((document) => document.docTitle === documentKey);
      if (existing) {
        if (!await mgr.activateDocument(existing)) throw new Error('CAD drawing could not be activated.');
      }
      else {
        const response = await fetch(sessionFileUrl(sessionId, payload.path), { cache: 'no-store', signal });
        if (!response.ok) throw new Error(`CAD file request failed (${response.status}).`);
        const maximum = 50 * 1024 * 1024;
        if (Number(response.headers.get('content-length')) > maximum) throw new Error('CAD drawing exceeds 50 MiB.');
        const content = await response.arrayBuffer();
        if (content.byteLength > maximum) throw new Error('CAD drawing exceeds 50 MiB.');
        const digest = await crypto.subtle.digest('SHA-256', content);
        const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        if (hash !== payload.sha256) throw new Error('CAD drawing checksum changed; reopen the current revision.');
        signal.throwIfAborted();
        const opened = await mgr.openDocument(payload.path.split('/').pop()!, content, { mode: AcEdOpenMode.Read, progressiveRendering: true });
        if (!opened) throw new Error('CAD drawing could not be opened.');
        mgr.curDocument.docTitle = documentKey;
      }
      signal.throwIfAborted();
      for (const document of [...mgr.documents]) {
        if (document === mgr.curDocument || !document.docTitle.startsWith('[')) continue;
        const identity = JSON.parse(document.docTitle);
        if (identity[0] === sessionId && identity[1] === view.id) await mgr.closeDocument(document);
      }
      await mgr.curView.waitUntilIdle(5_000);
      signal.throwIfAborted();
      const paper = new AcCmColor().setRGBFromCss(getComputedStyle(host).getPropertyValue('--canvas-paper').trim());
      const sysvars = AcDbSysVarManager.instance();
      sysvars.setVar('MODELBKCOLOR', paper, mgr.curDocument.database);
      sysvars.setVar('PAPERBKCOLOR', paper, mgr.curDocument.database);
      mgr.curView.backgroundColor = paper.RGB!;
      const saved = displayStates.get(stateKey);
      const target = view.canvas.target === undefined ? saved?.target : parseCadCanvasTarget(view.canvas.target);
      if (target) mgr.curView.flyTo({ x: target.center[0], y: target.center[1] }, target.zoom);
      else if (!existing) mgr.curView.zoomToFitDrawing(2_000);
      for (const layer of saved?.layers ?? []) {
        const store = mgr.curDocument.layerStore;
        if (!store.getLayers().some((item) => item.name === layer.name)) continue;
        store.setLayerFrozen(layer.name, layer.isFrozen);
        store.setLayerOn(layer.name, layer.isOn);
      }
      mgr.curView.selectionSet.clear();
      if (attached?.host === host) attached.ready = true;
      return mgr;
    } catch (error) {
      // An aborted SDK open must finish before another activation can start.
      if (attached?.host === host) { attached = null; managerHost?.remove(); }
      throw error;
    }
  };
  const result = opening.then(load, load);
  opening = result.then(() => undefined, () => undefined);
  return result;
}

export function emptySelection(): CadCanvasSelection {
  return { kind: 'cad-selection', handles: [], layers: [], count: 0, truncated: false };
}

export function currentTarget(mgr: AcApDocManager, view: CadView): CadCanvasTarget {
  const payload = parseCadCanvasPayload(view.canvas.payload);
  const base = view.canvas.target === undefined ? null : parseCadCanvasTarget(view.canvas.target);
  const units = payload?.units ?? base?.units ?? null;
  let center: [number, number] = base?.center ?? [0, 0];
  try {
    const value = mgr.curView.center;
    if (Number.isFinite(value.x) && Number.isFinite(value.y)) center = [value.x, value.y];
  } catch { /* the view may not be ready yet */ }
  return { kind: 'viewport', center, zoom: mgr.curView.internalCamera.zoom, units };
}

export function selectionFor(mgr: AcApDocManager): CadCanvasSelection {
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

export function layersFor(mgr: AcApDocManager): CadLayerRow[] {
  try { return mgr.curDocument.layerStore.getLayers(); } catch { return []; }
}

export function dropSelectionOnLayer(mgr: AcApDocManager, layerName: string) {
  try {
    const database = mgr.curDocument.database;
    const hidden = mgr.curView.selectionSet.ids.filter((handle) => {
      const entity = database.getObjectById(handle) as { layer?: unknown } | undefined;
      return entity && entity.layer === layerName;
    });
    if (hidden.length > 0) mgr.curView.selectionSet.delete(hidden);
  } catch { /* a stale selection can outlive its document */ }
}
