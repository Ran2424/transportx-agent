import { useEffect, useMemo, useState } from 'react';
import type { LiveSession } from '../../../public/app-types.js';
import type { HistoryProject, HistorySession } from '../../../public/kernel/commands.js';
import { useAppServices } from '../../app/AppProviders';
import { BrandMark } from '../../components/BrandMark';
import { Icon } from '../../components/icons';
import { relativeTime, sessionTitle } from '../../lib/formatting';
import { CapabilityPane } from '../capabilities/CapabilityPane';

type SessionSidebarProps = {
  open: boolean;
  sessions: LiveSession[];
  activeSessionId: string | null;
  onClose(): void;
  onGoHome(): void;
  onNewSession(): void;
  onSelectLive(sessionId: string): void;
  onSelectHistory(session: HistorySession, project: HistoryProject): void;
};

function historyTitle(session: HistorySession) {
  return session.sessionName || session.name || session.firstMessage || '空会话';
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

export function SessionSidebar({
  open,
  sessions,
  activeSessionId,
  onClose,
  onGoHome,
  onNewSession,
  onSelectLive,
  onSelectHistory,
}: SessionSidebarProps) {
  const { kernel } = useAppServices();
  const [projects, setProjects] = useState<HistoryProject[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState('');
  const [capabilityCollapsed, setCapabilityCollapsed] = useState(initialCapabilityCollapsed);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    kernel.commands.session.listHistory()
      .then((next) => { if (current) setProjects(next); })
      .catch(() => { if (current) setError('会话加载失败'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [kernel, refreshKey]);

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

  return (
    <>
      <aside className={`session-sidebar${open ? ' is-open' : ''}`} aria-label="会话侧栏" data-testid="session-sidebar">
        <div className="sidebar-tools">
          <button className="sidebar-home-mark" type="button" aria-label="返回主页" onClick={onGoHome}>
            <BrandMark className="sidebar-home-icon" />
          </button>
          <label className="sidebar-search">
            <Icon name="search" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话…" aria-label="搜索会话" />
          </label>
          <button className="icon-button accent-button" type="button" aria-label="新建交通任务" onClick={onNewSession}><Icon name="plus" /></button>
          <button className="icon-button" type="button" aria-label="刷新会话" onClick={() => setRefreshKey((value) => value + 1)}><Icon name="refresh" /></button>
          <button className="icon-button mobile-only" type="button" aria-label="关闭侧栏" onClick={onClose}><Icon name="close" /></button>
        </div>

        <div className="sidebar-split">
          <CapabilityPane collapsed={capabilityCollapsed} onToggleCollapsed={toggleCapability} />
          <section className="conversation-section" aria-label="对话列表">
            <header className="sidebar-section-heading"><strong>对话</strong>{scenarioSessions.length ? <small>{scenarioSessions.length}</small> : null}</header>
            <div className="session-scroll">
              {loading ? <div className="session-empty">正在读取会话索引…</div> : null}
              {error ? <div className="session-empty is-error">{error}</div> : null}
              {!loading && !error && scenarioSessions.map((item) => (
                <button
                  className={`session-row${item.live?.id === activeSessionId ? ' is-active' : ''}`}
                  type="button"
                  key={item.key}
                  onClick={() => item.live ? onSelectLive(item.live.id) : onSelectHistory(item.history!, item.project!)}
                >
                  <span className="session-row-main"><strong>{item.title}</strong><small>{relativeTime(item.timestamp)}</small></span>
                  {item.live?.isStreaming ? <span className="session-row-meta"><i className="streaming-beacon" /></span> : null}
                </button>
              ))}
              {!loading && !error && scenarioSessions.length === 0 ? <div className="session-empty">暂无场景会话。新建任务后，它会出现在这里。</div> : null}
            </div>
          </section>
        </div>

      </aside>
      <button className={`mobile-scrim${open ? ' is-visible' : ''}`} type="button" aria-label="关闭会话侧栏" onClick={onClose} />
    </>
  );
}
