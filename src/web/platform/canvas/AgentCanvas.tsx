import { Component, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationView } from '../../../public/app-types.js';
import { Icon } from '../../components/icons';
import type { CanvasState } from './canvas-state';
import type { CanvasView } from './canvas-view';
import type { DocumentPosition, DocumentRequest } from './document-state';
import { rendererForCanvasView } from './renderer-registry';
import type { AppKernel } from '../../../public/kernel/app-kernel.js';

class CanvasRendererBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function AgentCanvas({ kernel, session, views, state, documentPositions, onActivate, onCloseTab, onClose, onShareContext, onOpenDocument }: {
  kernel: AppKernel;
  session: ConversationView | null;
  views: CanvasView[];
  state: CanvasState;
  documentPositions: Map<string, DocumentPosition>;
  onActivate(id: string): void;
  onCloseTab(id: string): void;
  onClose(): void;
  onShareContext(input: { viewId: string; revision: number; target?: unknown; selection?: unknown }): Promise<void>;
  onOpenDocument?(request: DocumentRequest): void;
}) {
  const { t } = useTranslation();
  const tabList = useRef<HTMLDivElement>(null);
  const [contextDrafts, setContextDrafts] = useState<Record<string, { revision?: number; target?: unknown; selection?: unknown }>>({});
  const [contextStatus, setContextStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const tabs = state.tabIds.flatMap((id) => views.find((view) => view.id === id) ?? []);
  const closed = views.filter((view) => !state.tabIds.includes(view.id));
  const activeView = tabs.find((view) => view.id === state.activeId);
  const activePresentation = activeView?.canvas;
  const shareablePresentation = activePresentation?.presentationId.startsWith('legacy:') ? undefined : activePresentation;
  const simulationContextPending = activeView?.kind === 'simulation' && !contextDrafts[activeView.id]?.target;
  const updateContext = useCallback((viewId: string, revision: number | undefined, target?: unknown, selection?: unknown) => {
    setContextDrafts((current) => ({ ...current, [viewId]: { revision, ...(target !== undefined ? { target } : {}), ...(selection !== undefined ? { selection } : {}) } }));
  }, []);
  async function shareContext() {
    if (!activeView || !shareablePresentation || simulationContextPending || contextStatus === 'busy') return;
    setContextStatus('busy');
    const currentDraft = contextDrafts[activeView.id];
    const draft = currentDraft?.revision === shareablePresentation.revision ? { target: currentDraft.target, selection: currentDraft.selection } : { target: shareablePresentation.target };
    try {
      await onShareContext({ viewId: activeView.id, revision: shareablePresentation.revision, ...draft });
      setContextStatus('done');
    } catch { setContextStatus('error'); }
  }
  useEffect(() => {
    if (state.open) tabList.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [state.activeId, state.open]);
  useEffect(() => { setContextStatus('idle'); }, [state.activeId, activePresentation?.revision, JSON.stringify(contextDrafts[state.activeId ?? ''])]);
  function navigate(event: KeyboardEvent, index: number) {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onActivate(tabs[next].id);
    tabList.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
  return <aside className={`workspace-float workspace-float--canvas${state.open ? ' is-open' : ''}`} aria-label={t('canvas.title')} data-testid="agent-canvas">
    <header className="workspace-float-header canvas-header">
      <div ref={tabList} className="agent-canvas-tabs" role="tablist" aria-label={t('canvas.views')}>
        {tabs.map((view, index) => <div className={`canvas-tab${view.id === state.activeId ? ' is-active' : ''}`} key={view.id}>
          <button id={`canvas-tab-${view.id}`} type="button" role="tab" aria-selected={view.id === state.activeId} aria-controls={`canvas-panel-${view.id}`} tabIndex={view.id === state.activeId ? 0 : -1} onKeyDown={(event) => navigate(event, index)} onClick={() => onActivate(view.id)} title={view.title}>
            <Icon name={view.kind === 'geo' || view.kind === 'simulation' ? 'map' : view.kind === 'video' ? 'video' : view.kind === 'cad' ? 'cad' : 'file'} /><span>{view.title}</span>
          </button>
          <button className="canvas-tab-close" type="button" aria-label={t('canvas.closeView', { title: view.title })} onClick={() => onCloseTab(view.id)}><Icon name="close" /></button>
        </div>)}
      </div>
      {closed.length ? <select className="canvas-reopen" aria-label={t('canvas.reopen')} value="" onChange={(event) => onActivate(event.target.value)}><option value="" disabled>＋</option>{closed.map((view) => <option key={view.id} value={view.id}>{view.title}</option>)}</select> : null}
      {activeView?.kind !== 'cad' ? <button className="canvas-context-action" type="button" disabled={!shareablePresentation || simulationContextPending || contextStatus === 'busy'} onClick={() => void shareContext()}>{contextStatus === 'done' ? t('canvas.contextAttached') : contextStatus === 'error' ? t('canvas.contextFailed') : t('canvas.attachContext')}</button> : null}
      <button className="icon-button" type="button" aria-label={t('canvas.hide')} onClick={onClose}><Icon name="close" /></button>
    </header>
    <div className="workspace-float-body">
      {session && tabs.map((view) => {
        const Renderer = rendererForCanvasView(view);
        return <div className="canvas-panel" role="tabpanel" id={`canvas-panel-${view.id}`} aria-labelledby={`canvas-tab-${view.id}`} key={view.id} hidden={view.id !== state.activeId}>
          {Renderer ? <CanvasRendererBoundary key={session.id} fallback={<p className="document-notice is-error" role="alert">
            {t('canvas.renderFailed')} <button type="button" className="underline" onClick={() => window.location.reload()}>{t('canvas.reloadWorkbench')}</button>
          </p>}>
            <Suspense fallback={<p className="document-notice">{t('workspace.reading')}</p>}><Renderer kernel={kernel} onAttachContext={shareContext} contextStatus={contextStatus} session={session} view={view} active={state.open && view.id === state.activeId} documentPositions={documentPositions} onOpenDocument={onOpenDocument} onContextChange={(target, selection) => updateContext(view.id, view.canvas?.revision, target, selection)} /></Suspense>
          </CanvasRendererBoundary> : null}
        </div>;
      })}
    </div>
  </aside>;
}
