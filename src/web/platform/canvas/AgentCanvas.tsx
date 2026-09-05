import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { LiveSession } from '../../../public/app-types.js';
import { Icon } from '../../components/icons';
import { GeoWorkspace } from '../../features/geo/GeoWorkspace';
import { VideoWorkspace } from '../../features/video/VideoWorkspace';
import type { CanvasState, CanvasView } from './canvas-state';

export function AgentCanvas({ session, views, state, onActivate, onCloseTab, onClose }: {
  session: LiveSession | null;
  views: CanvasView[];
  state: CanvasState;
  onActivate(id: string): void;
  onCloseTab(id: string): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const tabList = useRef<HTMLDivElement>(null);
  const tabs = state.tabIds.flatMap((id) => views.find((view) => view.id === id) ?? []);
  const closed = views.filter((view) => !state.tabIds.includes(view.id));
  useEffect(() => {
    if (state.open) tabList.current?.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [state.activeId, state.open]);
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
            <Icon name={view.kind === 'geo' ? 'map' : 'video'} /><span>{view.title}</span>
          </button>
          <button className="canvas-tab-close" type="button" aria-label={t('canvas.closeView', { title: view.title })} onClick={() => onCloseTab(view.id)}><Icon name="close" /></button>
        </div>)}
      </div>
      {closed.length ? <select className="canvas-reopen" aria-label={t('canvas.reopen')} value="" onChange={(event) => onActivate(event.target.value)}><option value="" disabled>＋</option>{closed.map((view) => <option key={view.id} value={view.id}>{view.title}</option>)}</select> : null}
      <button className="icon-button" type="button" aria-label={t('canvas.hide')} onClick={onClose}><Icon name="close" /></button>
    </header>
    <div className="workspace-float-body">
      {session && tabs.map((view) => <div className="canvas-panel" role="tabpanel" id={`canvas-panel-${view.id}`} aria-labelledby={`canvas-tab-${view.id}`} key={view.id} hidden={view.id !== state.activeId}>
        {view.kind === 'geo'
          ? <GeoWorkspace session={session} envelope={view.envelope} active={state.open && view.id === state.activeId} />
          : <VideoWorkspace session={session} item={view.item} revision={view.revision} compareItem={view.compareItem} active={state.open && view.id === state.activeId} />}
      </div>)}
    </div>
  </aside>;
}
