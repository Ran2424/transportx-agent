import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryProject, HistorySession } from '../../public/kernel/commands.js';
import { appKernel, reconnectBrowserApplication } from './composition-root';
import { AppShell } from './AppShell';
import { useConversationState, useExtensionUiState, useRuntimeState, useSessionState, useToolExecutionState } from './store-hooks';
import { Header } from '../components/shell/Header';
import { ConfirmationDialog } from '../components/ui/confirmation-dialog';
import { CommandPalette, type CommandItem } from '../platform/commands/CommandPalette';
import { ConversationStage } from '../platform/conversation/ConversationStage';
import { ExtensionDialogLayer } from '../platform/extension-ui/ExtensionDialogLayer';
import { ModelPickerDialog } from '../platform/model/ModelPickerDialog';
import { ModelSetupDialog } from '../platform/model/ModelSetupDialog';
import { NewSessionDialog } from '../platform/sessions/NewSessionDialog';
import { LiveTabs } from '../platform/sessions/LiveTabs';
import { SessionSidebar } from '../platform/sessions/SessionSidebar';
import { SettingsPage, themes, type SettingsSectionId, type ThemeId } from '../platform/settings/SettingsDialog';
import { WorkspaceDock, WorkspaceFloat } from '../platform/workspace/WorkspaceDock';
import { AgentCanvas } from '../platform/canvas/AgentCanvas';
import { projectCanvasItems } from '../platform/canvas/canvas-projection';
import { INITIAL_CANVAS_STATE, reduceCanvasState, type CanvasItemKind } from '../platform/canvas/canvas-state';
import { projectTaskState } from '../features/task/task-projection';

const LEGACY_THEME_MIGRATION: Record<string, ThemeId> = {
  clean: 'light',
  night: 'dark',
  dawn: 'dark',
  midnight: 'dark',
  terracotta: 'sand',
  sage: 'light',
};

function initialTheme(): ThemeId {
  const saved = window.localStorage.getItem('tau-theme');
  if (saved) {
    if (themes.some((theme) => theme.id === saved)) return saved as ThemeId;
    const migrated = LEGACY_THEME_MIGRATION[saved];
    if (migrated) return migrated;
  }
  // New installs keep the TransportX brand first impression: Sand.
  return 'sand';
}

function mostRecentSessionId(sessions: ReturnType<typeof useSessionState>['sessions']) {
  return [...sessions].sort((a, b) => new Date(b.lastConversationAt || b.createdAt || 0).getTime() - new Date(a.lastConversationAt || a.createdAt || 0).getTime())[0]?.id || null;
}

