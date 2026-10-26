import { CitationDetailProvider } from '../platform/conversation/citation-detail';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DeletionRequest } from '../../public/kernel/commands.js';
import { conversationView, type WorkspaceView } from '../../public/app-types.js';
import type { ConversationRecordV1 } from '../../contracts/workspace.js';
import { MigrationDialog } from '../platform/sessions/MigrationDialog';
import { appKernel, reconnectBrowserApplication } from './composition-root';
import { AppShell } from './AppShell';
import { useConversation, useExtensionUiState, useRuntimeState, useSessionState, useToolExecutions } from './store-hooks';
import { Header } from '../components/shell/Header';
import { projectUi } from './project-ui';
import { ConfirmationDialog } from '../components/ui/confirmation-dialog';
import { CommandPalette, type CommandItem } from '../platform/commands/CommandPalette';
import { ConversationStage } from '../platform/conversation/ConversationStage';
import { toolExpansionStore } from '../platform/conversation/tool-expansion-store';
import { projectTools } from '../platform/conversation/tool-projection';
import { ExtensionDialogLayer } from '../platform/extension-ui/ExtensionDialogLayer';
import { ModelPickerDialog } from '../platform/model/ModelPickerDialog';
import { ModelSetupDialog } from '../platform/model/ModelSetupDialog';
import { NewSessionDialog } from '../platform/sessions/NewSessionDialog';
import { LiveTabs } from '../platform/sessions/LiveTabs';
import { SessionSidebar } from '../platform/sessions/SessionSidebar';
import { SettingsPage, themes, type SettingsSectionId, type ThemeId } from '../platform/settings/SettingsDialog';
import { WorkspaceDock } from '../platform/workspace/WorkspaceDock';
import { AgentCanvas } from '../platform/canvas/AgentCanvas';
import { canvasContextStore } from '../platform/canvas/canvas-context-store';
import { projectCanvas, syncCanvas, activateCanvas, closeCanvasTab, openCanvasDocument, openCanvasResource, withCanvasDocuments, EMPTY_CANVAS, type CanvasState } from '../platform/canvas/canvas-state';
import { OpenDocumentContext } from '../platform/canvas/document-context';
import { documentPath, resolveDocument, type DocumentRequest, type DocumentPosition } from '../platform/canvas/document-state';
import { geoContextStore } from '../features/geo/geo-context-store';

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

