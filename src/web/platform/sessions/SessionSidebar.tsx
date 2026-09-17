import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LiveSession } from '../../../public/app-types.js';
import type { HistoryProject, HistorySession } from '../../../public/kernel/commands.js';
import { appKernel } from '../../app/composition-root';
import { BrandMark } from '../../components/BrandMark';
import { Icon } from '../../components/icons';
import { Button } from '../../components/ui/button';
import { Dialog, DialogClose } from '../../components/ui/dialog';
import { relativeTime, sessionTitle } from '../../lib/formatting';
import { CapabilityPane } from '../capabilities/CapabilityPane';
import i18n from '../../i18n';

type SessionSidebarProps = {
  open: boolean;
  sessions: LiveSession[];
  activeSessionId: string | null;
  historyRevision: number;
  onClose(): void;
  onGoHome(): void;
  onNewSession(): void;
  onSelectLive(sessionId: string): void;
  onSelectHistory(session: HistorySession, project: HistoryProject): void;
  onDeleteLive(session: LiveSession): Promise<void>;
  onDeleteHistory(session: HistorySession): Promise<void>;
  onRenameLive(session: LiveSession, name: string): Promise<void>;
  onRenameHistory(session: HistorySession, name: string): Promise<void>;
};

function historyTitle(session: HistorySession) {
  return session.sessionName || session.name || session.firstMessage || i18n.t('sessions.emptyTask');
}

function isScenarioSession(cwd?: string) {
  return /\/scenario(?:\/|$)/i.test((cwd || '').replace(/\\/g, '/'));
}