export function App() {
  const { t } = useTranslation();
  const kernel = appKernel; const reconnect = reconnectBrowserApplication;
  const runtime = useRuntimeState();
  const sessionState = useSessionState();
  const extensionUi = useExtensionUiState();
  const conversation = useConversationState();
  const tools = useToolExecutionState();
  const [theme, setTheme] = useState<ThemeId>(initialTheme);
  const [showThinking, setShowThinking] = useState(() => window.localStorage.getItem('tau-show-thinking') !== 'false');
  const [expandThinking, setExpandThinking] = useState(() => window.localStorage.getItem('tau-expand-thinking') === 'true');
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 860);
  const [filesOpen, setFilesOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [canvasState, dispatchCanvas] = useReducer(reduceCanvasState, INITIAL_CANVAS_STATE);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('general');
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSetupOpen, setModelSetupOpen] = useState(false);
  const [modelSetupOrigin, setModelSetupOrigin] = useState<'new' | 'picker' | 'settings' | null>(null);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ kind: 'live'; session: typeof sessionState.sessions[number] } | { kind: 'history'; session: HistorySession } | null>(null);
  const [dismissedRuntimeError, setDismissedRuntimeError] = useState('');
  const restoredRef = useRef(false);

  const activeSession = sessionState.sessions.find((session) => session.id === sessionState.activeSessionId) || null;
  const deleteTargetName = deleteTarget
    ? deleteTarget.kind === 'live'
      ? deleteTarget.session.sessionName || deleteTarget.session.id
      : deleteTarget.session.sessionName || deleteTarget.session.name || t('sessions.emptyTask')
    : '';
  const activeStreaming = !!(activeSession && sessionState.streamingBySession[activeSession.id]);
  const activeCompacting = !!(activeSession && sessionState.compactingBySession[activeSession.id]);
  const taskState = useMemo(() => activeSession ? projectTaskState(
    conversation.bySession[activeSession.id]?.snapshotEntries ?? [],
    Object.values(tools.bySession[activeSession.id] ?? {}),
  ) : { enabled: false, task: null }, [activeSession, conversation, tools]);
  const taskAvailable = taskState.enabled;
  const canvasItems = useMemo(() => activeSession ? projectCanvasItems(
    conversation.bySession[activeSession.id]?.snapshotEntries ?? [],
    Object.values(tools.bySession[activeSession.id] ?? {}),
  ) : [], [activeSession, conversation, tools]);
  const canvasKey = activeSession && canvasItems.length
    ? `${activeSession.id}:${canvasItems.map((item) => `${item.id}:${item.revision}`).join(',')}`
    : '';
  const publishedCanvasKey = useRef('');
  const openedTaskSessions = useRef(new Set<string>());
  const activeCanvasItem = canvasState.items.find((item) => item.id === canvasState.activeItemId) ?? null;
  const mapAvailable = canvasItems.some((item) => item.kind === 'geo');
  const videoAvailable = canvasItems.some((item) => item.kind === 'video');
  const mapOpen = canvasState.isOpen && activeCanvasItem?.kind === 'geo';
  const videoOpen = canvasState.isOpen && activeCanvasItem?.kind === 'video';

  function openModelSetup(origin: 'new' | 'picker' | 'settings') {
    setModelSetupOrigin(origin);
    if (origin === 'new') setNewSessionOpen(false);
    if (origin === 'picker') setModelOpen(false);
    if (origin === 'settings') setSettingsOpen(false);
    setModelSetupOpen(true);
  }

  function changeModelSetupOpen(open: boolean) {
    setModelSetupOpen(open);
    if (open) return;
    if (modelSetupOrigin === 'new') setNewSessionOpen(true);
    if (modelSetupOrigin === 'picker') setModelOpen(true);
    if (modelSetupOrigin === 'settings') setSettingsOpen(true);
    setModelSetupOrigin(null);
  }

  useEffect(() => {
    const openLatest = !!canvasKey && canvasKey !== publishedCanvasKey.current;
    if (openLatest) publishedCanvasKey.current = canvasKey;
    if (!canvasKey) publishedCanvasKey.current = '';
    dispatchCanvas({ type: 'itemsSynced', items: canvasItems, openLatest });
  }, [canvasItems, canvasKey]);

  const waitingGeoRequest = activeSession ? sessionState.geoInteractionBySession[activeSession.id]?.waitingRequest : undefined;
  useEffect(() => {
    if (!waitingGeoRequest) return;
    const item = canvasItems.find((candidate) => candidate.kind === 'geo' && candidate.resourceId === waitingGeoRequest.visualizationId);
    if (!item) return;
    dispatchCanvas({ type: 'itemsSynced', items: canvasItems, openLatest: false });
    dispatchCanvas({ type: 'itemActivated', itemId: item.id });
  }, [canvasItems, waitingGeoRequest?.requestId, waitingGeoRequest?.visualizationId]);

  useEffect(() => {
    const sessionId = activeSession?.id;
    if (!sessionId || !taskState.task || openedTaskSessions.current.has(sessionId)) return;
    openedTaskSessions.current.add(sessionId);
    setTasksOpen(true);
  }, [activeSession?.id, taskState.task]);

  useEffect(() => { if (!taskAvailable) setTasksOpen(false); }, [taskAvailable]);
  const toggleTasks = useCallback(() => {
    if (taskAvailable) setTasksOpen((value) => !value);
  }, [taskAvailable]);

  const toggleCanvasItem = useCallback((kind: CanvasItemKind) => {
    const item = canvasItems.find((candidate) => candidate.kind === kind);
    if (!item) return;
    if (canvasState.isOpen && activeCanvasItem?.id === item.id) {
      dispatchCanvas({ type: 'closed' });
      return;
    }
    dispatchCanvas({ type: 'itemsSynced', items: canvasItems, openLatest: false });
    dispatchCanvas({ type: 'itemActivated', itemId: item.id });
  }, [activeCanvasItem?.id, canvasItems, canvasState.isOpen]);

  const toggleMap = useCallback(() => toggleCanvasItem('geo'), [toggleCanvasItem]);
  const toggleVideo = useCallback(() => toggleCanvasItem('video'), [toggleCanvasItem]);

  const toggleSidebar = useCallback(() => setSidebarOpen((value) => !value), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const toggleFiles = useCallback(() => setFilesOpen((value) => !value), []);
  const closeFiles = useCallback(() => setFilesOpen(false), []);
  const closeCanvas = useCallback(() => dispatchCanvas({ type: 'closed' }), []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('tau-theme', theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem('tau-show-thinking', String(showThinking));
  }, [showThinking]);

  useEffect(() => {
    window.localStorage.setItem('tau-expand-thinking', String(expandThinking));
  }, [expandThinking]);

  const refreshLiveSessions = useCallback(async () => {
    try {
      const sessions = await kernel.commands.session.list();
      kernel.dispatch({ type: 'session/listReceived', sessions });
    } catch (cause) {
      setNotice((cause as { message?: string })?.message || t('app.error.loadLiveSessions'));
    }
  }, [kernel, t]);

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
    if (window.innerWidth <= 860) closeSidebar();
    try {
      const snapshot = await kernel.commands.session.loadSnapshot(sessionId);
      kernel.dispatch({ type: 'session/snapshotReceived', sessionId, snapshot });
    } catch (cause) {
      setNotice((cause as { message?: string })?.message || t('app.error.loadSnapshot'));
    } finally {
      setSessionLoading(false);
    }
  }, [closeSidebar, kernel, t]);

  const goHome = useCallback(() => {
    kernel.dispatch({ type: 'session/activated', sessionId: null });
    window.localStorage.removeItem('tau-active-live-session-id');
    closeFiles();
    setTasksOpen(false);
    dispatchCanvas({ type: 'closed' });
    setNotice('');
  }, [closeFiles, kernel]);

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
      if ((cause as { code?: string })?.code === 'legacy_plan_requires_confirmation' && window.confirm(t('app.confirm.resumeCurrentConfiguration'))) {
        try {
          const resumed = await kernel.commands.session.resume({ filePath: session.filePath, ...(project.path ? { cwd: project.path } : {}), useCurrentConfiguration: true });
          kernel.dispatch({ type: 'session/created', session: resumed });
          await selectSession(resumed.id);
          return;
        } catch (retryCause) {
          setNotice((retryCause as { message?: string })?.message || t('app.error.resumeSession'));
          return;
        }
      }
      setNotice((cause as { message?: string })?.message || t('app.error.resumeSession'));
    } finally {
      setSessionLoading(false);
    }
  }

  async function closeSession(sessionId: string) {
    const isStreaming = !!kernel.stores.session.get().streamingBySession[sessionId];
    if (isStreaming && !window.confirm(t('app.confirm.closeStreaming'))) return;
    try {
      await kernel.commands.session.close(sessionId);
      kernel.dispatch({ type: 'session/closed', sessionId });
      if (kernel.stores.session.get().activeSessionId === null) {
        window.localStorage.removeItem('tau-active-live-session-id');
        const next = mostRecentSessionId(kernel.stores.session.get().sessions);
        if (next) await selectSession(next);
      }
    } catch (cause) {
      setNotice((cause as { message?: string })?.message || t('app.error.closeSession'));
    }
  }

  async function deleteLiveSession(session: typeof sessionState.sessions[number]) {
    setDeleteTarget({ kind: 'live', session });
  }

  async function deleteHistorySession(session: HistorySession) {
    if (session.filePath) setDeleteTarget({ kind: 'history', session });
  }

  async function confirmDeleteSession() {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    try {
      if (target.kind === 'live') {
        await kernel.commands.session.close(target.session.id);
        kernel.dispatch({ type: 'session/closed', sessionId: target.session.id });
        if (target.session.sessionFile) await kernel.commands.session.deleteHistory(target.session.sessionFile);
        if (kernel.stores.session.get().activeSessionId === null) {
          window.localStorage.removeItem('tau-active-live-session-id');
          const next = mostRecentSessionId(kernel.stores.session.get().sessions);
          if (next) await selectSession(next);
        }
      } else if (target.session.filePath) {
        await kernel.commands.session.deleteHistory(target.session.filePath);
      }
    } catch (cause) {
      setNotice((cause as { message?: string })?.message || t('app.error.deleteSession'));
    }
  }

  const commandItems = useMemo<CommandItem[]>(() => [
    { id: 'new', label: t('app.command.new.label'), description: t('app.command.new.description'), shortcut: '⌘N', action: () => setNewSessionOpen(true) },
    { id: 'files', label: filesOpen ? t('app.command.files.close') : t('app.command.files.open'), description: t('app.command.files.description'), shortcut: '⌘⇧W', action: toggleFiles },
    { id: 'tasks', label: tasksOpen ? t('app.command.tasks.close') : t('app.command.tasks.open'), description: taskAvailable ? t('app.command.tasks.description') : t('app.command.tasks.unavailable'), disabled: !taskAvailable, action: toggleTasks },
    { id: 'map', label: mapOpen ? t('app.command.map.close') : t('app.command.map.open'), description: mapAvailable ? t('app.command.map.description') : t('app.command.map.unavailable'), disabled: !mapAvailable, action: toggleMap },
    { id: 'video', label: videoOpen ? t('app.command.video.close') : t('app.command.video.open'), description: videoAvailable ? t('app.command.video.description') : t('app.command.video.unavailable'), disabled: !videoAvailable, action: toggleVideo },
    { id: 'model', label: t('app.command.model.label'), description: activeSession ? t('app.command.model.description') : t('app.command.requiresSession'), disabled: !activeSession, action: () => setModelOpen(true) },
    { id: 'compact', label: t('app.command.compact.label'), description: activeSession ? t('app.command.compact.description') : t('app.command.requiresSession'), disabled: !activeSession || activeStreaming || activeCompacting, action: async () => {
      if (!activeSession) return;
      try { await kernel.commands.agent.compact(activeSession.id); setNotice(t('app.notice.compacted')); }
      catch (cause) { setNotice((cause as { message?: string })?.message || t('app.error.compact')); }
    } },
    { id: 'settings', label: t('app.command.settings.label'), description: t('app.command.settings.description'), shortcut: '⌘,', action: () => setSettingsOpen(true) },
  ], [activeCompacting, activeSession, activeStreaming, filesOpen, kernel, mapAvailable, mapOpen, t, taskAvailable, tasksOpen, toggleFiles, toggleMap, toggleTasks, toggleVideo, videoAvailable, videoOpen]);

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
      if (event.key === 'Escape' && settingsOpen) {
        setSettingsOpen(false);
        return;
      }
      const hasOverlay = newSessionOpen || modelOpen || modelSetupOpen || commandsOpen || !!extensionUi.current;
      if (event.key === 'Escape' && !hasOverlay) {
        if (canvasState.isOpen) {
          closeCanvas();
        } else if (tasksOpen) {
          setTasksOpen(false);
        } else if (filesOpen) {
          closeFiles();
        } else if (window.innerWidth <= 860 && sidebarOpen) {
          closeSidebar();
        } else if (activeSession && kernel.stores.session.isStreaming(activeSession.id)) {
          void kernel.commands.agent.abort(activeSession.id);
          setNotice(t('app.notice.aborted'));
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [activeSession, canvasState.isOpen, closeCanvas, closeFiles, closeSidebar, commandsOpen, extensionUi.current, filesOpen, kernel, modelOpen, modelSetupOpen, newSessionOpen, settingsOpen, sidebarOpen, t, tasksOpen]);

  const pendingDialogSessions = useMemo(() => new Set(extensionUi.queue.flatMap((pending) => pending.sessionId ? [pending.sessionId] : [])), [extensionUi.queue]);
  const runtimeErrorMessage = runtime.lastError?.message || '';
  const runtimeNotice = notice || (runtimeErrorMessage !== dismissedRuntimeError ? runtimeErrorMessage : '');

  return (
    <AppShell
      header={<Header connection={runtime.connection} activeSession={activeSession} streaming={activeStreaming} sidebarOpen={sidebarOpen} fileOpen={filesOpen} taskOpen={tasksOpen} mapOpen={mapOpen} taskAvailable={taskAvailable} mapAvailable={mapAvailable} videoOpen={videoOpen} videoAvailable={videoAvailable} onToggleSidebar={toggleSidebar} onToggleFiles={toggleFiles} onToggleTasks={toggleTasks} onToggleMap={toggleMap} onToggleVideo={toggleVideo} onGoHome={goHome} onOpenModel={() => setModelOpen(true)} onOpenCommands={() => setCommandsOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />}
      sidebar={<SessionSidebar open={sidebarOpen} sessions={sessionState.sessions} activeSessionId={sessionState.activeSessionId} onClose={closeSidebar} onGoHome={goHome} onNewSession={() => setNewSessionOpen(true)} onSelectLive={(id) => void selectSession(id)} onSelectHistory={(session, project) => void selectHistory(session, project)} onDeleteLive={deleteLiveSession} onDeleteHistory={deleteHistorySession} />}
      tabs={<LiveTabs sessions={sessionState.sessions} activeSessionId={sessionState.activeSessionId} streamingBySession={sessionState.streamingBySession} pendingDialogSessions={pendingDialogSessions} onSelect={(id) => void selectSession(id)} onClose={(id) => void closeSession(id)} onNewSession={() => setNewSessionOpen(true)} />}
      conversation={<ConversationStage session={activeSession} loading={sessionLoading} onNewSession={() => setNewSessionOpen(true)} showThinking={showThinking} expandThinking={expandThinking} />}
      workspace={<WorkspaceDock open={filesOpen} session={activeSession} onClose={closeFiles} />}
      taskFloat={<WorkspaceFloat open={tasksOpen} fileOpen={filesOpen} session={activeSession} onClose={() => setTasksOpen(false)} />}
      canvas={<AgentCanvas session={activeSession} items={canvasState.items} activeItemId={canvasState.activeItemId} open={canvasState.isOpen} onActivate={(itemId) => dispatchCanvas({ type: 'itemActivated', itemId })} onClose={closeCanvas} />}
      canvasOpen={canvasState.isOpen}
      settings={settingsOpen ? <SettingsPage theme={theme} onThemeChange={setTheme} showThinking={showThinking} onShowThinkingChange={setShowThinking} expandThinking={expandThinking} onExpandThinkingChange={setExpandThinking} session={activeSession} onAddModel={() => openModelSetup('settings')} section={settingsSection} onSectionChange={setSettingsSection} onBack={() => setSettingsOpen(false)} /> : null}
      settingsOpen={settingsOpen}
      overlays={<>
        <NewSessionDialog open={newSessionOpen} onOpenChange={setNewSessionOpen} onCreated={(id) => void selectSession(id)} onAddModel={() => openModelSetup('new')} />
        <ModelPickerDialog open={modelOpen} onOpenChange={setModelOpen} session={activeSession} onAddModel={() => openModelSetup('picker')} />
        <ModelSetupDialog open={modelSetupOpen} onOpenChange={changeModelSetupOpen} onConfigured={(reference) => { setNotice(t('app.notice.modelAdded', { reference })); changeModelSetupOpen(false); }} />
        <CommandPalette open={commandsOpen} onOpenChange={setCommandsOpen} commands={commandItems} />
        <ExtensionDialogLayer pending={extensionUi.current} />
        <ConfirmationDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }} title={t('sessions.deleteConversation')} description={t('app.confirm.deleteSession', { name: deleteTargetName })} confirmLabel={t('sessions.deleteConversation')} onConfirm={() => void confirmDeleteSession()} />
        {runtimeNotice ? <div className="runtime-notice" role="status"><span>{runtimeNotice}</span><button type="button" aria-label={t('app.notice.close')} onClick={() => notice ? setNotice('') : setDismissedRuntimeError(runtimeErrorMessage)}>×</button></div> : null}
      </>}
    />
  );
}