export function App({ account }: { account?: ReactNode } = {}) {
  const { t } = useTranslation();
  const kernel = appKernel; const reconnect = reconnectBrowserApplication;
  const runtime = useRuntimeState();
  const sessionState = useSessionState();
  const extensionUi = useExtensionUiState();
  const conversation = useConversation(sessionState.activeSessionId);
  const tools = useToolExecutions(sessionState.activeSessionId);
  const [theme, setTheme] = useState<ThemeId>(initialTheme);
  const [showThinking, setShowThinking] = useState(() => window.localStorage.getItem('tau-show-execution-details') === 'true');
  const [expandThinking, setExpandThinking] = useState(() => window.localStorage.getItem('tau-expand-thinking') === 'true');
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 860);
  const [filesOpen, setFilesOpen] = useState(false);
  useEffect(() => {
    const sessions = new Map<string, Set<string> | null>();
    for (const session of sessionState.sessions) {
      const data = kernel.stores.conversation.get().bySession[session.id];
      if (!data || data.live.active) { sessions.set(session.id, null); continue; }
      const tools = projectTools(data.snapshotEntries, kernel.stores.toolExecution.get().bySession[session.id] || {});
      sessions.set(session.id, new Set([...tools.liveOnly, ...[...tools.byEntry.values()].flat()].map((tool) => tool.id)));
    }
    toolExpansionStore.reconcile(sessions);
  }, [kernel, sessionState]);
  const documentPositions = useRef<Record<string, Map<string, DocumentPosition>>>({});
  const documentOpenSequence = useRef(0);
  const [canvases, setCanvases] = useState<Record<string, CanvasState>>({});
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [creationSequence, setCreationSequence] = useState(0);
  const [quickCreate, setQuickCreate] = useState(false);
  const quickWorkspace = useRef<string | null>(null);
  const quickNavigation = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('general');
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSetupOpen, setModelSetupOpen] = useState(false);
  const [modelSetupOrigin, setModelSetupOrigin] = useState<'new' | 'picker' | 'settings' | null>(null);
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ workspace: WorkspaceView; record?: ConversationRecordV1; isolated?: boolean; input: DeletionRequest } | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [creationWorkspace, setCreationWorkspace] = useState<WorkspaceView | null>(null);
  const [creationMode, setCreationMode] = useState<'create' | 'defaults' | 'confirmation'>('create');
  const [confirmationId, setConfirmationId] = useState<string>();
  const [activating, setActivating] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnosticsWorkspace, setDiagnosticsWorkspace] = useState<WorkspaceView | null>(null);
  const [sessionHistoryRevision, setSessionHistoryRevision] = useState(0);
  const [dismissedRuntimeError, setDismissedRuntimeError] = useState('');
  const restoredRef = useRef(false);
  const navigationSequence = useRef(0);
  useEffect(() => () => { navigationSequence.current++; }, []);

  const activeSession = sessionState.sessions.find((session) => session.id === sessionState.activeSessionId) || null;
  const deleteTargetName = deleteTarget?.record?.name || deleteTarget?.workspace.name || '';
  const activeStreaming = !!(activeSession && sessionState.streamingBySession[activeSession.id]);
  const activeCompacting = !!(activeSession && sessionState.compactingBySession[activeSession.id]);
  const canvas = activeSession ? canvases[activeSession.id] ?? EMPTY_CANVAS : EMPTY_CANVAS;
  const canvasContent = useMemo(() => withCanvasDocuments(projectCanvas(
    activeSession ? conversation?.snapshotEntries ?? [] : [],
    activeSession ? Object.values(tools ?? {}) : [],
    activeSession?.cwd ? { sessionId: activeSession.id, cwd: activeSession.cwd } : undefined,
  ), canvas), [activeSession?.id, activeSession?.cwd, conversation, tools, canvas.documents, canvas.resources]);
  const canvasAvailable = canvasContent.views.length > 0;
  useEffect(() => { documentOpenSequence.current += 1; }, [activeSession?.id]);
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
    const liveIds = new Set(sessionState.sessions.map((session) => session.id));
    for (const id of Object.keys(documentPositions.current)) if (!liveIds.has(id)) delete documentPositions.current[id];
    setCanvases((current) => {
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

  const openDocument = useCallback((request: DocumentRequest) => {
    const session = kernel.stores.session.get().sessions.find((item) => item.id === request.sessionId);
    if (!session?.cwd) return;
    const cwd = session.cwd;
    const sequence = ++documentOpenSequence.current;
    void (request.source ? Promise.resolve(null) : kernel.commands.session.listFiles(session.id).catch(() => null)).then((files) => {
      const current = kernel.stores.session.get();
      if (sequence !== documentOpenSequence.current || current.activeSessionId !== session.id || !current.sessions.some((item) => item.id === session.id)) return;
      if (/\.dxf$/i.test(request.path) && !request.source) {
        const absolute = documentPath(request.path, cwd);
        const roots = [documentPath(cwd, ''), documentPath(files?.path ?? cwd, '')];
        const root = roots.find((value) => absolute.startsWith(`${value}/`));
        const path = root ? absolute.slice(root.length + 1) : request.path;
        void kernel.commands.canvas.present(session.id, { adapterId: 'com.transportx.canvas.cad', resource: { scope: 'session-file', path }, title: request.title }).then((canvas) => {
          if (sequence !== documentOpenSequence.current || kernel.stores.session.get().activeSessionId !== session.id) return;
          setCanvases((states) => ({ ...states, [session.id]: openCanvasResource(states[session.id] ?? EMPTY_CANVAS, canvas) }));
          if (window.matchMedia('(max-width: 860px)').matches) { setFilesOpen(false); setSidebarOpen(false); }
        }).catch(() => {});
        return;
      }
      const document = resolveDocument(request, cwd, files?.path ?? cwd);
      if (!document) return;
      setCanvases((states) => ({ ...states, [session.id]: openCanvasDocument(states[session.id] ?? EMPTY_CANVAS, document) }));
      if (window.matchMedia('(max-width: 860px)').matches) { setFilesOpen(false); setSidebarOpen(false); }
    });
  }, [kernel]);

  const waitingGeoRequest = activeSession ? sessionState.geoInteractionBySession[activeSession.id]?.waitingRequest : undefined;
  const waitingGeoScreenshot = activeSession ? sessionState.geoInteractionBySession[activeSession.id]?.waitingScreenshotRequest : undefined;
  const waitingGeoTarget = waitingGeoScreenshot || waitingGeoRequest;
  const waitingViewAvailable = !!waitingGeoTarget && canvasContent.views.some((view) => view.id === `geo:${waitingGeoTarget.visualizationId}`);
  useEffect(() => {
    if (!waitingGeoTarget || !waitingViewAvailable) return;
    const id = `geo:${waitingGeoTarget.visualizationId}`;
    updateCanvas((state) => activateCanvas(state, id));
  }, [waitingGeoTarget?.requestId, waitingGeoTarget?.visualizationId, waitingViewAvailable, updateCanvas]);

  const toggleCanvas = useCallback(() => {
    if (!canvasAvailable) return;
    updateCanvas((state) => state.open ? { ...state, open: false } : activateCanvas(state, state.activeId ?? canvasContent.views[0].id));
  }, [canvasAvailable, canvasContent, updateCanvas]);

  const toggleSidebar = useCallback(() => setSidebarOpen((value) => !value), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const toggleFiles = useCallback(() => {
    const narrow = window.matchMedia('(max-width: 860px)').matches;
    const opening = !filesOpen || (narrow && canvas.open);
    setFilesOpen(opening);
    if (opening && narrow) {
      updateCanvas((state) => ({ ...state, open: false }));
    }
  }, [filesOpen, canvas.open, updateCanvas]);
  const closeFiles = useCallback(() => setFilesOpen(false), []);
  const closeCanvas = useCallback(() => updateCanvas((state) => ({ ...state, open: false })), [updateCanvas]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('tau-theme', theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem('tau-show-execution-details', String(showThinking));
  }, [showThinking]);

  useEffect(() => {
    window.localStorage.setItem('tau-expand-thinking', String(expandThinking));
  }, [expandThinking]);

  const refreshLiveSessions = useCallback(async () => {
    try {
      await kernel.commands.session.list();
    } catch (cause) {
      setNotice((cause as { message?: string })?.message || t('app.error.loadLiveSessions'));
    }
  }, [kernel, t]);

  useEffect(() => {
    if (runtime.connection !== 'connected' || runtime.health?.dataState !== 'ready') return;
    void refreshLiveSessions();
    const timer = window.setInterval(() => void refreshLiveSessions(), 10_000);
    return () => window.clearInterval(timer);
  }, [refreshLiveSessions, runtime.connection, runtime.health?.dataState]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && kernel.stores.runtime.get().connection !== 'connected') reconnect();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [kernel, reconnect]);

  const selectSession = useCallback(async (sessionId: string) => {
    if (!kernel.stores.session.get().sessions.some((item) => item.id === sessionId)) {
      const workspace = kernel.stores.session.get().workspaces.find((item) => item.conversations.some(({ record }) => record.id === sessionId));
      const item = workspace?.conversations.find(({ record }) => record.id === sessionId);
      if (!workspace || workspace.revision === null || !item) return;
      kernel.dispatch({ type: 'session/created', session: conversationView(item.record, { ...workspace, revision: workspace.revision }, item.runtime) });
    }
    const request = ++navigationSequence.current;
    kernel.dispatch({ type: 'session/activated', sessionId });
    window.localStorage.setItem('tau-active-conversation-id', sessionId);
    setSessionLoading(true);
    setNotice('');
    if (window.innerWidth <= 860) closeSidebar();
    try {
      const snapshot = await kernel.commands.session.loadSnapshot(sessionId);
      if (request !== navigationSequence.current) return;
      kernel.dispatch({ type: 'session/snapshotReceived', sessionId, snapshot });
    } catch (cause) {
      if (request === navigationSequence.current) setNotice((cause as { message?: string })?.message || t('app.error.loadSnapshot'));
    } finally {
      if (request === navigationSequence.current) setSessionLoading(false);
    }
  }, [closeSidebar, kernel, t]);

  const goHome = useCallback(() => {
    navigationSequence.current++;
    setSessionLoading(false);
    kernel.dispatch({ type: 'session/activated', sessionId: null });
    window.localStorage.removeItem('tau-active-conversation-id');
    closeFiles();
    closeCanvas();
    setNotice('');
  }, [closeCanvas, closeFiles, kernel]);

  useEffect(() => {
    if (restoredRef.current || !sessionState.indexLoaded) return;
    const saved = window.localStorage.getItem('tau-active-conversation-id');
    const savedExists = saved && sessionState.workspaces.some((workspace) => workspace.availability === 'ready' && workspace.conversations.some(({ record }) => record.id === saved));
    const target = savedExists ? saved : mostRecentSessionId(sessionState.sessions);
    if (!target) return;
    restoredRef.current = true;
    void selectSession(target);
  }, [selectSession, sessionState.sessions, sessionState.workspaces, sessionState.indexLoaded]);

  function openNewSession(workspace: WorkspaceView | null = null) {
    if (quickWorkspace.current) return;
    quickWorkspace.current = workspace?.id || null; quickNavigation.current = navigationSequence.current; setQuickCreate(!!workspace);
    if (workspace) setNotice(t('workspaceFlow.creating'));
    setCreationSequence(value => value + 1); setCreationWorkspace(workspace); setCreationMode('create'); setConfirmationId(undefined); setNewSessionOpen(true);
  }
  function finishQuickCreate() { quickWorkspace.current = null; setNotice(value => value === t('workspaceFlow.creating') ? '' : value); }
  function openDiagnostics(workspace?: WorkspaceView) { setDiagnosticsWorkspace(workspace || null); setDiagnosticsOpen(true); }
  async function activateConversation() {
    if (!activeSession) return;
    const workspace = sessionState.workspaces.find((item) => item.id === activeSession.workspaceId);
    if (activeSession.record?.plan === null && workspace) { if (quickWorkspace.current) return; setCreationWorkspace(workspace); setConfirmationId(activeSession.id); setCreationMode('confirmation'); setNewSessionOpen(true); return; }
    setActivating(true); setNotice('');
    try { await kernel.commands.session.activate(activeSession.id); }
    catch (cause) {
      if (kernel.stores.session.get().activeSessionId !== activeSession.id) return;
      if ((cause as { code?: string }).code === 'workspace_busy') {
        if (window.confirm(t('workspaceFlow.stopSwitch'))) {
          try { await kernel.commands.session.activate(activeSession.id, { stopCurrent: true }); } catch (error) { if (kernel.stores.session.get().activeSessionId === activeSession.id) setNotice((error as Error).message); }
        } else {
          const owner = workspace?.conversations.find((item) => item.runtime && item.record.id !== activeSession.id);
          if (owner) await selectSession(owner.record.id);
        }
      } else setNotice((cause as Error).message);
    } finally { setActivating(false); await kernel.commands.session.list().catch(() => {}); }
  }

  async function closeSession(sessionId: string) {
    const isStreaming = !!kernel.stores.session.get().streamingBySession[sessionId];
    if (isStreaming && !window.confirm(t('app.confirm.closeStreaming'))) return;
    const request = navigationSequence.current;
    try {
      try { await kernel.commands.session.close(sessionId, isStreaming); } catch (cause) { if ((cause as { code?: string }).code !== 'workspace_busy' || !window.confirm(t('workspaceFlow.stopClose'))) throw cause; await kernel.commands.session.close(sessionId, true); }
      geoContextStore.clear(sessionId);
      kernel.dispatch({ type: 'session/closed', sessionId });
      if (request === navigationSequence.current && kernel.stores.session.get().activeSessionId === null) {
        window.localStorage.removeItem('tau-active-conversation-id');
        const next = mostRecentSessionId(kernel.stores.session.get().sessions);
        if (next) await selectSession(next);
      }
    } catch (cause) {
      if (request === navigationSequence.current) setNotice((cause as { message?: string })?.message || t('app.error.closeSession'));
    }
  }

  function requestDeletion(workspace: WorkspaceView, record?: ConversationRecordV1) {
    setDeleteError('');
    setDeleteTarget({ workspace, record, isolated: !record && workspace.availability === 'isolated', input: { requestId: record?.deletion?.requestId || (!record ? workspace.deletion?.requestId : null) || crypto.randomUUID(), expectedRevision: workspace.revision ?? workspace.deletion?.manifestRevision ?? 0, confirm: true } });
  }
  async function confirmDeleteSession() {
    if (!deleteTarget) return;
    const { workspace, record, input } = deleteTarget;
    try {
      if (record) { await kernel.commands.session.deleteConversation(record.id, input); kernel.dispatch({ type: 'session/closed', sessionId: record.id }); }
      else if (deleteTarget.isolated) { await kernel.commands.session.deleteIsolatedWorkspace(workspace.id, input); for (const view of kernel.stores.session.get().sessions.filter((item) => item.workspaceId === workspace.id)) kernel.dispatch({ type: 'session/closed', sessionId: view.id }); }
      else { await kernel.commands.session.deleteWorkspace(workspace.id, input); for (const view of kernel.stores.session.get().sessions.filter((item) => item.workspaceId === workspace.id)) kernel.dispatch({ type: 'session/closed', sessionId: view.id }); }
      setDeleteTarget(null); setSessionHistoryRevision((value) => value + 1);
    } catch (cause) {
      if ((cause as { code?: string }).code === 'workspace_busy') setDeleteError(t('workspaceFlow.deleteBusy')); else setDeleteError((cause as Error).message);
      await kernel.commands.session.list().catch(() => {});
    }
  }

  const commandItems = useMemo<CommandItem[]>(() => [
    { id: 'new', label: t('app.command.new.label'), description: t('app.command.new.description'), shortcut: '⌘N', action: () => openNewSession() },
    { id: 'files', label: filesOpen ? t('app.command.files.close') : t('app.command.files.open'), description: t('app.command.files.description'), shortcut: '⌘⇧W', action: toggleFiles },
    { id: 'canvas', label: canvas.open ? t('canvas.hide') : t('canvas.show'), description: t('canvas.description'), disabled: !canvasAvailable, action: toggleCanvas },
    { id: 'model', label: t('app.command.model.label'), description: activeSession ? t('app.command.model.description') : t('app.command.requiresSession'), disabled: !activeSession, action: () => setModelOpen(true) },
    { id: 'compact', label: t('app.command.compact.label'), description: activeSession ? t('app.command.compact.description') : t('app.command.requiresSession'), disabled: !activeSession || activeStreaming || activeCompacting, action: async () => {
      if (!activeSession) return;
      try { await kernel.commands.agent.compact(activeSession.id); setNotice(t('app.notice.compacted')); }
      catch (cause) { setNotice((cause as { message?: string })?.message || t('app.error.compact')); }
    } },
    { id: 'settings', label: t('app.command.settings.label'), description: t('app.command.settings.description'), shortcut: '⌘,', action: () => setSettingsOpen(true) },
  ], [activeCompacting, activeSession, activeStreaming, filesOpen, kernel, canvasAvailable, canvas.open, t, toggleFiles, toggleCanvas]);

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
        openNewSession();
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
  }, [activeSession, canvas.open, closeCanvas, closeFiles, closeSidebar, commandsOpen, extensionUi.current, filesOpen, kernel, modelOpen, modelSetupOpen, newSessionOpen, settingsOpen, sidebarOpen, t]);

  const pendingDialogSessions = useMemo(() => new Set(extensionUi.queue.flatMap((pending) => pending.sessionId ? [pending.sessionId] : [])), [extensionUi.queue]);
  const runtimeErrorMessage = !runtime.lastError?.sessionId || runtime.lastError.sessionId === activeSession?.id ? runtime.lastError?.message || '' : '';
  const runtimeNotice = notice || (runtimeErrorMessage !== dismissedRuntimeError ? runtimeErrorMessage : '');

  return (
    <OpenDocumentContext.Provider value={openDocument}><CitationDetailProvider sessionId={activeSession?.id}><AppShell
      header={<Header account={account} connection={runtime.connection} activeSession={activeSession} streaming={activeStreaming} sidebarOpen={sidebarOpen} fileOpen={filesOpen} canvasOpen={canvas.open} canvasAvailable={canvasAvailable} onToggleSidebar={toggleSidebar} onToggleFiles={toggleFiles} onToggleCanvas={toggleCanvas} onGoHome={goHome} onOpenModel={() => setModelOpen(true)} onOpenCommands={() => setCommandsOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />}
      sidebar={<SessionSidebar onManageModules={() => { setSettingsSection('modules'); setSettingsOpen(true); }} open={sidebarOpen} dataReady={runtime.health?.dataState === 'ready'} sessions={sessionState.sessions} workspaces={sessionState.workspaces} activeSessionId={sessionState.activeSessionId} historyRevision={sessionHistoryRevision} onClose={closeSidebar} onGoHome={goHome} onNewSession={(workspace) => openNewSession(workspace)} onSelect={(id) => void selectSession(id)} onDelete={requestDeletion} onDefaults={(workspace) => { if (quickWorkspace.current) return; setQuickCreate(false); setCreationWorkspace(workspace); setCreationMode('defaults'); setNewSessionOpen(true); }} onDiagnostics={openDiagnostics} />}
      tabs={<LiveTabs sessions={sessionState.sessions} activeSessionId={sessionState.activeSessionId} streamingBySession={sessionState.streamingBySession} pendingDialogSessions={pendingDialogSessions} onSelect={(id) => void selectSession(id)} onClose={(id) => void closeSession(id)} onNewSession={() => openNewSession()} />}
      conversation={<ConversationStage session={activeSession} loading={sessionLoading} onNewSession={() => openNewSession()} onActivate={() => void activateConversation()} activating={activating} showThinking={showThinking} expandThinking={expandThinking} />}
      workspace={<WorkspaceDock open={filesOpen} session={activeSession} onClose={closeFiles} />}
      canvas={<AgentCanvas key={activeSession?.id} session={activeSession} views={canvasContent.views} state={canvas} documentPositions={activeSession ? documentPositions.current[activeSession.id] ??= new Map() : new Map()} onActivate={(id) => updateCanvas((state) => activateCanvas(state, id))} onCloseTab={(id) => updateCanvas((state) => closeCanvasTab(state, id))} onClose={closeCanvas} onShareContext={async (input) => { if (!activeSession) return; const view = canvasContent.views.find((view) => view.id === input.viewId && view.canvas?.revision === input.revision); canvasContextStore.add(activeSession.id, await kernel.commands.canvas.createContext(activeSession.id, input), view?.title); }} />}
      canvasOpen={canvas.open}
      settings={settingsOpen ? <SettingsPage theme={theme} onThemeChange={setTheme} showThinking={showThinking} onShowThinkingChange={setShowThinking} expandThinking={expandThinking} onExpandThinkingChange={setExpandThinking} session={activeSession} onAddModel={() => openModelSetup('settings')} section={settingsSection} onSectionChange={setSettingsSection} onBack={() => setSettingsOpen(false)} /> : null}
      settingsOpen={settingsOpen}
      overlays={<>
        <projectUi.UpdateNotice onOpen={() => { setSettingsSection('general'); setSettingsOpen(true); }} />
        <NewSessionDialog key={creationSequence} quickCreate={quickCreate && creationMode === 'create'} onQuickCreateFinished={finishQuickCreate} open={newSessionOpen} onOpenChange={setNewSessionOpen} workspace={creationWorkspace} workspaces={sessionState.workspaces} onWorkspaceChange={setCreationWorkspace} mode={creationMode} confirmationId={confirmationId} onCreated={(id, fromQuickCreate) => { if (!fromQuickCreate || quickNavigation.current === navigationSequence.current) void selectSession(id); }} onAddModel={() => openModelSetup('new')} />
        <MigrationDialog open={diagnosticsOpen} onOpenChange={setDiagnosticsOpen} workspace={diagnosticsWorkspace} />
        <ModelPickerDialog open={modelOpen} onOpenChange={setModelOpen} session={activeSession} onAddModel={() => openModelSetup('picker')} />
        <ModelSetupDialog open={modelSetupOpen} onOpenChange={changeModelSetupOpen} onConfigured={(reference) => { setNotice(t('app.notice.modelAdded', { reference })); changeModelSetupOpen(false); }} />
        <CommandPalette open={commandsOpen} onOpenChange={setCommandsOpen} commands={commandItems} />
        <ExtensionDialogLayer pending={extensionUi.current} />
        <ConfirmationDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }} title={deleteTarget?.isolated ? t('workspaceFlow.deleteIsolated') : deleteTarget?.record ? t('workspaceFlow.deleteConversation') : t('workspaceFlow.deleteWorkspace')} description={deleteTarget?.isolated ? t('workspaceFlow.deleteIsolatedCopy', { name: deleteTargetName }) : deleteTarget?.record ? t('workspaceFlow.deleteConversationCopy', { name: deleteTargetName }) : t('workspaceFlow.deleteWorkspaceCopy', { name: deleteTargetName })} confirmLabel={t('workspaceFlow.confirmDelete')} onConfirm={() => void confirmDeleteSession()}>
          <p className="confirmation-dialog-copy">{deleteTarget?.workspace.path}</p>
          <label className="confirmation-dialog-workspace"><input type="checkbox" checked={deleteTarget?.input.stopCurrent === true} onChange={(event) => setDeleteTarget((current) => current ? { ...current, input: { ...current.input, stopCurrent: event.target.checked } } : null)} />{t('workspaceFlow.stopBeforeDelete')}</label>
          {deleteError && <p className="form-error">{deleteError}</p>}
        </ConfirmationDialog>
        {runtime.health?.dataState && runtime.health.dataState !== 'ready' && <div className="conversation-offline-bar" role="status"><span>{runtime.health.dataState === 'initializing' ? t('workspaceFlow.inventoryInitializing') : t('workspaceFlow.inventoryBlocked')}</span><button type="button" onClick={() => openDiagnostics()}>{t('workspaceFlow.openMigration')}</button></div>}
        {runtimeNotice ? <div className="runtime-notice" role="status"><span>{runtimeNotice}</span><button type="button" aria-label={t('app.notice.close')} onClick={() => notice ? setNotice('') : setDismissedRuntimeError(runtimeErrorMessage)}>×</button></div> : null}
      </>}
    /></CitationDetailProvider></OpenDocumentContext.Provider>
  );
}
