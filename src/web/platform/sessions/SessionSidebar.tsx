import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationRecordV1 } from '../../../contracts/workspace.js';
import type { ConversationView, WorkspaceView } from '../../../public/app-types.js';
import { appKernel } from '../../app/composition-root';
import { BrandMark } from '../../components/BrandMark';
import { Icon } from '../../components/icons';
import { Button } from '../../components/ui/button';
import { Dialog, DialogClose } from '../../components/ui/dialog';
import { relativeTime } from '../../lib/formatting';
import { CapabilityPane } from '../capabilities/CapabilityPane';

type Props = {
  open: boolean; dataReady: boolean; sessions: ConversationView[]; workspaces: WorkspaceView[]; activeSessionId: string | null; historyRevision: number;
  onClose(): void; onGoHome(): void; onNewSession(workspace?: WorkspaceView): void; onManageModules(): void;
  onSelect(conversationId: string): void;
  onDelete(workspace: WorkspaceView, record?: ConversationRecordV1): void;
  onDiagnostics(workspace?: WorkspaceView): void;
};
type Target = { workspace: WorkspaceView; record?: ConversationRecordV1 };
function savedCollapsed() { try { return JSON.parse(window.localStorage.getItem('tau-collapsed-workspaces') || '[]') as string[]; } catch { return []; } }
function conversationActivity(item: WorkspaceView['conversations'][number]) { return Date.parse(item.lastConversationAt || '') || (item.hasMessages === false ? Date.parse(item.record.createdAt) || 0 : 0); }
function workspaceActivity(workspace: WorkspaceView) { return Math.max(0, ...workspace.conversations.map((item) => Date.parse(item.lastConversationAt || '') || 0)) || (workspace.conversations.every((item) => item.hasMessages === false) ? Date.parse(workspace.createdAt || '') || 0 : 0); }