function timestampValue(value?: string) {
  const timestamp = new Date(value || '').getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

type SidebarSession = {
  key: string;
  title: string;
  timestamp?: string;
  live?: LiveSession;
  history?: HistorySession;
  project?: HistoryProject;
};

function initialCapabilityCollapsed() {
  if (typeof window === 'undefined') return false;
  const saved = window.localStorage.getItem('tau-capability-collapsed');
  if (saved !== null) return saved === '1';
  return window.innerWidth <= 860;
}

function initialConversationCollapsed() {
  return typeof window !== 'undefined' && window.localStorage.getItem('tau-conversation-collapsed') === '1';
}

export function SessionSidebar({
  open,
  sessions,
  activeSessionId,
  historyRevision,
  onClose,
  onGoHome,
  onNewSession,
  onSelectLive,
  onSelectHistory,
  onDeleteLive,
  onDeleteHistory,
  onRenameLive,
  onRenameHistory,
}: SessionSidebarProps) {
  const { t } = useTranslation();
  const kernel = appKernel;
  const [projects, setProjects] = useState<HistoryProject[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState('');
  const [capabilityCollapsed, setCapabilityCollapsed] = useState(initialCapabilityCollapsed);
  const [conversationCollapsed, setConversationCollapsed] = useState(initialConversationCollapsed);
  const [contextMenu, setContextMenu] = useState<{ item: SidebarSession; x: number; y: number } | null>(null);
  const [renameTarget, setRenameTarget] = useState<SidebarSession | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState('');
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (event?: PointerEvent) => {
      if (event?.target instanceof Element && event.target.closest('.session-context-menu')) return;
      setContextMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', onKeyDown); };
  }, [contextMenu]);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    kernel.commands.session.listHistory()
      .then((next) => { if (current) setProjects(next); })
      .catch(() => { if (current) setError(t('sessions.loadFailed')); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [historyRevision, kernel, refreshKey, t]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const scenarioSessions = useMemo(() => {
    const liveSessions = sessions.filter((session) => isScenarioSession(session.cwd));
    const liveFiles = new Set(liveSessions.map((session) => session.sessionFile).filter(Boolean));
    const items: SidebarSession[] = liveSessions.map((session) => ({
      key: `live:${session.id}`,
      title: sessionTitle(session),
      timestamp: session.lastConversationAt || session.createdAt,
      live: session,
    }));

    projects
      .filter((project) => isScenarioSession(project.path))
      .forEach((project) => {
        (project.sessions || []).forEach((session) => {
          if (session.filePath && liveFiles.has(session.filePath)) return;
          const lastConversationAt = session.lastConversationAt || session.timestamp || session.sessionTimestamp;
          items.push({
            key: `history:${session.filePath || `${project.path}:${historyTitle(session)}`}`,
            title: historyTitle(session),
            timestamp: lastConversationAt,
            history: session,
            project,
          });
        });
      });

    return items
      .filter((item) => !normalizedQuery || item.title.toLocaleLowerCase().includes(normalizedQuery))
      .sort((a, b) => timestampValue(b.timestamp) - timestampValue(a.timestamp));
  }, [projects, sessions, normalizedQuery]);

  const toggleCapability = () => {
    setCapabilityCollapsed((value) => {
      const next = !value;
      window.localStorage.setItem('tau-capability-collapsed', next ? '1' : '0');
      return next;
    });
  };

  const toggleConversation = () => {
    setConversationCollapsed((value) => {
      const next = !value;
      window.localStorage.setItem('tau-conversation-collapsed', next ? '1' : '0');
      return next;
    });
  };

  async function deleteConversation() {
    const item = contextMenu?.item;
    setContextMenu(null);
    if (!item) return;
    if (item.live) await onDeleteLive(item.live);
    else if (item.history) await onDeleteHistory(item.history);
  }

  function beginRename() {
    const item = contextMenu?.item;
    setContextMenu(null);
    if (!item) return;
    setRenameTarget(item);
    setRenameValue(item.title);
    setRenameError('');
  }

  async function renameConversation() {
    const item = renameTarget;
    const name = renameValue.trim();
    if (!item || !name || renaming) return;
    setRenaming(true); setRenameError('');
    try {
      if (item.live) await onRenameLive(item.live, name);
      else if (item.history) await onRenameHistory(item.history, name);
      setRenameTarget(null);
    } catch (cause) {
      setRenameError((cause as Error).message || t('sessions.renameFailed'));
    } finally {
      setRenaming(false);
    }
  }

  return (
    <>
      <aside className={`session-sidebar${open ? ' is-open' : ''}`} aria-label={t('sessions.sidebar')} data-testid="session-sidebar">
        <div className="sidebar-tools">
          <button className="sidebar-home-mark" type="button" aria-label={t('sessions.goHome')} onClick={onGoHome}>
            <BrandMark className="sidebar-home-icon" />
          </button>
          <label className="sidebar-search">
            <Icon name="search" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('sessions.searchPlaceholder')} aria-label={t('sessions.search')} />
          </label>
          <button className="icon-button accent-button" type="button" aria-label={t('sessions.newTask')} onClick={onNewSession}><Icon name="plus" /></button>
          <button className="icon-button" type="button" aria-label={t('sessions.refresh')} onClick={() => setRefreshKey((value) => value + 1)}><Icon name="refresh" /></button>
          <button className="icon-button mobile-only" type="button" aria-label={t('sessions.closeSidebar')} onClick={onClose}><Icon name="close" /></button>
        </div>

        <div className="sidebar-split">
          <CapabilityPane collapsed={capabilityCollapsed} onToggleCollapsed={toggleCapability} />
          <section className={`conversation-section${conversationCollapsed ? ' is-collapsed' : ''}`} aria-label={t('sessions.conversationList')}>
            <header className="sidebar-section-heading"><strong><Icon name="workspace" />{t('sessions.conversations')}</strong>{scenarioSessions.length ? <small>{scenarioSessions.length}</small> : null}<button className="sidebar-section-toggle" type="button" aria-expanded={!conversationCollapsed} aria-label={conversationCollapsed ? t('sessions.expandConversations') : t('sessions.collapseConversations')} onClick={toggleConversation}><Icon name="chevron" /></button></header>
            {!conversationCollapsed ? <div className="session-scroll">
              {loading ? <div className="session-empty">{t('sessions.loadingIndex')}</div> : null}
              {error ? <div className="session-empty is-error">{error}</div> : null}
              {!loading && !error && scenarioSessions.map((item) => (
                <button
                  className={`session-row${item.live?.id === activeSessionId ? ' is-active' : ''}`}
                  type="button"
                  key={item.key}
                  onClick={() => item.live ? onSelectLive(item.live.id) : onSelectHistory(item.history!, item.project!)}
                  onContextMenu={(event) => { event.preventDefault(); setContextMenu({ item, x: event.clientX, y: event.clientY }); }}
                >
                  <span className="session-row-main"><strong>{item.title}</strong><small>{relativeTime(item.timestamp)}</small></span>
                  {item.live?.isStreaming ? <span className="session-row-meta"><i className="streaming-beacon" /></span> : null}
                </button>
              ))}
              {!loading && !error && scenarioSessions.length === 0 ? <div className="session-empty">{t('sessions.emptyScenario')}</div> : null}
            </div> : null}
          </section>
        </div>

      </aside>
      {contextMenu ? <div className="session-context-menu" role="menu" style={{ left: Math.min(contextMenu.x, window.innerWidth - 176), top: Math.min(contextMenu.y, window.innerHeight - 84) }}><button type="button" role="menuitem" onClick={beginRename}>{t('sessions.renameConversation')}</button><button type="button" role="menuitem" onClick={() => void deleteConversation()}>{t('sessions.deleteConversation')}</button></div> : null}
      <Dialog open={!!renameTarget} onOpenChange={(next) => { if (!next && !renaming) setRenameTarget(null); }} title={t('sessions.renameConversation')} className="confirmation-dialog" footer={<><DialogClose asChild><Button type="button" variant="quiet" disabled={renaming}>{t('common.cancel')}</Button></DialogClose><Button type="button" variant="primary" disabled={!renameValue.trim() || renaming} onClick={() => void renameConversation()}>{renaming ? t('common.saving') : t('common.save')}</Button></>}>
        <label className="field-label"><span>{t('sessions.taskName')}</span><input value={renameValue} maxLength={120} autoFocus onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void renameConversation(); } }} /></label>
        {renameError ? <p className="form-error">{renameError}</p> : null}
      </Dialog>
      <button className={`mobile-scrim${open ? ' is-visible' : ''}`} type="button" aria-label={t('sessions.toggleCloseSidebar')} onClick={onClose} />
    </>
  );
}
