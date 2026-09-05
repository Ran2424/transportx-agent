import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { projectCanvas, syncCanvas, activateCanvas, closeCanvasTab, EMPTY_CANVAS, type CanvasState } from '../platform/canvas/canvas-state';
import { geoContextStore } from '../features/geo/geo-context-store';
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
  const [canvases, setCanvases] = useState<Record<string, CanvasState>>({});
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
  const canvasContent = useMemo(() => projectCanvas(
    activeSession ? conversation.bySession[activeSession.id]?.snapshotEntries ?? [] : [],
    activeSession ? Object.values(tools.bySession[activeSession.id] ?? {}) : [],
  ), [activeSession?.id, conversation, tools]);
  const canvas = activeSession ? canvases[activeSession.id] ?? EMPTY_CANVAS : EMPTY_CANVAS;
  const canvasAvailable = canvasContent.views.length > 0;
  const openedTaskSessions = useRef(new Set<string>());
  const updateCanvas = useCallback((update: (state: CanvasState) => CanvasState) => {
    if (!activeSession) return;
    const id = activeSession.id;
    setCanvases((current) => {
      const previous = current[id] ?? EMPTY_CANVAS;
      const next = update(previous);
      return next === previous ? current : { ...current, [id]: next };
    });
  }, [activeSession?.id]);
  useEffect(() => { updateCanvas((state) => syncCanvas(state, canvasContent)); }, [canvasContent, updateCanvas]);
  useEffect(() => {
    setCanvases((current) => {
      const liveIds = new Set(sessionState.sessions.map((session) => session.id));
      const removed = Object.keys(current).some((id) => !liveIds.has(id));
      return removed ? Object.fromEntries(Object.entries(current).filter(([id]) => liveIds.has(id))) : current;
    });
  }, [sessionState.sessions]);

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

  const waitingGeoRequest = activeSession ? sessionState.geoInteractionBySession[activeSession.id]?.waitingRequest : undefined;
  const waitingViewAvailable = !!waitingGeoRequest && canvasContent.views.some((view) => view.id === `geo:${waitingGeoRequest.visualizationId}`);
  useEffect(() => {
    if (!waitingGeoRequest || !waitingViewAvailable) return;
    const id = `geo:${waitingGeoRequest.visualizationId}`;
    updateCanvas((state) => activateCanvas(state, id));
  }, [waitingGeoRequest?.requestId, waitingGeoRequest?.visualizationId, waitingViewAvailable, updateCanvas]);

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

  const toggleCanvas = useCallback(() => {
    if (!canvasAvailable) return;
    updateCanvas((state) => state.open ? { ...state, open: false } : activateCanvas(state, state.activeId ?? canvasContent.views[0].id));
  }, [canvasAvailable, canvasContent, updateCanvas]);

  const toggleSidebar = useCallback(() => setSidebarOpen((value) => !value), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const toggleFiles = useCallback(() => setFilesOpen((value) => !value), []);
  const closeFiles = useCallback(() => setFilesOpen(false), []);
  const closeCanvas = useCallback(() => updateCanvas((state) => ({ ...state, open: false })), [updateCanvas]);

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
    closeCanvas();
    setNotice('');
  }, [closeCanvas, closeFiles, kernel]);

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
      geoContextStore.clear(sessionId);
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
    { id: 'canvas', label: canvas.open ? t('canvas.hide') : t('canvas.show'), description: t('canvas.description'), disabled: !canvasAvailable, action: toggleCanvas },
    { id: 'model', label: t('app.command.model.label'), description: activeSession ? t('app.command.model.description') : t('app.command.requiresSession'), disabled: !activeSession, action: () => setModelOpen(true) },
    { id: 'compact', label: t('app.command.compact.label'), description: activeSession ? t('app.command.compact.description') : t('app.command.requiresSession'), disabled: !activeSession || activeStreaming || activeCompacting, action: async () => {
      if (!activeSession) return;
      try { await kernel.commands.agent.compact(activeSession.id); setNotice(t('app.notice.compacted')); }
      catch (cause) { setNotice((cause as { message?: string })?.message || t('app.error.compact')); }
    } },
    { id: 'settings', label: t('app.command.settings.label'), description: t('app.command.settings.description'), shortcut: '⌘,', action: () => setSettingsOpen(true) },
  ], [activeCompacting, activeSession, activeStreaming, filesOpen, kernel, canvasAvailable, canvas.open, t, taskAvailable, tasksOpen, toggleFiles, toggleCanvas, toggleTasks]);

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
        if (canvas.open) {
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
  }, [activeSession, canvas.open, closeCanvas, closeFiles, closeSidebar, commandsOpen, extensionUi.current, filesOpen, kernel, modelOpen, modelSetupOpen, newSessionOpen, settingsOpen, sidebarOpen, t, tasksOpen]);

  const pendingDialogSessions = useMemo(() => new Set(extensionUi.queue.flatMap((pending) => pending.sessionId ? [pending.sessionId] : [])), [extensionUi.queue]);
  const runtimeErrorMessage = runtime.lastError?.message || '';
  const runtimeNotice = notice || (runtimeErrorMessage !== dismissedRuntimeError ? runtimeErrorMessage : '');

  return (
    <AppShell
      header={<Header connection={runtime.connection} activeSession={activeSession} streaming={activeStreaming} sidebarOpen={sidebarOpen} fileOpen={filesOpen} taskOpen={tasksOpen} canvasOpen={canvas.open} taskAvailable={taskAvailable} canvasAvailable={canvasAvailable} onToggleSidebar={toggleSidebar} onToggleFiles={toggleFiles} onToggleTasks={toggleTasks} onToggleCanvas={toggleCanvas} onGoHome={goHome} onOpenModel={() => setModelOpen(true)} onOpenCommands={() => setCommandsOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />}
      sidebar={<SessionSidebar open={sidebarOpen} sessions={sessionState.sessions} activeSessionId={sessionState.activeSessionId} onClose={closeSidebar} onGoHome={goHome} onNewSession={() => setNewSessionOpen(true)} onSelectLive={(id) => void selectSession(id)} onSelectHistory={(session, project) => void selectHistory(session, project)} onDeleteLive={deleteLiveSession} onDeleteHistory={deleteHistorySession} />}
      tabs={<LiveTabs sessions={sessionState.sessions} activeSessionId={sessionState.activeSessionId} streamingBySession={sessionState.streamingBySession} pendingDialogSessions={pendingDialogSessions} onSelect={(id) => void selectSession(id)} onClose={(id) => void closeSession(id)} onNewSession={() => setNewSessionOpen(true)} />}
      conversation={<ConversationStage session={activeSession} loading={sessionLoading} onNewSession={() => setNewSessionOpen(true)} showThinking={showThinking} expandThinking={expandThinking} />}
      workspace={<WorkspaceDock open={filesOpen} session={activeSession} onClose={closeFiles} />}
      taskFloat={<WorkspaceFloat open={tasksOpen} fileOpen={filesOpen} session={activeSession} onClose={() => setTasksOpen(false)} />}
      canvas={<AgentCanvas key={activeSession?.id} session={activeSession} views={canvasContent.views} state={canvas} onActivate={(id) => updateCanvas((state) => activateCanvas(state, id))} onCloseTab={(id) => updateCanvas((state) => closeCanvasTab(state, id))} onClose={closeCanvas} />}
      canvasOpen={canvas.open}
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