export function SessionSidebar({ open, dataReady, sessions, workspaces, activeSessionId, historyRevision, onClose, onGoHome, onNewSession, onManageModules, onSelect, onDelete, onDiagnostics }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(''), [searchIds, setSearchIds] = useState<Set<string> | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(savedCollapsed);
  const [capabilityCollapsed, setCapabilityCollapsed] = useState(() => { const saved = window.localStorage.getItem('tau-capability-collapsed'); return saved === null ? window.innerWidth <= 860 : saved === '1'; });
  const [conversationCollapsed, setConversationCollapsed] = useState(() => window.localStorage.getItem('tau-conversation-collapsed') === '1');
  const [menu, setMenu] = useState<(Target & { x: number; y: number }) | null>(null);
  const [rename, setRename] = useState<Target | null>(null), [renameValue, setRenameValue] = useState(''), [saving, setSaving] = useState(false);
  const [move, setMove] = useState<Target | null>(null), [moveTarget, setMoveTarget] = useState(''), [moving, setMoving] = useState(false);
  const regularWorkspaces = workspaces.filter((workspace) => workspace.kind !== 'standalone');
  const standaloneRows = workspaces.filter((workspace) => workspace.kind === 'standalone').flatMap((workspace) => workspace.conversations.map((item) => ({ workspace, item })));
  const moveDestinations = move ? [
    ...(move.workspace.kind === 'standalone' ? [] : [{ value: 'standalone', label: t('workspaceFlow.moveOutOption') }]),
    ...regularWorkspaces.filter((workspace) => workspace.availability === 'ready' && workspace.id !== move.workspace.id).map((workspace) => ({ value: workspace.id, label: workspace.name })),
  ] : [];
  async function refresh() { setLoading(true); try { await appKernel.commands.session.list(); setError(''); } catch (cause) { setError((cause as Error).message); } finally { setLoading(false); } }
  function openMove(target: Target) {
    const destinations = target.workspace.kind === 'standalone'
      ? regularWorkspaces.filter((workspace) => workspace.availability === 'ready')
      : [{ id: 'standalone' }, ...regularWorkspaces.filter((workspace) => workspace.availability === 'ready' && workspace.id !== target.workspace.id)];
    setMove(target); setMoveTarget(destinations[0]?.id || ''); setError('');
  }
  async function submitMove() {
    if (!move || !moveTarget) return;
    setMoving(true); setError('');
    const run = (stopCurrent: boolean) => appKernel.commands.session.moveConversation(move.record!.id, { target: moveTarget, ...(stopCurrent ? { stopCurrent: true } : {}) });
    try {
      try { await run(false); }
      catch (cause) {
        if ((cause as { code?: string }).code !== 'workspace_busy' || !window.confirm(t('workspaceFlow.stopMove'))) throw cause;
        await run(true);
      }
      setMove(null); await refresh();
    } catch (cause) { setError((cause as Error).message); await refresh(); }
    finally { setMoving(false); }
  }
  useEffect(() => { if (!dataReady) { setLoading(false); setError(''); return; } void refresh(); }, [historyRevision, dataReady]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => { if (!(event.target instanceof Element && event.target.closest('.session-context-menu'))) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    window.addEventListener('pointerdown', dismiss); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', escape); };
  }, [menu]);
  useEffect(() => {
    let current = true; setSearchIds(null);
    if (query.trim().length < 2) return;
    const timer = window.setTimeout(() => { void appKernel.commands.session.searchHistory(query).then((items) => { if (current) setSearchIds(new Set(items.map((item) => item.conversationId))); }).catch((cause) => { if (current) setError((cause as Error).message); }); }, 200);
    return () => { current = false; window.clearTimeout(timer); };
  }, [query]);
  function toggleWorkspace(id: string) { const next = collapsed.includes(id) ? collapsed.filter((value) => value !== id) : [...collapsed, id]; setCollapsed(next); window.localStorage.setItem('tau-collapsed-workspaces', JSON.stringify(next)); }
  async function saveName() {
    if (!rename || rename.workspace.revision === null) return;
    setSaving(true); setError('');
    try {
      if (rename.record) await appKernel.commands.session.rename({ conversationId: rename.record.id, name: renameValue.trim(), expectedRevision: rename.workspace.revision });
      else await appKernel.commands.session.updateWorkspace(rename.workspace.id, { name: renameValue.trim(), expectedRevision: rename.workspace.revision });
      setRename(null); await refresh();
    } catch (cause) { setError((cause as Error).message); await appKernel.commands.session.list().catch(() => {}); }
    finally { setSaving(false); }
  }
  return <>
    <aside className={`session-sidebar${open ? ' is-open' : ''}`} aria-label={t('sessions.sidebar')} data-testid="session-sidebar">
      <div className="sidebar-tools">
        <button className="sidebar-home-mark" type="button" aria-label={t('sessions.goHome')} onClick={onGoHome}><BrandMark className="sidebar-home-icon" /></button>
        <label className="sidebar-search"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('sessions.searchPlaceholder')} aria-label={t('sessions.search')} /></label>
        <button className="icon-button accent-button" type="button" aria-label={t('workspaceFlow.newAction')} disabled={!dataReady} onClick={() => onNewSession()}><Icon name="plus" /></button>
        <button className="icon-button" type="button" aria-label={t('sessions.refresh')} disabled={!dataReady || loading} onClick={() => void refresh()}><Icon name="refresh" /></button>
        <button className="icon-button mobile-only" type="button" aria-label={t('sessions.closeSidebar')} onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="sidebar-split">
        <CapabilityPane collapsed={capabilityCollapsed} onToggleCollapsed={() => { setCapabilityCollapsed(!capabilityCollapsed); window.localStorage.setItem('tau-capability-collapsed', capabilityCollapsed ? '0' : '1'); }} onManageModules={onManageModules} />
        <section className={`conversation-section${conversationCollapsed ? ' is-collapsed' : ''}`} aria-label={t('workspaceFlow.sidebar')}>
          <header className="sidebar-section-heading"><strong><Icon name="workspace" />{t('workspaceFlow.workspaces')}</strong><small>{regularWorkspaces.length + (standaloneRows.length ? 1 : 0)}</small><button className="sidebar-section-toggle" type="button" aria-expanded={!conversationCollapsed} aria-label={conversationCollapsed ? t('sessions.expandConversations') : t('sessions.collapseConversations')} onClick={() => { setConversationCollapsed(!conversationCollapsed); window.localStorage.setItem('tau-conversation-collapsed', conversationCollapsed ? '0' : '1'); }}><Icon name="chevron" /></button></header>
          {!conversationCollapsed && <div className="session-scroll">
            {loading && !workspaces.length && <div className="session-empty">{t('sessions.loadingIndex')}</div>}
            {error && <div className="session-empty is-error">{error}<button type="button" onClick={() => onDiagnostics()}>{t('workspaceFlow.migration')}</button></div>}
            {[...regularWorkspaces].sort((left, right) => workspaceActivity(right) - workspaceActivity(left)).map((workspace) => {
              const rows = [...workspace.conversations].sort((left, right) => conversationActivity(right) - conversationActivity(left)).filter(({ record }) => !query.trim() || record.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) || searchIds?.has(record.id));
              if (query.trim() && !rows.length && !workspace.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) return null;
              const expanded = !!query.trim() || !collapsed.includes(workspace.id);
              return <section className="workspace-group" key={workspace.id}>
                <div className="workspace-group-heading">
                  <button type="button" className="workspace-group-name" aria-expanded={expanded} onClick={() => toggleWorkspace(workspace.id)} title={workspace.path}><Icon name="chevron" /><strong>{workspace.name}</strong><small>{workspace.conversations.length}</small></button>
                  {workspace.availability === 'ready' && <button className="icon-button" type="button" aria-label={t('workspaceFlow.newIn', { name: workspace.name })} onClick={() => onNewSession(workspace)}><Icon name="plus" /></button>}
                  <button className="icon-button" type="button" aria-label={t('workspaceFlow.actions', { name: workspace.name })} onClick={(event) => setMenu({ workspace, x: event.clientX, y: event.clientY })}>⋯</button>
                </div>
                {workspace.availability !== 'ready' && <button type="button" className="session-empty is-error" onClick={() => workspace.availability === 'deleting' ? onDelete(workspace) : onDiagnostics(workspace)}>{workspace.availability === 'deleting' ? t('workspaceFlow.continueDelete') : `${workspace.availability === 'isolated' ? t('workspaceFlow.isolated') : t('workspaceFlow.needsMigration')} · ${t('workspaceFlow.inspectDetails')}`}</button>}
                {expanded && rows.map(({ record, runtime, lastConversationAt, hasMessages }) => <button className={`session-row${record.id === activeSessionId ? ' is-active' : ''}`} type="button" key={record.id} aria-disabled={record.state === 'deleting'} onClick={() => record.state === 'deleting' ? onDelete(workspace, record) : onSelect(record.id)} onContextMenu={(event) => { event.preventDefault(); setMenu({ workspace, record, x: event.clientX, y: event.clientY }); }}>
                  <span className="session-row-main"><strong>{record.name}</strong><small>{record.state === 'deleting' ? t('workspaceFlow.unfinishedDelete') : record.state === 'start-failed' ? t('workspaceFlow.startFailed') : lastConversationAt ? relativeTime(lastConversationAt) : t(hasMessages === false ? 'workspaceFlow.noMessages' : 'workspaceFlow.unknownActivity')}</small></span>
                  {(sessions.find((view) => view.id === record.id)?.isStreaming ?? runtime?.isStreaming) && <span className="session-row-meta"><i className="streaming-beacon" /></span>}
                </button>)}
              </section>;
            })}
            {standaloneRows.length > 0 && (() => {
              const rows = standaloneRows.filter(({ item }) => !query.trim() || item.record.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) || searchIds?.has(item.record.id)).sort((left, right) => conversationActivity(right.item) - conversationActivity(left.item));
              if (query.trim() && !rows.length) return null;
              const expanded = !!query.trim() || !collapsed.includes('standalone');
              return <section className="workspace-group" key="standalone">
                <div className="workspace-group-heading">
                  <button type="button" className="workspace-group-name" aria-expanded={expanded} onClick={() => toggleWorkspace('standalone')} title={t('workspaceFlow.standalone')}><Icon name="chevron" /><strong>{t('workspaceFlow.standalone')}</strong><small>{standaloneRows.length}</small></button>
                </div>
                {expanded && rows.map(({ workspace, item }) => <button className={`session-row${item.record.id === activeSessionId ? ' is-active' : ''}`} type="button" key={item.record.id} aria-disabled={item.record.state === 'deleting'} onClick={() => item.record.state === 'deleting' ? onDelete(workspace, item.record) : onSelect(item.record.id)} onContextMenu={(event) => { event.preventDefault(); setMenu({ workspace, record: item.record, x: event.clientX, y: event.clientY }); }}>
                  <span className="session-row-main"><strong>{item.record.name}</strong><small>{item.record.state === 'deleting' ? t('workspaceFlow.unfinishedDelete') : item.record.state === 'start-failed' ? t('workspaceFlow.startFailed') : item.lastConversationAt ? relativeTime(item.lastConversationAt) : t(item.hasMessages === false ? 'workspaceFlow.noMessages' : 'workspaceFlow.unknownActivity')}</small></span>
                  {(sessions.find((view) => view.id === item.record.id)?.isStreaming ?? item.runtime?.isStreaming) && <span className="session-row-meta"><i className="streaming-beacon" /></span>}
                </button>)}
              </section>;
            })()}
            {!loading && !error && !regularWorkspaces.length && !standaloneRows.length && <div className="session-empty">{t('workspaceFlow.empty')}</div>}
          </div>}
        </section>
      </div>
    </aside>
    {menu && <div className="session-context-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 200) }}>
      {menu.workspace.availability === 'ready' && menu.record?.state !== 'deleting' && <button type="button" role="menuitem" onClick={() => { setRename(menu); setRenameValue(menu.record?.name || menu.workspace.name); setError(''); setMenu(null); }}>{t(menu.record ? 'workspaceFlow.renameConversation' : 'workspaceFlow.renameWorkspace')}</button>}
      {menu.record && menu.record.state !== 'deleting' && menu.workspace.availability === 'ready' && <button type="button" role="menuitem" onClick={() => { openMove(menu); setMenu(null); }}>{t(menu.workspace.kind === 'standalone' ? 'workspaceFlow.moveIntoWorkspace' : 'workspaceFlow.moveConversation')}</button>}
      <button type="button" role="menuitem" onClick={() => { onDiagnostics(menu.workspace); setMenu(null); }}>{t('workspaceFlow.diagnostics')}</button>
      {(menu.workspace.kind !== 'standalone' && menu.workspace.directoryOwnership !== 'external' || menu.record) && (menu.workspace.availability === 'ready' || menu.workspace.availability === 'deleting' || menu.workspace.availability === 'isolated') && <button type="button" role="menuitem" onClick={() => { onDelete(menu.workspace, menu.record); setMenu(null); }}>{menu.workspace.availability === 'isolated' ? t('workspaceFlow.deleteIsolated') : menu.record ? t('workspaceFlow.deleteConversation') : t('workspaceFlow.deleteWorkspace')}</button>}
    </div>}
    <Dialog open={!!rename} onOpenChange={(next) => { if (!next && !saving) setRename(null); }} title={rename?.record ? t('workspaceFlow.renameConversation') : t('workspaceFlow.renameWorkspace')} className="confirmation-dialog" footer={<><DialogClose asChild><Button type="button" variant="quiet" disabled={saving}>{t('common.cancel')}</Button></DialogClose><Button type="button" variant="primary" disabled={!renameValue.trim() || saving} onClick={() => void saveName()}>{t('common.save')}</Button></>}>
      <label className="field-label"><span>{t('workspaceFlow.fieldName')}</span><input value={renameValue} maxLength={120} autoFocus onChange={(event) => setRenameValue(event.target.value)} /></label>{error && <p className="form-error">{error}</p>}
    </Dialog>
    <Dialog open={!!move} onOpenChange={(next) => { if (!next && !moving) setMove(null); }} title={move?.workspace.kind === 'standalone' ? t('workspaceFlow.moveIntoWorkspace') : t('workspaceFlow.moveConversation')} className="confirmation-dialog" footer={<><DialogClose asChild><Button type="button" variant="quiet" disabled={moving}>{t('common.cancel')}</Button></DialogClose><Button type="button" variant="primary" disabled={!moveTarget || moving} onClick={() => void submitMove()}>{moving ? t('common.saving') : t('workspaceFlow.moveConfirm')}</Button></>}>
      <div className="form-stack">
        <p className="confirmation-dialog-copy">{move?.record?.name}</p>
        {moveDestinations.length ? <label className="field-label"><span>{t('workspaceFlow.moveTarget')}</span><select value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)}>{moveDestinations.map((destination) => <option key={destination.value} value={destination.value}>{destination.label}</option>)}</select></label> : <p className="confirmation-dialog-copy">{t('workspaceFlow.noMoveTarget')}</p>}
        <p className="field-help">{t('workspaceFlow.moveHelp')}</p>
        {error && <p className="form-error">{error}</p>}
      </div>
    </Dialog>
    <button className={`mobile-scrim${open ? ' is-visible' : ''}`} type="button" aria-label={t('sessions.toggleCloseSidebar')} onClick={onClose} />
  </>;
}
