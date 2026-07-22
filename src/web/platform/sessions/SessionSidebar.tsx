import { useEffect, useMemo, useState } from 'react';
import type { LiveSession } from '../../../public/app-types.js';
import type { HistoryProject, HistorySearchResult, HistorySession } from '../../../public/kernel/commands.js';
import { useAppServices } from '../../app/AppProviders';
import { Icon } from '../../components/icons';
import { basename, relativeTime, sessionTitle } from '../../lib/formatting';

type SessionSidebarProps = {
  open: boolean;
  sessions: LiveSession[];
  activeSessionId: string | null;
  onClose(): void;
  onNewSession(): void;
  onSelectLive(sessionId: string): void;
  onSelectHistory(session: HistorySession, project: HistoryProject): void;
};

function historyTitle(session: HistorySession) {
  return session.sessionName || session.name || session.firstMessage || '空会话';
}

export function SessionSidebar({
  open,
  sessions,
  activeSessionId,
  onClose,
  onNewSession,
  onSelectLive,
  onSelectHistory,
}: SessionSidebarProps) {
  const { kernel } = useAppServices();
  const [projects, setProjects] = useState<HistoryProject[]>([]);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<HistorySearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState('');

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

  useEffect(() => {
    if (query.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      kernel.commands.session.searchHistory(query)
        .then((results) => { if (current) setSearchResults(results); })
        .catch(() => { if (current) setSearchResults([]); });
    }, 300);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [kernel, query]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredProjects = useMemo(() => projects.map((project) => ({
    ...project,
    sessions: (project.sessions || []).filter((session) => !normalizedQuery || historyTitle(session).toLocaleLowerCase().includes(normalizedQuery)),
  })).filter((project) => (project.sessions?.length || 0) > 0), [projects, normalizedQuery]);

  return (
    <>
      <aside className={`session-sidebar${open ? ' is-open' : ''}`} aria-label="会话侧栏" data-testid="session-sidebar">
        <div className="sidebar-tools">
          <a className="sidebar-home-mark" href="/" aria-label="Pi Traffic 工作台">τ</a>
          <label className="sidebar-search">
            <Icon name="search" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话…" aria-label="搜索会话" />
          </label>
          <button className="icon-button accent-button" type="button" aria-label="新建交通任务" onClick={onNewSession}><Icon name="plus" /></button>
          <button className="icon-button" type="button" aria-label="刷新会话" onClick={() => setRefreshKey((value) => value + 1)}><Icon name="refresh" /></button>
          <button className="icon-button mobile-only" type="button" aria-label="关闭侧栏" onClick={onClose}><Icon name="close" /></button>
        </div>

        <div className="session-scroll">
          {sessions.length > 0 ? (
            <section className="session-group">
              <div className="session-group-title"><span className="live-beacon" />运行中 <small>{sessions.length}</small></div>
              {sessions.map((session) => (
                <button
                  className={`session-row${session.id === activeSessionId ? ' is-active' : ''}`}
                  type="button"
                  key={session.id}
                  onClick={() => onSelectLive(session.id)}
                >
                  <span className="session-row-main"><strong>{sessionTitle(session)}</strong><small>{basename(session.cwd || '')}</small></span>
                  <span className="session-row-meta">{session.isStreaming ? <i className="streaming-beacon" /> : null}{relativeTime(session.lastActiveAt || session.createdAt)}</span>
                </button>
              ))}
            </section>
          ) : null}

          {searchResults.length > 0 ? (
            <section className="session-group search-result-group">
              <div className="session-group-title">消息匹配 <small>{searchResults.length}</small></div>
              {searchResults.map((result) => (
                <button
                  className="session-row"
                  type="button"
                  key={`search:${result.filePath}`}
                  onClick={() => onSelectHistory(result, { path: result.project })}
                >
                  <span className="session-row-main"><strong>{historyTitle(result)}</strong><small>{result.matches?.[0]?.snippet || result.project}</small></span>
                </button>
              ))}
            </section>
          ) : null}

          {loading ? <div className="session-empty">正在读取会话索引…</div> : null}
          {error ? <div className="session-empty is-error">{error}</div> : null}
          {!loading && !error && filteredProjects.map((project) => (
            <details className="session-group" open key={project.dirName || project.path}>
              <summary className="session-group-title">
                <Icon name="chevron" />
                <span title={project.path}>{basename(project.path || '')}</span>
                <small>{project.sessions?.length || 0}</small>
              </summary>
              {(project.sessions || []).map((session) => (
                <button
                  className="session-row"
                  type="button"
                  key={session.filePath}
                  onClick={() => onSelectHistory(session, project)}
                >
                  <span className="session-row-main"><strong>{historyTitle(session)}</strong><small>{relativeTime(session.timestamp || session.sessionTimestamp)}</small></span>
                  {session.live ? <span className="session-live-tag">LIVE</span> : null}
                </button>
              ))}
            </details>
          ))}
          {!loading && !error && sessions.length === 0 && filteredProjects.length === 0 ? <div className="session-empty">暂无会话。新建任务后，它会出现在这里。</div> : null}
        </div>

      </aside>
      <button className={`mobile-scrim${open ? ' is-visible' : ''}`} type="button" aria-label="关闭会话侧栏" onClick={onClose} />
    </>
  );
}
