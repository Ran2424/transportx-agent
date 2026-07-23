import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryProject, HistorySession } from '../../public/kernel/commands.js';
import { useAppServices } from './AppProviders';
import { AppShell } from './AppShell';
import { useConversationState, useExtensionUiState, useRuntimeState, useSessionState, useToolExecutionState } from './store-hooks';
import { Header } from '../components/shell/Header';
import { CommandPalette, type CommandItem } from '../platform/commands/CommandPalette';
import { ConversationStage } from '../platform/conversation/ConversationStage';
import { ExtensionDialogLayer } from '../platform/extension-ui/ExtensionDialogLayer';
import { ModelPickerDialog } from '../platform/model/ModelPickerDialog';
import { NewSessionDialog } from '../platform/sessions/NewSessionDialog';
import { LiveTabs } from '../platform/sessions/LiveTabs';
import { SessionSidebar } from '../platform/sessions/SessionSidebar';
import { SettingsDialog, themes, type ThemeId } from '../platform/settings/SettingsDialog';
import { WorkspaceDock, WorkspaceFloat } from '../platform/workspace/WorkspaceDock';
import { projectVisualizations } from '../features/geo/geo-projection';
import { projectTaskState } from '../features/task/task-projection';

function initialTheme(): ThemeId {
  const saved = window.localStorage.getItem('tau-theme');
  if (themes.some((theme) => theme.id === saved)) return saved as ThemeId;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'clean' : 'night';
}

function mostRecentSessionId(sessions: ReturnType<typeof useSessionState>['sessions']) {
  return [...sessions].sort((a, b) => new Date(b.lastConversationAt || b.createdAt || 0).getTime() - new Date(a.lastConversationAt || a.createdAt || 0).getTime())[0]?.id || null;
}

