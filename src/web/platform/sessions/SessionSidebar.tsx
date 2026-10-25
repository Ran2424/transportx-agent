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
  onDefaults(workspace: WorkspaceView): void; onDiagnostics(workspace?: WorkspaceView): void;
};
type Target = { workspace: WorkspaceView; record?: ConversationRecordV1 };
function savedCollapsed() { try { return JSON.parse(window.localStorage.getItem('tau-collapsed-workspaces') || '[]') as string[]; } catch { return []; } }

export function SessionSidebar({ open, dataReady, sessions, workspaces, activeSessionId, historyRevision, onClose, onGoHome, onNewSession, onManageModules, onSelect, onDelete, onDefaults, onDiagnostics }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(''), [searchIds, setSearchIds] = useState<Set<string> | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(savedCollapsed);
  const [capabilityCollapsed, setCapabilityCollapsed] = useState(() => { const saved = window.localStorage.getItem('tau-capability-collapsed'); return saved === null ? window.innerWidth <= 860 : saved === '1'; });
  const [conversationCollapsed, setConversationCollapsed] = useState(() => window.localStorage.getItem('tau-conversation-collapsed') === '1');
  const [menu, setMenu] = useState<(Target & { x: number; y: number }) | null>(null);
  const [rename, setRename] = useState<Target | null>(null), [renameValue, setRenameValue] = useState(''), [saving, setSaving] = useState(false);
  async function refresh() { setLoading(true); try { await appKernel.commands.session.list(); setError(''); } catch (cause) { setError((cause as Error).message); } finally { setLoading(false); } }
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
        <section className={`conversation-section${conversationCollapsed ? ' is-collapsed' : ''}`} aria-label="工作区和会话">
          <header className="sidebar-section-heading"><strong><Icon name="workspace" />工作区</strong><small>{workspaces.length}</small><button className="sidebar-section-toggle" type="button" aria-expanded={!conversationCollapsed} aria-label={conversationCollapsed ? t('sessions.expandConversations') : t('sessions.collapseConversations')} onClick={() => { setConversationCollapsed(!conversationCollapsed); window.localStorage.setItem('tau-conversation-collapsed', conversationCollapsed ? '0' : '1'); }}><Icon name="chevron" /></button></header>
          {!conversationCollapsed && <div className="session-scroll">
            {loading && !workspaces.length && <div className="session-empty">{t('sessions.loadingIndex')}</div>}
            {error && <div className="session-empty is-error">{error}<button type="button" onClick={() => onDiagnostics()}>迁移诊断</button></div>}
            {[...workspaces].sort((left, right) => Math.max(0, ...right.conversations.map((item) => Date.parse(item.lastConversationAt || '') || 0)) - Math.max(0, ...left.conversations.map((item) => Date.parse(item.lastConversationAt || '') || 0))).map((workspace) => {
              const rows = [...workspace.conversations].sort((left, right) => (Date.parse(right.lastConversationAt || '') || 0) - (Date.parse(left.lastConversationAt || '') || 0)).filter(({ record }) => !query.trim() || record.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) || searchIds?.has(record.id));
              if (query.trim() && !rows.length && !workspace.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) return null;
              const expanded = !!query.trim() || !collapsed.includes(workspace.id);
              return <section className="workspace-group" key={workspace.id}>
                <div className="workspace-group-heading">
                  <button type="button" className="workspace-group-name" aria-expanded={expanded} onClick={() => toggleWorkspace(workspace.id)} title={workspace.path}><Icon name="chevron" /><strong>{workspace.name}</strong><small>{workspace.conversations.length}</small></button>
                  {workspace.availability === 'ready' && <button className="icon-button" type="button" aria-label={`在 ${workspace.name} 中新建会话`} onClick={() => onNewSession(workspace)}><Icon name="plus" /></button>}
                  <button className="icon-button" type="button" aria-label={`${workspace.name} 工作区操作`} onClick={(event) => setMenu({ workspace, x: event.clientX, y: event.clientY })}>⋯</button>
                </div>
                {workspace.availability !== 'ready' && <button type="button" className="session-empty is-error" onClick={() => workspace.availability === 'deleting' ? onDelete(workspace) : onDiagnostics(workspace)}>{workspace.availability === 'deleting' ? '删除未完成，点击继续' : `${workspace.availability === 'isolated' ? '已隔离' : '需要迁移处理'} · 查看详情`}</button>}
                {expanded && rows.map(({ record, runtime, lastConversationAt }) => <button className={`session-row${record.id === activeSessionId ? ' is-active' : ''}`} type="button" key={record.id} aria-disabled={record.state === 'deleting'} onClick={() => record.state === 'deleting' ? onDelete(workspace, record) : onSelect(record.id)} onContextMenu={(event) => { event.preventDefault(); setMenu({ workspace, record, x: event.clientX, y: event.clientY }); }}>
                  <span className="session-row-main"><strong>{record.name}</strong><small>{record.state === 'deleting' ? '删除未完成' : record.state === 'start-failed' ? '启动失败' : lastConversationAt ? relativeTime(lastConversationAt) : '尚无对话'}</small></span>
                  {(sessions.find((view) => view.id === record.id)?.isStreaming ?? runtime?.isStreaming) && <span className="session-row-meta"><i className="streaming-beacon" /></span>}
                </button>)}
              </section>;
            })}
            {!loading && !error && !workspaces.length && <div className="session-empty">还没有工作区。新建后可在同一目录保留多个会话。</div>}
          </div>}
        </section>
      </div>
    </aside>
    {menu && <div className="session-context-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.min(menu.y, window.innerHeight - 200) }}>
      {menu.workspace.availability === 'ready' && menu.record?.state !== 'deleting' && <button type="button" role="menuitem" onClick={() => { setRename(menu); setRenameValue(menu.record?.name || menu.workspace.name); setError(''); setMenu(null); }}>重命名{menu.record ? '会话' : '工作区'}</button>}
      {!menu.record && menu.workspace.availability === 'ready' && <button type="button" role="menuitem" onClick={() => { onDefaults(menu.workspace); setMenu(null); }}>编辑新会话默认配置</button>}
      <button type="button" role="menuitem" onClick={() => { onDiagnostics(menu.workspace); setMenu(null); }}>迁移与运行诊断</button>
      {(menu.workspace.availability === 'ready' || menu.workspace.availability === 'deleting') && <button type="button" role="menuitem" onClick={() => { onDelete(menu.workspace, menu.record); setMenu(null); }}>{menu.record ? '删除此会话' : '删除整个工作区'}</button>}
    </div>}
    <Dialog open={!!rename} onOpenChange={(next) => { if (!next && !saving) setRename(null); }} title={rename?.record ? '重命名会话' : '重命名工作区'} className="confirmation-dialog" footer={<><DialogClose asChild><Button type="button" variant="quiet" disabled={saving}>{t('common.cancel')}</Button></DialogClose><Button type="button" variant="primary" disabled={!renameValue.trim() || saving} onClick={() => void saveName()}>{t('common.save')}</Button></>}>
      <label className="field-label"><span>名称</span><input value={renameValue} maxLength={120} autoFocus onChange={(event) => setRenameValue(event.target.value)} /></label>{error && <p className="form-error">{error}</p>}
    </Dialog>
    <button className={`mobile-scrim${open ? ' is-visible' : ''}`} type="button" aria-label={t('sessions.toggleCloseSidebar')} onClick={onClose} />
  </>;
}