export function App() {
  const { kernel, reconnect } = useAppServices();
  const runtime = useRuntimeState();
  const sessionState = useSessionState();
  const extensionUi = useExtensionUiState();
  const conversation = useConversationState();
  const tools = useToolExecutionState();
  const [theme, setTheme] = useState<ThemeId>(initialTheme);
  const [showThinking, setShowThinking] = useState(() => window.localStorage.getItem('tau-show-thinking') !== 'false');
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 860);
  const [filesOpen, setFilesOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [dismissedRuntimeError, setDismissedRuntimeError] = useState('');
  const restoredRef = useRef(false);

  const activeSession = sessionState.sessions.find((session) => session.id === sessionState.activeSessionId) || null;
  const activeStreaming = !!(activeSession && sessionState.streamingBySession[activeSession.id]);
  const taskState = useMemo(() => activeSession ? projectTaskState(
    conversation.bySession[activeSession.id]?.snapshotEntries ?? [],
    Object.values(tools.bySession[activeSession.id] ?? {}),
  ) : { enabled: false, task: null }, [activeSession, conversation, tools]);
  const taskAvailable = taskState.enabled;
  const visualizations = useMemo(() => activeSession ? projectVisualizations(
    conversation.bySession[activeSession.id]?.snapshotEntries ?? [],
    Object.values(tools.bySession[activeSession.id] ?? {}),
  ) : [], [activeSession, conversation, tools]);
  const visualizationKey = activeSession && visualizations.length
    ? `${activeSession.id}:${visualizations.map((item) => `${item.visualizationId}:${item.revision}`).join(',')}`
    : '';
  const openedMapKey = useRef('');
  const openedTaskSessions = useRef(new Set<string>());

  useEffect(() => {
    if (!visualizationKey || visualizationKey === openedMapKey.current) return;
    openedMapKey.current = visualizationKey;
    setMapOpen(true);
  }, [visualizationKey]);

  useEffect(() => {
    const sessionId = activeSession?.id;
    if (!sessionId || !taskState.task || openedTaskSessions.current.has(sessionId)) return;
    openedTaskSessions.current.add(sessionId);
    setTasksOpen(true);
  }, [activeSession?.id, taskState.task]);

  useEffect(() => { if (!taskAvailable) setTasksOpen(false); }, [taskAvailable]);
  useEffect(() => { if (visualizations.length === 0) setMapOpen(false); }, [visualizations.length]);

  const toggleTasks = useCallback(() => {
    if (taskAvailable) setTasksOpen((value) => !value);
  }, [taskAvailable]);

  const toggleMap = useCallback(() => {
    if (visualizations.length > 0) setMapOpen((value) => !value);
  }, [visualizations.length]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('tau-theme', theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem('tau-show-thinking', String(showThinking));
  }, [showThinking]);

  const refreshLiveSessions = useCallback(async () => {
    try {
      const sessions = await kernel.commands.session.list();
      kernel.dispatch({ type: 'session/listReceived', sessions });
    } catch (cause) {
      setNotice((cause as { message?: string })?.message || '无法读取运行中的任务');
    }
  }, [kernel]);

  useEffect(() => {
    if (runtime.connection !== 'connected') return;
    void refreshLiveSessions();
    const timer = window.setInterval(() => void refreshLiveSessions(), 10_000);
    return () => window.clearInterval(timer);
  }, [refreshLiveSessions, runtime.connection]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && kernel.stores.runtime.get().connection !== 'connected') reconnect();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [kernel, reconnect]);

  const selectSession = useCallback(async (sessionId: string) => {
    const session = kernel.stores.session.get().sessions.find((item) => item.id === sessionId);
    if (!session) return;
    kernel.dispatch({ type: 'session/activated', sessionId });
    window.localStorage.setItem('tau-active-live-session-id', sessionId);
    setSessionLoading(true);
    setNotice('');
    if (window.innerWidth <= 860) setSidebarOpen(false);
    try {
      const snapshot = await kernel.commands.session.loadSnapshot(sessionId);
      kernel.dispatch({ type: 'session/snapshotReceived', sessionId, snapshot });
    } catch (cause) {
      setNotice((cause as { message?: string })?.message || '加载任务快照失败');
    } finally {
      setSessionLoading(false);
    }
  }, [kernel]);

  const goHome = useCallback(() => {
    kernel.dispatch({ type: 'session/activated', sessionId: null });
    window.localStorage.removeItem('tau-active-live-session-id');
    setFilesOpen(false);
    setTasksOpen(false);
    setMapOpen(false);
    setNotice('');
  }, [kernel]);

  useEffect(() => {
    if (restoredRef.current || sessionState.sessions.length === 0) return;
    restoredRef.current = true;
    const saved = window.localStorage.getItem('tau-active-live-session-id');
    const target = saved && sessionState.sessions.some((session) => session.id === saved) ? saved : mostRecentSessionId(sessionState.sessions);
    if (target) void selectSession(target);
  }, [selectSession, sessionState.sessions]);

  async function selectHistory(session: HistorySession, project: HistoryProject) {
    if (!session.filePath) return;
    const live = kernel.stores.session.get().sessions.find((item) => item.sessionFile === session.filePath);
    if (live) {
      await selectSession(live.id);
      return;
    }
    setSessionLoading(true);
    setNotice('');
    try {
      const resumed = await kernel.commands.session.resume({ filePath: session.filePath, ...(project.path ? { cwd: project.path } : {}) });
      kernel.dispatch({ type: 'session/created', session: resumed });
      await selectSession(resumed.id);
    } catch (cause) {
      setNotice((cause as { message?: string })?.message || '恢复会话失败');
    } finally {
      setSessionLoading(false);
    }
  }

  async function closeSession(sessionId: string) {
    const isStreaming = !!kernel.stores.session.get().streamingBySession[sessionId];
    if (isStreaming && !window.confirm('这个交通任务正在执行。确定关闭任务并终止 Pi 会话吗？')) return;
    try {
      await kernel.commands.session.close(sessionId);
      kernel.dispatch({ type: 'session/closed', sessionId });
      if (kernel.stores.session.get().activeSessionId === null) {
        window.localStorage.removeItem('tau-active-live-session-id');
        const next = mostRecentSessionId(kernel.stores.session.get().sessions);
        if (next) await selectSession(next);
      }
    } catch (cause) {
      setNotice((cause as { message?: string })?.message || '关闭任务失败');
    }
  }

  const commandItems = useMemo<CommandItem[]>(() => [
    { id: 'new', label: '新建交通任务', description: '启动独立 Pi RPC 会话', shortcut: '⌘N', action: () => setNewSessionOpen(true) },
    { id: 'files', label: filesOpen ? '关闭文件栏' : '打开文件栏', description: '浏览当前任务的工作目录', shortcut: '⌘⇧W', action: () => setFilesOpen((value) => !value) },
    { id: 'tasks', label: tasksOpen ? '关闭任务面板' : '打开任务面板', description: taskAvailable ? '查看当前任务的执行计划' : '当前任务未开启任务模式', disabled: !taskAvailable, action: toggleTasks },
    { id: 'map', label: mapOpen ? '关闭地图视图' : '打开地图视图', description: visualizations.length ? '聚焦当前任务的 GIS 可视化' : '当前任务暂无地图结果', disabled: visualizations.length === 0, action: toggleMap },
    { id: 'model', label: '切换模型', description: activeSession ? '设置当前任务的模型与思考级别' : '需要先选择运行中的任务', disabled: !activeSession, action: () => setModelOpen(true) },
    { id: 'compact', label: '压缩上下文', description: activeSession ? '请求 Pi 整理当前会话上下文' : '需要先选择运行中的任务', disabled: !activeSession, action: async () => {
      if (!activeSession) return;
      try { await kernel.commands.agent.compact(activeSession.id); setNotice('上下文压缩请求已完成'); }
      catch (cause) { setNotice((cause as { message?: string })?.message || '压缩上下文失败'); }
    } },
    { id: 'settings', label: '工作台设置', description: '主题、Agent 与访问控制', shortcut: '⌘,', action: () => setSettingsOpen(true) },
  ], [activeSession, filesOpen, kernel, mapOpen, taskAvailable, tasksOpen, toggleMap, toggleTasks, visualizations.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        setCommandsOpen(true);
        return;
      }
      if (modifier && event.key.toLocaleLowerCase() === 'n') {
        event.preventDefault();
        setNewSessionOpen(true);
        return;
      }
      if (modifier && event.key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
        return;
      }
      const hasOverlay = newSessionOpen || settingsOpen || modelOpen || commandsOpen || !!extensionUi.current;
      if (event.key === 'Escape' && !hasOverlay) {
        if (mapOpen) {
          setMapOpen(false);
        } else if (tasksOpen) {
          setTasksOpen(false);
        } else if (filesOpen) {
          setFilesOpen(false);
        } else if (window.innerWidth <= 860 && sidebarOpen) {
          setSidebarOpen(false);
        } else if (activeSession && kernel.stores.session.isStreaming(activeSession.id)) {
          void kernel.commands.agent.abort(activeSession.id);
          setNotice('已请求中止当前任务');
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [activeSession, commandsOpen, extensionUi.current, filesOpen, kernel, mapOpen, modelOpen, newSessionOpen, settingsOpen, sidebarOpen, tasksOpen]);

  const pendingDialogSessions = useMemo(() => new Set(extensionUi.queue.flatMap((pending) => pending.sessionId ? [pending.sessionId] : [])), [extensionUi.queue]);
  const runtimeErrorMessage = runtime.lastError?.message || '';
  const runtimeNotice = notice || (runtimeErrorMessage !== dismissedRuntimeError ? runtimeErrorMessage : '');

  return (
    <AppShell
      header={<Header connection={runtime.connection} activeSession={activeSession} streaming={activeStreaming} sidebarOpen={sidebarOpen} fileOpen={filesOpen} taskOpen={tasksOpen} mapOpen={mapOpen} taskAvailable={taskAvailable} mapAvailable={visualizations.length > 0} onToggleSidebar={() => setSidebarOpen((value) => !value)} onToggleFiles={() => setFilesOpen((value) => !value)} onToggleTasks={toggleTasks} onToggleMap={toggleMap} onOpenModel={() => setModelOpen(true)} onOpenCommands={() => setCommandsOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />}
      sidebar={<SessionSidebar open={sidebarOpen} sessions={sessionState.sessions} activeSessionId={sessionState.activeSessionId} onClose={() => setSidebarOpen(false)} onGoHome={goHome} onNewSession={() => setNewSessionOpen(true)} onSelectLive={(id) => void selectSession(id)} onSelectHistory={(session, project) => void selectHistory(session, project)} />}
      tabs={<LiveTabs sessions={sessionState.sessions} activeSessionId={sessionState.activeSessionId} streamingBySession={sessionState.streamingBySession} pendingDialogSessions={pendingDialogSessions} onSelect={(id) => void selectSession(id)} onClose={(id) => void closeSession(id)} onNewSession={() => setNewSessionOpen(true)} />}
      conversation={<ConversationStage session={activeSession} loading={sessionLoading} onNewSession={() => setNewSessionOpen(true)} showThinking={showThinking} />}
      workspace={<WorkspaceDock open={filesOpen} session={activeSession} onClose={() => setFilesOpen(false)} />}
      taskFloat={<WorkspaceFloat kind="tasks" open={tasksOpen} fileOpen={filesOpen} session={activeSession} onClose={() => setTasksOpen(false)} />}
      mapPanel={<WorkspaceFloat kind="map" open={mapOpen} session={activeSession} onClose={() => setMapOpen(false)} />}
      mapOpen={mapOpen}
      overlays={<>
        <NewSessionDialog open={newSessionOpen} onOpenChange={setNewSessionOpen} onCreated={(id) => void selectSession(id)} />
        <ModelPickerDialog open={modelOpen} onOpenChange={setModelOpen} session={activeSession} />
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} theme={theme} onThemeChange={setTheme} showThinking={showThinking} onShowThinkingChange={setShowThinking} session={activeSession} />
        <CommandPalette open={commandsOpen} onOpenChange={setCommandsOpen} commands={commandItems} />
        <ExtensionDialogLayer pending={extensionUi.current} />
        {runtimeNotice ? <div className="runtime-notice" role="status"><span>{runtimeNotice}</span><button type="button" aria-label="关闭状态通知" onClick={() => notice ? setNotice('') : setDismissedRuntimeError(runtimeErrorMessage)}>×</button></div> : null}
      </>}
    />
  );
}
