/**
 * Main App - Ties everything together
 */

import { MessageRenderer } from './message-renderer.js';
import { ToolCardRenderer, formatToolResultText } from './tool-card.js';
import { DialogHandler, type DialogRequest } from './dialogs.js';
import { SessionSidebar, type SidebarProject, type SidebarSession } from './session-sidebar.js';
import { themes, applyTheme, getCurrentTheme } from './themes.js';
import { getFileIcon } from './file-browser.js';
import { setupLauncherPanel } from './launcher-panel.js';
import { setupModelPicker } from './model-picker.js';
import { setupVoiceInput } from './voice-input.js';
import { setupCommandPalette } from './command-palette.js';
import { setupSessionStatsCard, type SessionStats } from './session-stats-card.js';
import { WorkspaceController } from './workspace/workspace-controller.js';
import { FeatureRegistry } from './features/feature-registry.js';
import { GeoFeature } from './features/geo/geo-feature.js';
import { TaskModeFeature } from './features/task/task-mode-feature.js';
import { WebSocketClient } from './websocket-client.js';
import { createAppKernel, type KernelUiEvent } from './kernel/app-kernel.js';
import type { AppError } from '../contracts/errors.ts';
import { messageText, messageThinking } from './kernel/stores/conversation-store.js';
import { ToolExecutionController } from './controllers/tool-execution-controller.js';

import type { AppEvent, AppMessage, LiveInstance, LiveSession, MessageContentBlock, ModelRecord, PendingFilePath, PendingImage, RpcCommand, SessionEntry, SessionSnapshot, UsageRecord } from './app-types.js';

type SessionHistoryEntry = SessionEntry;

type DurationCacheEntry = { durationMs: number; updatedAt: number };
type DurationCache = Record<string, DurationCacheEntry>;

// Initialize components
const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
const wsClient = new WebSocketClient(wsUrl);
// The kernel owns all application state (sessions, streaming, conversation,
// tool executions, extension UI). app-main renders from its stores and
// issues commands through its ports; nothing here judges streaming itself.
const kernel = createAppKernel({
  transport: wsClient,
  http: (path, init) => fetch(path, {
    method: init?.method,
    headers: { 'Content-Type': 'application/json' },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  }),
});
const { stores, commands, dispatch } = kernel;

// Derived reads against the kernel stores — the single source of truth for
// session list and per-session streaming state.
function getLiveSessions(): LiveSession[] {
  return stores.session.get().sessions;
}

function isSessionStreaming(sessionId: string | null): boolean {
  return !!sessionId && !!stores.session.get().streamingBySession[sessionId];
}

function isActiveStreaming(): boolean {
  return viewingActiveSession && isSessionStreaming(activeLiveSessionId);
}
// All element lookups below query the app's static index.html shell, which is
// present before this module runs (the script is a deferred module at the end
// of <body>). A missing element means the page is structurally broken, so we
// assert non-null at the query site rather than guarding every usage.
const messageRenderer = new MessageRenderer(document.getElementById('messages')!);
const toolCardRenderer = new ToolCardRenderer(document.getElementById('messages')!, { getSessionId: () => activeLiveSessionId });
// DialogHandler keeps its DOM behavior, but its responses go through the
// kernel command port so the extensionUi store sees every resolution.
const dialogHandler = new DialogHandler(document.getElementById('dialog-container')!, {
  send(data: unknown) {
    const message = data as { type?: string; id?: string; sessionId?: string | null } & Record<string, unknown>;
    if (message?.type !== 'extension_ui_response') {
      wsClient.send(data);
      return;
    }
    const { type: _type, id, sessionId, ...response } = message;
    void commands.extensionUi.respond({
      sessionId: sessionId ?? null,
      id,
      response: Object.keys(response).length > 0 ? response : undefined,
    });
  },
}, () => activeLiveSessionId);

// Session sidebar
const sidebar = new SessionSidebar(
  document.getElementById('session-list')!,
  handleSessionSelect
);

// UI elements
const messageInput = document.getElementById('message-input')!;
const chatForm = document.getElementById('chat-form')!;
const sendBtn = document.getElementById('send-btn')!;
const abortBtn = document.getElementById('abort-btn')!;
const statusIndicator = document.getElementById('status-indicator')!;
const statusText = document.getElementById('status-text')!;
// Tracks the pending timer that restores statusText after a transient
// status message (rpcCommand success/error). Any new status message must
// clear this so a stale restore cannot overwrite a later, longer-lived
// message (e.g. the red-dot error flash).
let statusRestoreTimer: ReturnType<typeof setTimeout> | null = null;
// Tracks the pending timer that restores the status indicator (dot) and
// text after a red-dot error flash. Kept SEPARATE from statusRestoreTimer
// so a normal setStatusMessage call cannot cancel the only callback that
// would clear the `error` class — otherwise an unrelated status update
// during the 3s flash would strand the dot red with no timer to reset it.
let statusFlashTimer: ReturnType<typeof setTimeout> | null = null;
// Restore the status indicator dot to its real connection/streaming state.
// Only touches the indicator class (not statusText), so callers can set the
// accompanying text themselves.
function restoreStatusIndicator() {
  const connected = stores.runtime.get().connection === 'connected';
  statusIndicator.className = `status-indicator ${
    connected && isActiveStreaming() ? 'streaming' : (connected ? 'connected' : 'disconnected')
  }`;
}
// Set a transient statusText message and schedule its restore. Cancels any
// previously scheduled restore so overlapping messages cannot race. A new
// status message also supersedes any active error flash: it cancels the
// flash's restore and returns the dot to its real state so the `error`
// class cannot linger with no timer to clear it.
function setStatusMessage(text: string, restoreText: string | null = null, restoreMs = 3000) {
  if (statusFlashTimer !== null) {
    clearTimeout(statusFlashTimer);
    statusFlashTimer = null;
    restoreStatusIndicator();
  }
  clearTimeout(statusRestoreTimer ?? undefined);
  statusText.textContent = text;
  if (restoreText !== null) {
    statusRestoreTimer = setTimeout(() => {
      statusRestoreTimer = null;
      statusText.textContent = restoreText;
    }, restoreMs);
  }
}
// Turn the status indicator red and show an error message; after `ms`,
// restore the indicator to the real connection state and reset the text.
function flashStatusError(msg: string, ms = 3000) {
  // Reset the class atomically so no stale connected/disconnected/streaming
  // class lingers alongside `error` (matches updateConnectionStatus' style).
  statusIndicator.className = 'status-indicator error';
  // Cancel any pending status-text restore (e.g. rpcCommand's 'Done' ->
  // 'Connected' timer from an earlier successful step in the same flow) so it
  // cannot overwrite this error message while the red dot persists.
  clearTimeout(statusRestoreTimer ?? undefined);
  // Cancel any prior flash restore so overlapping flashes (a second
  // model-save failure within 3s) cannot leak a stray restore that
  // would reset the dot before this flash's own restore fires.
  clearTimeout(statusFlashTimer ?? undefined);
  statusText.textContent = msg;
  // Schedule the dot+text restore on the dedicated statusFlashTimer so a
  // later setStatusMessage (e.g. the user clicking the thinking-level cycle
  // button right after a thinking-level failure) cannot cancel the only
  // callback that clears the `error` class. If a new status message does
  // arrive, setStatusMessage itself retires the flash via restoreStatusIndicator.
  statusFlashTimer = setTimeout(() => {
    statusFlashTimer = null;
    restoreStatusIndicator();
    const connected = stores.runtime.get().connection === 'connected';
    // Preserve an in-progress stream: restore the streaming text too.
    statusText.textContent = (connected && isActiveStreaming()) ? '处理中...'
      : (connected ? '已连接' : '已断开');
  }, ms);
}

const sidebarEl = document.getElementById('sidebar')!;
const sidebarToggle = document.getElementById('sidebar-toggle')!;
const sidebarOverlay = document.getElementById('sidebar-overlay')!;

const refreshSessionsBtn = document.getElementById('refresh-sessions-btn')!;
const sessionSearchInput = document.getElementById('session-search-input')!;
const typingIndicator = document.getElementById('typing-indicator')!;

const contextPillEl = document.getElementById('context-pill')!;
const scrollBottomBtn = document.getElementById('scroll-bottom-btn')!;
const scrollBottomBadge = document.getElementById('scroll-bottom-badge')!;
const messagesContainer = document.getElementById('messages')!;
const launcherPanel = setupLauncherPanel({
  launcherEl: document.getElementById('launcher')!,
  messagesContainer,
  async createSession(projectPath) {
    try {
      const session = await commands.session.create({ cwd: currentNewSessionCwd(), name: basename(projectPath || '任务'), model: '' });
      dispatch({ type: 'session/created', session });
      await selectLiveSession(session.id);
    } catch (e) {
      console.error('[Launcher] Failed to create Tau tab:', e);
    }
  },
});

// View-local rendering state (DOM handles and wall-clock timing only — all
// domain state lives in the kernel stores).
let streamingElement: HTMLElement | null = null; // DOM handle of the in-flight assistant message
let streamingThinkingStartedAt: number | null = null;
let streamingThinkingEndedAt: number | null = null;
let renderedEntryCount = 0; // snapshotEntries already rendered for the current view
let optimisticPromptRendered = false;
let sessionTotalCost = 0;
let lastInputTokens = 0;
let contextWindowSize = 0;  // fetched from model info
let originalTitle = document.title;
let hasFocus = true;
let unreadCount = 0;
let isScrolledUp = false;
let hasNewWhileScrolled = false;
let lastUsage: UsageRecord | null = null; // Full usage object for context visualiser
let activeLiveSessionFile: string | null = null; // The active live session file path
let viewingActiveSession = false; // Whether we're viewing a live backend Tau tab or historical read-only session
let hasReceivedInitialServerState = false;
let liveInstances: LiveInstance[] = []; // Sidebar live indicators derived from backend live sessions
let activeLiveSessionId = localStorage.getItem('tau-active-live-session-id') || null;
let hasRestoredInitialLiveSession = false;

const TOOL_DURATION_CACHE_KEY = 'tau-tool-duration-cache-v1';
const THINKING_DURATION_CACHE_KEY = 'tau-thinking-duration-cache-v1';
const TOOL_DURATION_CACHE_LIMIT = 1200;

function readDurationCache(cacheKey: string): DurationCache {
  try {
    const parsed = JSON.parse(localStorage.getItem(cacheKey) || '{}');
    return parsed && typeof parsed === 'object' ? parsed as DurationCache : {};
  } catch {
    return {};
  }
}

function writeDurationCache(cacheKey: string, cache: DurationCache) {
  const entries = Object.entries(cache)
    .filter(([, entry]) => Number.isFinite(entry?.durationMs) && Number.isFinite(entry?.updatedAt))
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, TOOL_DURATION_CACHE_LIMIT);
  localStorage.setItem(cacheKey, JSON.stringify(Object.fromEntries(entries)));
}

function toolDurationScopes(sessionId: string | null = activeLiveSessionId) {
  const scopes: string[] = [];
  const sessionFile = sessionId === activeLiveSessionId
    ? activeLiveSessionFile
    : getLiveSessions().find((s) => s.id === sessionId)?.sessionFile || null;
  if (sessionFile) scopes.push(`file:${sessionFile}`);
  if (sessionId) scopes.push(`id:${sessionId}`);
  return scopes;
}

function rememberToolDuration(toolCallId: string, durationMs: number, sessionId: string | null = activeLiveSessionId) {
  if (!toolCallId || !Number.isFinite(durationMs) || durationMs < 0) return;
  const scopes = toolDurationScopes(sessionId);
  if (scopes.length === 0) return;
  const cache = readDurationCache(TOOL_DURATION_CACHE_KEY);
  const updatedAt = Date.now();
  for (const scope of scopes) {
    cache[`${scope}::${toolCallId}`] = { durationMs, updatedAt };
  }
  writeDurationCache(TOOL_DURATION_CACHE_KEY, cache);
}

function getRememberedToolDuration(toolCallId: string, sessionId: string | null = activeLiveSessionId) {
  if (!toolCallId) return undefined;
  const cache = readDurationCache(TOOL_DURATION_CACHE_KEY);
  for (const scope of toolDurationScopes(sessionId)) {
    const entry = cache[`${scope}::${toolCallId}`];
    if (entry && Number.isFinite(entry.durationMs)) return entry.durationMs;
  }
  return undefined;
}

function stableHash(text: string) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function thinkingDurationIdentity(message: AppMessage) {
  if (message.id) return `id:${message.id}`;
  return `hash:${stableHash(`${message.role || ''}\n${messageText(message)}\n${messageThinking(message)}`)}`;
}

function rememberThinkingDuration(message: AppMessage, blockIndex: number, durationMs: number, sessionId: string | null = activeLiveSessionId) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  const scopes = toolDurationScopes(sessionId);
  if (scopes.length === 0) return;
  const cache = readDurationCache(THINKING_DURATION_CACHE_KEY);
  const identity = thinkingDurationIdentity(message);
  const updatedAt = Date.now();
  for (const scope of scopes) {
    cache[`${scope}::${identity}::${blockIndex}`] = { durationMs, updatedAt };
  }
  writeDurationCache(THINKING_DURATION_CACHE_KEY, cache);
}

function getRememberedThinkingDuration(message: AppMessage, blockIndex: number, sessionId: string | null = activeLiveSessionId) {
  const cache = readDurationCache(THINKING_DURATION_CACHE_KEY);
  const identity = thinkingDurationIdentity(message);
  for (const scope of toolDurationScopes(sessionId)) {
    const entry = cache[`${scope}::${identity}::${blockIndex}`];
    if (entry && Number.isFinite(entry.durationMs)) return entry.durationMs;
  }
  return undefined;
}

function syncSidebarLiveSessions() {
  sidebar.setLiveSessions(getLiveSessions());
  updateLiveSessionIndicators();
}

// Right workspace and cross-boundary Web features
const workspaceController = new WorkspaceController({
  elements: {
    sidebar: document.getElementById('file-sidebar')!,
    toggle: document.getElementById('file-sidebar-toggle')!,
    close: document.getElementById('file-sidebar-close')!,
    up: document.getElementById('file-sidebar-up')!,
    tabs: document.getElementById('file-sidebar-tabs')!,
    fileList: document.getElementById('file-list')!,
    resourceList: document.getElementById('resource-list')!,
    path: document.getElementById('file-sidebar-path')!,
    finder: document.getElementById('file-sidebar-finder')!,
    fileActions: Array.from(document.querySelectorAll<HTMLElement>('.file-sidebar-file-action')),
  },
  messageInput,
  onFileSelected(filePath) {
    const name = filePath.split(/[/\\]/).pop() || filePath;
    const ext = name.split('.').pop()?.toLowerCase() || '';
    pendingFilePaths.push({ path: filePath, name, ext, sessionId: activeLiveSessionId });
    renderAttachmentPreviews();
  },
  getSessionId: () => viewingActiveSession && getLiveSessions().some((session) => session.id === activeLiveSessionId)
    ? activeLiveSessionId
    : null,
});
const featureRegistry = new FeatureRegistry(workspaceController);
featureRegistry.register(new GeoFeature({ onRequestOpen: () => workspaceController.openView('visualizations') }));
const taskModeFeature = new TaskModeFeature({
  container: document.getElementById('task-board-content')!,
  toggle: document.getElementById('task-mode-toggle') as HTMLButtonElement,
  panel: document.getElementById('task-board')!,
  panelToggle: document.getElementById('task-panel-toggle') as HTMLButtonElement,
  panelClose: document.getElementById('task-board-close') as HTMLButtonElement,
  dragHandle: document.getElementById('task-board-drag-handle')!,
  async onModeChange(enabled) {
    if (isActiveStreaming()) {
      setStatusMessage('请等待当前回复结束后再切换任务模式', '已连接', 3000);
      return false;
    }
    const response = await rpcCommand({ type: 'prompt', message: `/task ${enabled ? 'on' : 'off'}` }, '正在切换任务模式...');
    return !!response?.success;
  },
});
featureRegistry.register(taskModeFeature);
const toolExecutionController = new ToolExecutionController({
  store: stores.toolExecution,
  renderer: toolCardRenderer,
  features: featureRegistry,
  workspace: workspaceController,
  formatResult: formatToolResultText,
  rememberDuration: rememberToolDuration,
});
workspaceController.start();


// ═══════════════════════════════════════
// Focus tracking for tab title notifications
// ═══════════════════════════════════════

window.addEventListener('focus', () => {
  hasFocus = true;
  unreadCount = 0;
  document.title = originalTitle;
});





window.addEventListener('blur', () => {
  hasFocus = false;
});

// Reconnect WebSocket when returning to the app (iOS suspends WS connections)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && stores.runtime.get().connection !== 'connected') {
    console.log('[App] Returning to app, reconnecting...');
    wsClient.forceReconnect();
  }
});

// ═══════════════════════════════════════
// Scroll-to-bottom button + new message indicator
// ═══════════════════════════════════════

messagesContainer.addEventListener('scroll', () => {
  const threshold = 150;
  const atBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
  isScrolledUp = !atBottom;
  
  if (atBottom) {
    scrollBottomBtn.classList.add('hidden');
    scrollBottomBadge.classList.add('hidden');
    hasNewWhileScrolled = false;
  } else {
    scrollBottomBtn.classList.remove('hidden');
  }
});

scrollBottomBtn.addEventListener('click', () => {
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
  scrollBottomBtn.classList.add('hidden');
  scrollBottomBadge.classList.add('hidden');
  hasNewWhileScrolled = false;
});

function scrollToBottom() {
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
}

function showNewMessageBadge() {
  if (isScrolledUp) {
    hasNewWhileScrolled = true;
    scrollBottomBadge.classList.remove('hidden');
  }
}

// ═══════════════════════════════════════
// WebSocket event handlers
// ═══════════════════════════════════════

wsClient.addEventListener('connected', () => {
  // Fetch model context window size for token % display
  setTimeout(fetchContextWindow, 1000);

});

wsClient.addEventListener('reconnectFailed', () => {
  messageRenderer.renderError('连接已断开，请刷新页面。');
});

// First server state restores the saved (or most recent) live session; on
// reconnect the same path re-hydrates the viewed session from a snapshot.
function handleServerStateApplied() {
  const wasViewingLive = viewingActiveSession;
  const launcherVisible = launcherPanel.isVisible();
  hasReceivedInitialServerState = true;
  if (!hasRestoredInitialLiveSession || (wasViewingLive && !launcherVisible)) {
    hasRestoredInitialLiveSession = true;
    restoreActiveLiveSession();
  } else {
    updateLiveSessionInputState();
    updateLiveSessionIndicators();
  }
}

// UI-only side effects of RPC events (compaction indicator, task-mode
// entries, tool cards). State for these same events already lives in the
// kernel stores (this fires after it was applied); nothing here writes state.
function handleKernelRpcEvent(event: AppEvent, sessionId: string | null) {
  // Keep tab recency ordering fresh (legacy touched LiveSession.lastActiveAt).
  if (sessionId) {
    dispatch({ type: 'session/updated', session: { id: sessionId, lastActiveAt: new Date().toISOString() } });
  }
  // Events for background sessions carry no active-view side effects; their
  // state (streaming flag, extension UI queue) is already in the stores.
  if (sessionId && (sessionId !== activeLiveSessionId || !viewingActiveSession)) return;
  switch (event.type) {
    case 'auto_compaction_start':
      handleCompactionStart();
      break;
    case 'auto_compaction_end':
      handleCompactionEnd(event);
      break;
    case 'extension_error':
      messageRenderer.renderError(`扩展错误：${event.error}`);
      break;
    case 'entry_appended':
      taskModeFeature.handleEntry(event.entry);
      break;
    case 'session_name':
      // Auto-title: update sidebar with new session name
      if (event.name) {
        const activeItem = document.querySelector('.session-item.active .session-title');
        if (activeItem) activeItem.textContent = event.name;
      }
      break;
    case 'tool_execution_start':
      toolExecutionController.start(event, sessionId ?? activeLiveSessionId);
      break;
    case 'tool_execution_update':
      toolExecutionController.update(event, sessionId ?? activeLiveSessionId);
      break;
    case 'tool_execution_end':
      toolExecutionController.end(event, sessionId ?? activeLiveSessionId);
      break;
  }
}

// ═══════════════════════════════════════
// Live-session tabs
// ═══════════════════════════════════════

const liveTabsList = document.getElementById('live-tabs-list');
const liveTabAddBtn = document.getElementById('live-tab-add');
const newLiveSessionOverlay = document.getElementById('new-live-session-overlay');
const newLiveSessionModal = document.getElementById('new-live-session-modal');
const newLiveSessionForm = document.getElementById('new-live-session-form');
const newLiveSessionName = document.getElementById('new-live-session-name') as HTMLInputElement;
const newLiveSessionCwd = document.getElementById('new-live-session-cwd') as HTMLInputElement;
const newLiveSessionCwdPreview = document.getElementById('new-live-session-cwd-preview');
const newLiveSessionModel = document.getElementById('new-live-session-model') as HTMLSelectElement;
const newLiveSessionSubmit = document.getElementById('new-live-session-submit') as HTMLButtonElement;
const DEFAULT_TASK_CWD = '/Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/scenario';

function handleLiveSessionClosed(closedId: string) {
  if (!closedId) return;
  const wasActive = activeLiveSessionId === closedId;
  const wasViewingActive = wasActive && viewingActiveSession;
  if (wasActive) {
    // Clear before dispatching so the session-store watcher does not re-enter.
    activeLiveSessionId = null;
    localStorage.removeItem('tau-active-live-session-id');
    activeLiveSessionFile = null;
  }
  // The kernel drops the session's conversation/tool/extension-UI state
  // (including any queued prompts) on session/closed.
  dispatch({ type: 'session/closed', sessionId: closedId });
  if (wasActive) {
    resetConversationView();
    showTypingIndicator(false);
    if (wasViewingActive) {
      messageRenderer.clear();
      toolCardRenderer.clear();
      const next = getMostRecentLiveSession();
      if (next) {
        void selectLiveSession(next.id);
      } else {
        featureRegistry.setSession(null, null);
        viewingActiveSession = false;
        messageRenderer.renderWelcome();
        updateLiveSessionInputState();
        updateUI();
      }
    } else {
      updateLiveSessionInputState();
      updateUI();
    }
  }
  renderLiveTabs();
  syncSidebarLiveSessions();
}

function getMostRecentLiveSession() {
  return [...getLiveSessions()].sort((a, b) =>
    new Date(b.lastActiveAt || b.createdAt || 0).getTime() - new Date(a.lastActiveAt || a.createdAt || 0).getTime()
  )[0] || null;
}

function basename(p: string) {
  return (p || '').split(/[/\\]/).filter(Boolean).pop() || p || '任务';
}

function compactModelLabel(session: LiveSession) {
  const raw = session.modelLabel || session.modelSpec || (session.model as ModelRecord)?.id || (session.model as ModelRecord)?.name || '默认';
  return String(raw).replace(/^.*\//, '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function liveTabSignature(session: LiveSession) {
  return [
    session.sessionName || basename(session.cwd || ''),
    compactModelLabel(session),
    session.cwd || '',
    session.modelSpec || '',
    isSessionStreaming(session.id) ? 'streaming' : 'idle',
    hasPendingExtensionUIRequest(session.id) ? 'ui' : '',
  ].join('\u001f');
}

function renderLiveTabs() {
  if (!liveTabsList) return;
  const existing = new Map<string, HTMLButtonElement>();
  liveTabsList.querySelectorAll<HTMLButtonElement>('.live-tab').forEach((tab) => {
    if (tab.dataset.sessionId) existing.set(tab.dataset.sessionId, tab);
  });
  const seen = new Set<string>();
  getLiveSessions().forEach((session, index) => {
    let tab = existing.get(session.id);
    if (!tab) {
      tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'live-tab';
      tab.dataset.sessionId = session.id;
      tab.addEventListener('click', () => selectLiveSession(session.id));
    }
    seen.add(session.id);
    tab.classList.toggle('active', session.id === activeLiveSessionId);
    tab.title = `${session.cwd || ''}${session.modelSpec ? ` • ${session.modelSpec}` : ''}`;
    const signature = liveTabSignature(session);
    if (tab.dataset.signature !== signature) {
      tab.dataset.signature = signature;
      tab.innerHTML = `
        ${isSessionStreaming(session.id) ? '<span class="live-tab-streaming-dot"></span>' : ''}
        ${hasPendingExtensionUIRequest(session.id) ? '<span class="live-tab-ui-dot" title="等待响应">?</span>' : ''}
        <span class="live-tab-title">${escapeHtml(session.sessionName || basename(session.cwd || ''))}</span>
        <span class="live-tab-model">${escapeHtml(compactModelLabel(session))}</span>
        <span class="live-tab-close" title="关闭任务">×</span>
      `;
      tab.querySelector('.live-tab-close')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeLiveSession(session.id);
      });
    }
    const currentAtIndex = liveTabsList.children[index];
    if (currentAtIndex !== tab) liveTabsList.insertBefore(tab, currentAtIndex || null);
  });
  for (const [id, tab] of existing) {
    if (!seen.has(id)) tab.remove();
  }
}

function restoreActiveLiveSession() {
  const saved = activeLiveSessionId && getLiveSessions().find(s => s.id === activeLiveSessionId);
  const next = saved || getMostRecentLiveSession();
  if (next) {
    void selectLiveSession(next.id);
  } else {
    activeLiveSessionId = null;
    featureRegistry.setSession(null, null);
    viewingActiveSession = false;
    activeLiveSessionFile = null;
    localStorage.removeItem('tau-active-live-session-id');
    resetConversationView();
    renderLiveTabs();
    updateLiveSessionInputState();
    updateUI();
  }
}

async function selectLiveSession(id: string, options: { keepCurrentMessagesOnFailure?: boolean } = {}) {
  const session = getLiveSessions().find(s => s.id === id);
  if (!session) return false;
  const previousFeatureSession = featureRegistry.sessionContext;
  launcherPanel.hide();
  activeLiveSessionId = id;
  // session/activated also suspends any open dialog belonging to another
  // session and promotes a queued one for this tab (extensionUi store).
  dispatch({ type: 'session/activated', sessionId: id });
  featureRegistry.setSession(id, id, true);
  localStorage.setItem('tau-active-live-session-id', id);
  viewingActiveSession = true;
  activeLiveSessionFile = session.sessionFile || null;
  sidebar.setActive(session.sessionFile || null, session.id);
  renderLiveTabs();
  renderQueuedMessages();
  applyActiveSessionMetadata(session);
  resetConversationView();
  messageRenderer.clear();
  toolCardRenderer.clear();
  try {
    const snapshot = await commands.session.loadSnapshot(id);
    // Hydrate the kernel stores first; the view renders from them below.
    dispatch({ type: 'session/snapshotReceived', sessionId: id, snapshot });
    applySnapshotMetadata(snapshot);
    renderFullConversation(id);
  } catch (e) {
    if (options.keepCurrentMessagesOnFailure) {
      dispatch({ type: 'session/closed', sessionId: id });
      if (activeLiveSessionId === id) {
        activeLiveSessionId = null;
        featureRegistry.setSession(previousFeatureSession.sessionKey, previousFeatureSession.resourceSessionId);
        localStorage.removeItem('tau-active-live-session-id');
        activeLiveSessionFile = null;
      }
      viewingActiveSession = false;
      resetConversationView();
      showTypingIndicator(false);
      renderLiveTabs();
      syncSidebarLiveSessions();
      updateLiveSessionInputState();
      updateUI();
      messageRenderer.renderSystemMessage('已打开历史记录；后台会话暂未恢复，当前不能继续提问。');
    } else {
      handleLiveSessionClosed(id);
      messageRenderer.renderError((e instanceof Error ? e.message : '') || '加载任务快照失败');
    }
    return false;
  }
  workspaceController.refreshForSessionChange();
  updateLiveSessionInputState();
  updateUI();
  return true;
}

function applyActiveSessionMetadata(session: LiveSession) {
  if (!session) return;
  // Server is canonical: session.model is always null or a full {provider,id}
  // object, so assign directly. No modelLabel/modelSpec string fallbacks.
  modelPickerController.setModelState(session.model || '', session.thinkingLevel || 'off');
}

async function closeLiveSession(id: string) {
  const session = getLiveSessions().find(s => s.id === id);
  if (!session) return;
  const streaming = isSessionStreaming(id);
  const hasQueuedMessages = (stores.conversation.get().bySession[id]?.live.queued.length ?? 0) > 0;
  if (streaming || hasQueuedMessages) {
    const reason = streaming && hasQueuedMessages
      ? '这个交通任务正在执行，且还有排队未发送的消息。确定关闭任务、终止 Pi 会话并丢弃队列吗？'
      : streaming
        ? '这个交通任务正在执行。确定关闭任务并终止 Pi 会话吗？'
        : '这个交通任务还有排队未发送的消息。确定关闭并丢弃吗？';
    if (!confirm(reason)) return;
  }
  try {
    await commands.session.close(id);
  } catch (e) {
    messageRenderer.renderError('关闭任务失败');
  }
}

function currentNewSessionCwd() {
  return DEFAULT_TASK_CWD;
}

function updateNewSessionCwdPreview() {
  if (!newLiveSessionCwdPreview) return;
  const cwd = currentNewSessionCwd();
  const name = newLiveSessionName.value.trim() || '会话名称';
  newLiveSessionCwdPreview.textContent = `将在 ${cwd} 下创建新目录：时间-${name}`;
}

function modelOptionValue(model: ModelRecord | string) {
  if (typeof model === 'string') return model;
  const provider = model?.provider || '';
  const id = model?.id || model?.model || model?.name || '';
  return provider && id ? `${provider}/${id}` : '';
}

function modelOptionLabel(model: ModelRecord | string) {
  if (typeof model === 'string') return model;
  const value = modelOptionValue(model);
  const context = model.contextWindow || model.context || model.context_window;
  return context ? `${value} · ${context}` : value;
}

async function loadModelOptions() {
  const selectedModel = newLiveSessionModel.value;
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = '使用 Pi 默认模型';
  newLiveSessionModel.replaceChildren(defaultOption);
  try {
    const res = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_available_models', sessionId: activeLiveSessionId }),
    });
    const data = await res.json();
    const models: Array<ModelRecord | string> = data.success && Array.isArray(data.data?.models) ? data.data.models : [];
    if (!models.length) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '暂无已有模型';
      empty.disabled = true;
      newLiveSessionModel.appendChild(empty);
      return;
    }
    const seen = new Set<string>();
    for (const model of models) {
      const value = modelOptionValue(model);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      const option = document.createElement('option');
      option.value = value;
      option.textContent = modelOptionLabel(model);
      newLiveSessionModel.appendChild(option);
    }
    if (selectedModel && seen.has(selectedModel)) newLiveSessionModel.value = selectedModel;
  } catch {
    const error = document.createElement('option');
    error.value = '';
    error.textContent = '模型列表加载失败';
    error.disabled = true;
    newLiveSessionModel.appendChild(error);
  }
}

function openNewLiveSessionModal() {
  newLiveSessionOverlay?.classList.remove('hidden');
  newLiveSessionModal?.classList.remove('hidden');
  newLiveSessionSubmit.disabled = false;
  newLiveSessionName.value = '';
  const cwd = currentNewSessionCwd();
  newLiveSessionCwd.value = cwd;
  updateNewSessionCwdPreview();
  loadModelOptions();
  requestAnimationFrame(() => newLiveSessionName?.focus());
}

function closeNewLiveSessionModal() {
  newLiveSessionOverlay?.classList.add('hidden');
  newLiveSessionModal?.classList.add('hidden');
}

liveTabAddBtn?.addEventListener('click', openNewLiveSessionModal);
document.getElementById('new-live-session-close')?.addEventListener('click', closeNewLiveSessionModal);
document.getElementById('new-live-session-cancel')?.addEventListener('click', closeNewLiveSessionModal);
newLiveSessionOverlay?.addEventListener('click', closeNewLiveSessionModal);
newLiveSessionName?.addEventListener('input', updateNewSessionCwdPreview);
newLiveSessionForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = newLiveSessionName.value.trim();
  const cwd = newLiveSessionCwd.value.trim();
  if (!name) return;
  newLiveSessionSubmit.disabled = true;
  newLiveSessionSubmit.textContent = '正在启动...';
  try {
    const session = await commands.session.create({ cwd, name, model: newLiveSessionModel.value.trim() });
    dispatch({ type: 'session/created', session });
    closeNewLiveSessionModal();
    newLiveSessionName.value = '';
    newLiveSessionModel.value = '';
    await selectLiveSession(session.id);
  } catch (err) {
    messageRenderer.renderError((err instanceof Error ? err.message : '') || '创建任务失败');
  } finally {
    newLiveSessionSubmit.disabled = false;
    newLiveSessionSubmit.textContent = '创建任务';
  }
});

// ═══════════════════════════════════════
// Live conversation view — renders the kernel conversation store
// ═══════════════════════════════════════

// Reset view-local rendering bookkeeping on session switch/close.
function resetConversationView() {
  streamingElement = null;
  streamingThinkingStartedAt = null;
  streamingThinkingEndedAt = null;
  renderedEntryCount = 0;
  optimisticPromptRendered = false;
}

// Full re-render after a snapshot hydrate (session switch / restore).
function renderFullConversation(sessionId: string) {
  const conv = stores.conversation.get().bySession[sessionId];
  messageRenderer.clear();
  toolCardRenderer.clear();
  sessionTotalCost = 0;
  lastInputTokens = 0;
  lastUsage = null;
  resetConversationView();
  const entries = conv?.snapshotEntries ?? [];
  if (entries.length > 0) {
    renderSessionHistory(entries);
  } else {
    messageRenderer.renderWelcome();
  }
  renderedEntryCount = entries.length;
  updateContextPill();
  // A live session just loaded — fetch its authoritative stats from pi.
  void sessionStatsCard.refresh();
}

// Render one newly appended store entry (message_end / echo / fold-over).
function renderLiveEntry(entry: SessionEntry) {
  if (entry.type !== 'message') return;
  const message = entry.message;
  if (!message) return;
  if (message.role === 'user') {
    const content = messageText(message);
    if (content) messageRenderer.renderUserMessage({ content });
    return;
  }
  if (message.role === 'assistant') {
    if (streamingElement) finalizeStreamingEntry(message);
    else messageRenderer.renderAssistantMessage(message, false, true);
    return;
  }
  if (message.role === 'toolResult') {
    toolExecutionController.restoreToolResult(message, activeLiveSessionId);
  }
}

// The store already reconciled the authoritative message_end payload with
// the locally streamed deltas; the view only re-renders what the store holds.
function finalizeStreamingEntry(message: AppMessage) {
  const element = streamingElement;
  if (!element) return;
  const finalText = messageText(message);
  const finalThinking = messageThinking(message);
  if (streamingThinkingStartedAt !== null && streamingThinkingEndedAt === null) streamingThinkingEndedAt = Date.now();
  const thinkingDuration = streamingThinkingStartedAt !== null && streamingThinkingEndedAt !== null
    ? streamingThinkingEndedAt - streamingThinkingStartedAt
    : undefined;
  if (finalText) messageRenderer.updateStreamingMessage(element, finalText);
  if (finalThinking) messageRenderer.updateStreamingThinking(element, finalThinking, thinkingDuration);
  if (finalThinking && thinkingDuration !== undefined) {
    rememberThinkingDuration(message, 0, thinkingDuration, activeLiveSessionId);
  }
  messageRenderer.finalizeStreamingMessage(element, message.usage || null, finalThinking, thinkingDuration);
  streamingElement = null;
  streamingThinkingStartedAt = null;
  streamingThinkingEndedAt = null;

  // Track session cost and tokens
  const usage = message.usage;
  if (usage?.cost?.total) sessionTotalCost += usage.cost.total;
  if (usage?.input) {
    lastInputTokens = usage.input + (usage.cacheRead || 0);
    lastUsage = usage;
  }
  updateContextPill();
  showNewMessageBadge();
}

function ensureStreamingElement() {
  if (!streamingElement) {
    streamingElement = messageRenderer.renderAssistantMessage({ content: '' }, true);
  }
  return streamingElement;
}

// Overlay deltas live in the store; the view mirrors them into the DOM.
function renderStreamingOverlay(live: { streamingText: string; streamingThinking: string }) {
  if (live.streamingThinking) {
    const element = ensureStreamingElement();
    if (streamingThinkingStartedAt === null) {
      streamingThinkingStartedAt = Date.now();
      streamingThinkingEndedAt = null;
    }
    const thinkingDuration = (streamingThinkingEndedAt || Date.now()) - streamingThinkingStartedAt;
    messageRenderer.updateStreamingThinking(element, live.streamingThinking, thinkingDuration);
  }
  if (live.streamingText) {
    const element = ensureStreamingElement();
    if (streamingThinkingStartedAt !== null && streamingThinkingEndedAt === null) {
      streamingThinkingEndedAt = Date.now();
      messageRenderer.updateStreamingThinking(element, live.streamingThinking, streamingThinkingEndedAt - streamingThinkingStartedAt);
    }
    messageRenderer.updateStreamingMessage(element, live.streamingText);
  }
}

// Conversation store subscription: incremental entries, optimistic prompts,
// the streaming overlay and the queued-message strip for the active view.
function handleConversationChange() {
  renderQueuedMessages();
  if (!viewingActiveSession || !activeLiveSessionId) return;
  const conv = stores.conversation.get().bySession[activeLiveSessionId];
  if (!conv) return;
  const entries = conv.snapshotEntries;
  if (renderedEntryCount > entries.length) renderedEntryCount = 0;
  for (let i = renderedEntryCount; i < entries.length; i++) renderLiveEntry(entries[i]);
  renderedEntryCount = entries.length;
  const optimistic = conv.live.optimisticPrompt;
  if (optimistic && !optimisticPromptRendered) {
    messageRenderer.renderUserMessage({ content: optimistic.message, images: optimistic.images });
    optimisticPromptRendered = true;
  } else if (!optimistic) {
    optimisticPromptRendered = false;
  }
  renderStreamingOverlay(conv.live);
}

function handleCompactionStart() {
  const el = document.createElement('div');
  el.className = 'system-message compaction-message';
  el.id = 'compaction-indicator';
  el.innerHTML = '<span class="compaction-spinner">⟳</span> 正在压缩上下文...';
  messagesContainer.appendChild(el);
  scrollToBottom();
}

function handleCompactionEnd(event: AppEvent) {
  const indicator = document.getElementById('compaction-indicator');
  if (indicator) {
    const summary = event.summary ? ` - ${event.summary}` : '';
    indicator.innerHTML = `✓ 上下文已压缩${summary}`;
    indicator.classList.add('compaction-done');
  }
  // Reset token tracking — the stats refresh below and the next message
  // bring in fresh post-compaction numbers.
  lastInputTokens = 0;
  updateContextPill();
  hideCompactButton();
  void sessionStatsCard.refresh();
}

// ═══════════════════════════════════════
// Extension UI dialogs — rendered from the kernel extensionUi store
// ═══════════════════════════════════════

function hasPendingExtensionUIRequest(sessionId: string) {
  return stores.extensionUi.get().queue.some((pending) => pending.sessionId === sessionId);
}

function showExtensionUIDialog(sessionId: string | null, event: AppEvent) {
  const request = (sessionId ? { ...event, sessionId } : event) as DialogRequest;
  if (event.method === 'select') dialogHandler.showSelect(request);
  else if (event.method === 'confirm') dialogHandler.showConfirm(request);
  else if (event.method === 'input') dialogHandler.showInput(request);
  else if (event.method === 'editor') dialogHandler.showEditor(request);
  else if (event.method === 'notify') dialogHandler.showNotification(request);
  else console.warn('[ExtensionUI] Unknown method:', event.method);
}

// Mirror the store's current request into the DOM. Background requests stay
// queued (tab badge) and never take over the visible dialog; a request for
// the active session only shows while the live view is actually visible.
let shownDialogKey: string | null = null;
function syncExtensionUIDialog() {
  const { current } = stores.extensionUi.get();
  const showable = current && (current.sessionId === null || (current.sessionId === activeLiveSessionId && viewingActiveSession));
  if (!showable) {
    if (shownDialogKey !== null) {
      shownDialogKey = null;
      dialogHandler.clearCurrentDialog();
    }
    return;
  }
  const key = `${current.sessionId ?? ''}:${current.request.id ?? ''}`;
  if (key === shownDialogKey) return;
  shownDialogKey = key;
  showExtensionUIDialog(current.sessionId, current.request);
}

// ═══════════════════════════════════════
// Input handling — textarea with auto-resize
// ═══════════════════════════════════════

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

messageInput.addEventListener('keydown', (e) => {
  // Enter sends, Shift+Enter inserts newline
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
});

// ═══════════════════════════════════════
// Attachments (images + file browser paths)
// ═══════════════════════════════════════

const attachBtn = document.getElementById('attach-btn')!;
const imageInput = document.getElementById('image-input')!;
const imagePreviews = document.getElementById('image-previews')!;

let pendingImages: PendingImage[] = [];     // { data: base64, mimeType }
let pendingFilePaths: PendingFilePath[] = [];  // { path, name, ext } — from file browser (populated by callback above)

const MAX_IMAGE_DIM = 2048;
const VALID_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);

function getFileChipIcon(name: string) {
  return getFileIcon(name || 'file', false);
}

function processImageFile(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const mimeType = VALID_MIME_TYPES.includes(file.type) ? file.type : 'image/png';

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
          const scale = MAX_IMAGE_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')?.drawImage(img, 0, 0, width, height);

        const outputMime = (mimeType === 'image/jpeg') ? 'image/jpeg' : 'image/png';
        const quality = (outputMime === 'image/jpeg') ? 0.85 : undefined;
        const dataUrl = canvas.toDataURL(outputMime, quality);
        const base64 = dataUrl.split(',')[1];
        if (!base64) { reject(new Error('图片编码失败')); return; }
        resolve({ data: base64, mimeType: outputMime });
      };
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

async function addAttachments(files: FileList | File[]) {
  const list = Array.from(files);            // snapshot before any await
  for (const file of list) {
    if (!file.type.startsWith('image/')) continue;
    try {
      pendingImages.push(await processImageFile(file));
    } catch (e) {
      console.error('[Tau] Image processing failed:', e);
    }
  }
  renderAttachmentPreviews();
}

attachBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', () => {
  addAttachments(imageInput.files ?? []);
  imageInput.value = '';
});

// Drag & drop on input
messageInput.addEventListener('dragover', (e) => { e.preventDefault(); });
messageInput.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files.length > 0) addAttachments(e.dataTransfer.files);
});

// Paste images
messageInput.addEventListener('paste', (e) => {
  if (!e.clipboardData) return;
  const files: File[] = [];
  for (const item of e.clipboardData.items) {
    if (!item.type.startsWith('image/')) continue;
    files.push(item.getAsFile() as File);
  }
  if (files.length) addAttachments(files);
});

function makeRemoveBtn(onClick: () => void) {
  const btn = document.createElement('button');
  btn.className = 'image-preview-remove';
  btn.setAttribute('aria-label', '移除');
  btn.textContent = '✕';
  btn.addEventListener('click', onClick);
  return btn;
}

function renderAttachmentPreviews() {
  imagePreviews.innerHTML = '';
  const hasAny = pendingImages.length > 0 || pendingFilePaths.length > 0;
  if (!hasAny) { imagePreviews.classList.add('hidden'); return; }
  imagePreviews.classList.remove('hidden');

  // Binary image chips
  pendingImages.forEach((img, i) => {
    const el = document.createElement('div');
    el.className = 'image-preview';
    const thumb = document.createElement('img');
    thumb.src = `data:${img.mimeType};base64,${img.data}`;
    el.appendChild(thumb);
    el.appendChild(makeRemoveBtn(() => { pendingImages.splice(i, 1); renderAttachmentPreviews(); }));
    imagePreviews.appendChild(el);
  });

  // File browser path chips
  pendingFilePaths.forEach((fp, i) => {
    const el = document.createElement('div');
    const removeBtn = makeRemoveBtn(() => {
      const withSpace = fp.path + ' ';
      messageInput.value = messageInput.value.includes(withSpace)
        ? messageInput.value.replace(withSpace, '')
        : messageInput.value.replace(fp.path, '');
      messageInput.dispatchEvent(new Event('input'));
      pendingFilePaths.splice(i, 1);
      renderAttachmentPreviews();
    });

    if (IMAGE_EXTS.has(fp.ext)) {
      el.className = 'image-preview';
      el.title = fp.path;
      const thumb = document.createElement('img');
      thumb.style.cssText = 'width:100%;height:100%;object-fit:cover';
      const previewParams = new URLSearchParams({ path: fp.path });
      if (fp.sessionId) previewParams.set('sessionId', fp.sessionId);
      thumb.src = `/api/file/preview?${previewParams.toString()}`;
      thumb.onerror = () => {
        el.classList.add('file-chip');
        thumb.remove();
        const icon = document.createElement('span');
        icon.className = 'file-chip-icon';
        icon.textContent = getFileChipIcon(fp.name);
        const label = document.createElement('span');
        label.className = 'file-chip-name';
        label.textContent = fp.name;
        el.insertBefore(label, removeBtn);
        el.insertBefore(icon, label);
      };
      el.appendChild(thumb);
    } else {
      el.className = 'image-preview file-chip';
      el.title = fp.path;
      const icon = document.createElement('span');
      icon.className = 'file-chip-icon';
      icon.textContent = getFileChipIcon(fp.ext);
      const label = document.createElement('span');
      label.className = 'file-chip-name';
      label.textContent = fp.name;
      el.appendChild(icon);
      el.appendChild(label);
    }

    el.appendChild(removeBtn);
    imagePreviews.appendChild(el);
  });
}

// ═══════════════════════════════════════
// Send message (with images)
// ═══════════════════════════════════════

function sendMessage() {
  const message = messageInput.value.trim();
  if (!message && pendingImages.length === 0) return;

  messageInput.value = '';
  messageInput.style.height = 'auto';

  let images: PendingImage[] | undefined;
  if (pendingImages.length > 0) {
    images = pendingImages.map(img => {
      console.log(`[Tau] Sending image: mimeType=${img.mimeType}, dataLen=${img.data?.length}`);
      return { type: 'image', data: img.data, mimeType: img.mimeType || 'image/png' } as PendingImage;
    });
    pendingImages = [];
  }

  pendingFilePaths = [];
  renderAttachmentPreviews();

  if (!activeLiveSessionId) {
    messageRenderer.renderError('请先创建或选择一个交通任务。');
    updateLiveSessionInputState();
    return;
  }

  // The kernel renders an optimistic prompt immediately, or queues it while
  // the session is streaming and flushes it when the run ends.
  void commands.agent.sendPrompt({
    sessionId: activeLiveSessionId,
    message: message || '（见附加图片）',
    images,
  });
}

const queuedMessagesEl = document.getElementById('queued-messages')!;

function renderQueuedMessages() {
  queuedMessagesEl.innerHTML = '';
  const queued = activeLiveSessionId
    ? stores.conversation.get().bySession[activeLiveSessionId]?.live.queued ?? []
    : [];
  if (queued.length === 0) {
    queuedMessagesEl.classList.add('hidden');
    return;
  }
  queuedMessagesEl.classList.remove('hidden');
  queued.forEach((cmd, i) => {
    const el = document.createElement('div');
    el.className = 'queued-msg';
    el.innerHTML = `
      <span class="queued-msg-label">排队中</span>
      <span class="queued-msg-text">${escapeHtml(cmd.message || '')}</span>
      <button class="queued-msg-cancel" title="取消">×</button>
    `;
    el.querySelector('.queued-msg-cancel')?.addEventListener('click', () => {
      if (activeLiveSessionId) {
        dispatch({ type: 'conversation/queueItemRemoved', sessionId: activeLiveSessionId, index: i });
      }
    });
    queuedMessagesEl.appendChild(el);
  });
}

function escapeHtml(text: string) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

abortBtn.addEventListener('click', () => {
  if (!viewingActiveSession || !activeLiveSessionId) return;
  void commands.agent.abort(activeLiveSessionId);
  messageRenderer.renderError('已由用户中止');
  showTypingIndicator(false);
});

// Command Palette
const commandPaletteController = setupCommandPalette([
  { icon: '🗜️', label: '压缩上下文', desc: '压缩上下文以节省 token', action: () => rpcCommand({ type: 'compact' }, '正在压缩...') },
  { icon: '📋', label: '导出 HTML', desc: '将当前会话导出为 HTML 文件', action: () => rpcExportHtml() },
  { icon: '📊', label: '会话统计', desc: '查看当前会话统计', action: () => showSessionStats() },
  { icon: '⬇️', label: '展开全部工具', desc: '展开所有工具调用卡片', action: () => toolCardRenderer.expandAll() },
  { icon: '⬆️', label: '收起全部工具', desc: '收起所有工具调用卡片', action: () => toolCardRenderer.collapseAll() },
]);

async function rpcCommand(cmd: RpcCommand, statusMsg = '') {
  try {
    const backendLocalCommands = new Set(['get_auth', 'set_auth', 'get_available_models']);
    const needsLiveSession = !cmd.sessionId && !cmd.filePath && !backendLocalCommands.has(cmd.type);
    if (needsLiveSession && (!viewingActiveSession || !activeLiveSessionId)) {
      const error = '请先选择一个正在运行的交通任务。';
      setStatusMessage(error, stores.runtime.get().connection === 'connected' ? '已连接' : '已断开', 3000);
      return { type: 'response', command: cmd.type, success: false, error };
    }
    if (!cmd.sessionId && viewingActiveSession && activeLiveSessionId) cmd = { ...cmd, sessionId: activeLiveSessionId };
    if (statusMsg) setStatusMessage(statusMsg);
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    const data = await resp.json();
    if (data.success) {
      setStatusMessage('已完成', '已连接', 2000);
    } else {
      setStatusMessage(data.error || '失败', '已连接', 3000);
    }
    return data;
  } catch (e) {
    setStatusMessage('出错', '已连接', 3000);
  }
}

async function rpcExportHtml() {
  const data = await rpcCommand({ type: 'export_html' }, '正在导出...');
  if (data?.success && data.data?.path) {
    setStatusMessage(`已导出：${data.data.path}`, '已连接', 4000);
  }
}

async function showSessionStats() {
  const data = await rpcCommand({ type: 'get_session_stats' }, '正在加载统计...');
  if (data?.success && data.data) {
    const s = data.data;
    const lines = [
      `📊 会话统计`,
      `消息：${s.totalMessages}（用户 ${s.userMessages}，助手 ${s.assistantMessages}）`,
      `工具调用：${s.toolCalls}`,
    ];
    if (s.tokens) {
      lines.push(`上下文：约 ${(s.tokens.input / 1000).toFixed(1)}k tokens`);
    }
    messageRenderer.renderSystemMessage(lines.join('\n'));
  }
}

// Model Picker
const modelPickerController = setupModelPicker({
  getActiveLiveSessionId: () => activeLiveSessionId,
  isViewingActiveSession: () => viewingActiveSession,
  rpcCommand,
  flashStatusError,
  escapeHtml,
  setContextWindowSize(value) { contextWindowSize = value; },
  updateContextPill,
});

// ═══════════════════════════════════════
// Keyboard shortcuts
// ═══════════════════════════════════════

document.addEventListener('keydown', (e) => {
  // Escape — Abort streaming, or close sidebar on mobile
  if (e.key === 'Escape') {
    // Close palettes/panels first
    if (modelPickerController.closeIfOpen()) return;
    if (!settingsPanel.classList.contains('hidden')) {
      closeSettings();
      return;
    }
    if (commandPaletteController.closeIfOpen()) return;

    if (isActiveStreaming() && activeLiveSessionId) {
      void commands.agent.abort(activeLiveSessionId);
      messageRenderer.renderError('已由用户中止');
      showTypingIndicator(false);
    } else if (!sidebarEl.classList.contains('collapsed') && window.innerWidth <= 768) {
      toggleSidebar();
    }
  }

  // / — Focus message input (when not already in an input)
  if (e.key === '/' && !isInInput()) {
    e.preventDefault();
    messageInput.focus();
  }
});

function isInInput() {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
}

// ═══════════════════════════════════════
// Sidebar
// ═══════════════════════════════════════

function isMobile() {
  return window.innerWidth <= 768;
}

function updateSidebarToggleIcon() {
  sidebarToggle.textContent = '☰';
}

function toggleSidebar() {
  sidebarEl.classList.toggle('collapsed');
  sidebarOverlay.classList.toggle('visible', !sidebarEl.classList.contains('collapsed') && isMobile());
  updateSidebarToggleIcon();
}

sidebarToggle.addEventListener('click', toggleSidebar);

sidebarOverlay.addEventListener('click', () => {
  sidebarEl.classList.add('collapsed');
  sidebarOverlay.classList.remove('visible');
  updateSidebarToggleIcon();
});



const newSessionBtn = document.getElementById('new-session-btn')!;
newSessionBtn.addEventListener('click', openNewLiveSessionModal);

refreshSessionsBtn.addEventListener('click', () => {
  if (isMobile()) {
    location.reload();
    return;
  }
  refreshSessionsBtn.classList.add('spinning');
  sidebar.loadSessions().then(() => {
    setTimeout(() => refreshSessionsBtn.classList.remove('spinning'), 600);
    updateLiveSessionIndicators();
  });
});

// Swipe from left edge to open sidebar on mobile
(function initSwipeGesture() {
  let touchStartX = 0;
  let touchStartY = 0;
  let tracking = false;

  document.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    // Only track swipes starting within 20px of left edge
    if (touch.clientX < 20 && isMobile() && sidebarEl.classList.contains('collapsed')) {
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      tracking = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartX;
    const dy = Math.abs(touch.clientY - touchStartY);
    // If vertical movement dominates, cancel
    if (dy > dx) {
      tracking = false;
    }
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    if (dx > 60) {
      sidebarEl.classList.remove('collapsed');
      sidebarOverlay.classList.add('visible');
    }
  }, { passive: true });
})();

// Session search
sessionSearchInput.addEventListener('input', () => {
  sidebar.setSearchQuery(sessionSearchInput.value);
});

async function newSession() {
  sessionTotalCost = 0;
  lastInputTokens = 0;
  lastUsage = null;
  updateContextPill();
  await switchSession(null);
  sidebar.clearActive();
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
  if (!isMobile()) messageInput.focus();
}

async function handleSessionSelect(session: SidebarSession | null, project: SidebarProject | null) {
  if (session) sidebar.setActive(session.filePath, session.liveSessionId);
  sessionTotalCost = 0;
  lastInputTokens = 0;
  lastUsage = null;
  updateContextPill();
  if (session?.liveSessionId) await selectLiveSession(session.liveSessionId);
  else if (session) await switchSession(session.filePath, session, project);

  // Close sidebar on mobile after selecting
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
}

async function renderHistoricalSession(sessionFile: string) {
  try {
    featureRegistry.setSession(`history:${sessionFile}`, null, true);
    const snapshot = await commands.session.loadHistory(sessionFile);
    messageRenderer.clear();
    toolCardRenderer.clear();
    sessionTotalCost = 0;
    lastInputTokens = 0;
    lastUsage = null;
    renderSessionHistory(snapshot.entries || []);
    return true;
  } catch (e) {
    messageRenderer.clear();
    messageRenderer.renderError((e instanceof Error ? e.message : '') || '历史记录加载失败');
    return false;
  }
}

async function switchSession(sessionFile: string | null | undefined, session: SidebarSession | null = null, project: SidebarProject | null = null) {
  try {
    // Clear any streaming view state from the previous session to prevent bleed
    resetConversationView();
    viewingActiveSession = false;

    showTypingIndicator(false);
    updateUI();
    messageRenderer.clear();
    toolCardRenderer.clear();

    // Clicking a historical session resumes it as a live backend Tau tab.
    // selectLiveSession() will load the resumed tab snapshot with the same
    // historical entries after the backend has attached to the session file.
    if (sessionFile) {
      const hasHistoricalView = await renderHistoricalSession(sessionFile);
      viewingActiveSession = false;
      updateLiveSessionInputState();
      updateUI();

      const live = getLiveSessions().find(s => s.sessionFile === sessionFile);
      if (live) {
        await selectLiveSession(live.id, { keepCurrentMessagesOnFailure: hasHistoricalView });
        return;
      }
      // No live tab yet — ask the server to resume this session.
      try {
        const resumed = await commands.session.resume({ filePath: sessionFile, ...(project?.path ? { cwd: project.path } : {}) });
        dispatch({ type: 'session/created', session: resumed });
        await selectLiveSession(resumed.id, { keepCurrentMessagesOnFailure: hasHistoricalView });
      } catch (e) {
        // Server-rejected resume clears the history view; a network failure
        // keeps it and only notes the missing backend.
        const isNetworkError = (e as { code?: string })?.code === 'http_network_error';
        if (hasHistoricalView && isNetworkError) {
          messageRenderer.renderSystemMessage('已打开历史记录；后台会话暂未恢复，当前不能继续提问。');
        } else {
          messageRenderer.clear();
          messageRenderer.renderError((e instanceof Error ? e.message : '') || '恢复会话失败');
        }
        viewingActiveSession = false;
        updateLiveSessionInputState();
        updateUI();
      }
      return;
    }

    messageRenderer.renderWelcome();
  } catch (error) {
    console.error('[App] Failed to switch session:', error);
    messageRenderer.renderError('切换会话失败');
  }
}

// ═══════════════════════════════════════
// Live-session snapshot sync
// ═══════════════════════════════════════

// Apply snapshot metadata that is view-only (model picker, context window,
// active session file). Entries and streaming state went into the kernel
// stores via session/snapshotReceived before this runs.
function applySnapshotMetadata(snapshot: SessionSnapshot) {
  activeLiveSessionFile = snapshot.sessionFile || snapshot.session?.sessionFile || null;
  if (activeLiveSessionId) sidebar.setActive(activeLiveSessionFile, activeLiveSessionId);

  // Update model display — server is canonical, assign directly.
  if (snapshot.model !== undefined) {
    if (snapshot.model?.contextWindow) {
      contextWindowSize = Number(snapshot.model.contextWindow) || 0;
    }
    modelPickerController.setModelState(snapshot.model || '', snapshot.thinkingLevel || 'off');
  } else if (snapshot.thinkingLevel) {
    modelPickerController.setThinkingLevel(snapshot.thinkingLevel || 'off');
  }
}

// Mark all live sessions in the sidebar with a green dot
function updateLiveSessionIndicators() {
  const liveFiles = new Set(liveInstances.map(i => i.sessionFile));
  const liveIds = new Set(getLiveSessions().map(s => s.id));
  // Also include the current active live session
  if (activeLiveSessionFile) liveFiles.add(activeLiveSessionFile);

  document.querySelectorAll('.session-item').forEach(el => {
    const hasLiveFile = !!el.dataset.filePath && liveFiles.has(el.dataset.filePath);
    const hasLiveId = !!el.dataset.liveSessionId && liveIds.has(el.dataset.liveSessionId);
    el.classList.toggle('has-live-session', hasLiveFile || hasLiveId);
  });
}

// Refresh the live-session list for sidebar indicators if WS missed an
// update. The store replaces its list; a vanished active session is handled
// by the session-store subscription watcher.
async function pollInstances() {
  try {
    const sessions = await commands.session.list();
    dispatch({ type: 'session/listReceived', sessions });
  } catch {}
}

// Poll every 10 seconds
setInterval(pollInstances, 10000);

// Enable/disable input based on whether we're viewing a live backend Tau tab
function updateLiveSessionInputState() {
  const inputArea = document.querySelector('.input-area');
  const hasLiveSession = viewingActiveSession && !!activeLiveSessionId;
  if (hasLiveSession) {
    messageInput.disabled = false;
    sendBtn.disabled = false;
    messageInput.placeholder = '输入交通问题或 Pi 指令...';
    inputArea?.classList.remove('no-active-live-session');
  } else {
    messageInput.disabled = true;
    sendBtn.disabled = true;
    messageInput.placeholder = hasReceivedInitialServerState ? '请创建或选择一个交通任务' : '正在连接...';
    inputArea?.classList.add('no-active-live-session');
  }
  document.getElementById('command-btn')!.disabled = !hasLiveSession;
  modelPickerController.setEnabled(hasLiveSession);
}

// ═══════════════════════════════════════
// Session history rendering
// ═══════════════════════════════════════

function renderSessionHistory(entries: SessionHistoryEntry[]) {
  console.log(`[History] Rendering ${entries.length} entries`);
  let userCount = 0, assistantCount = 0, toolCardCount = 0, toolResultCount = 0;
  taskModeFeature.restoreModeFromEntries(entries);

  for (const entry of entries) {
    if (entry.type !== 'message') continue;

    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === 'user') {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : (msg.content || [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
      // Extract images from content blocks
      const images = Array.isArray(msg.content)
        ? msg.content
            .filter((b) => b.type === 'image')
            .map((b) => ({ data: b.source?.data || b.data || '', mimeType: b.source?.media_type || b.media_type || 'image/png' }))
        : [];
      if (content || images.length > 0) {
        userCount++;
        messageRenderer.renderUserMessage({ content: content || '', images: images.length > 0 ? images : undefined }, true);
      }
    } else if (msg.role === 'assistant') {
      const textBlocks = ((msg.content as MessageContentBlock[]) || []).filter((b) => b.type === 'text');
      const thinkingBlocks = ((msg.content as MessageContentBlock[]) || []).filter((b) => b.type === 'thinking');
      const toolCalls = ((msg.content as MessageContentBlock[]) || []).filter((b) => b.type === 'toolCall');

      // Build content blocks for rendering
      const contentBlocks = [];
      let thinkingIndex = 0;
      for (const block of (msg.content as MessageContentBlock[]) || []) {
        if (block.type === 'thinking') {
          contentBlocks.push({
            ...block,
            durationMs: getRememberedThinkingDuration(msg, thinkingIndex++),
          });
        } else if (block.type === 'text') {
          contentBlocks.push(block);
        }
      }

      const text = textBlocks.map((b) => b.text).join('\n');

      if (text || thinkingBlocks.length > 0) {
        assistantCount++;
        messageRenderer.renderAssistantMessage(
          {
            content: contentBlocks.length > 0 ? contentBlocks : text,
            usage: msg.usage,
          },
          false,
          true
        );

        // Track cost and tokens from history
        if (msg.usage?.cost?.total) {
          sessionTotalCost += msg.usage.cost.total;
        }
        if (msg.usage?.input) {
          lastInputTokens = msg.usage.input + (msg.usage.cacheRead || 0);
          lastUsage = msg.usage;
        }
      }

      // Show tool calls as compact history cards
      for (const tc of toolCalls) {
        toolCardCount++;
        const card = toolCardRenderer.createHistoryCard({
          toolCallId: tc.id,
          toolName: tc.name,
          args: tc.arguments || {},
          durationMs: getRememberedToolDuration(String(tc.id || '')),
        });
        console.log(`[History] Tool card created: ${tc.name}`, card?.offsetHeight, card?.innerHTML?.substring(0, 100));
      }
    } else if (msg.role === 'toolResult') {
      toolResultCount++;
      toolCardRenderer.addHistoryResult(
        msg.toolCallId ?? '',
        { content: (msg.content as MessageContentBlock[]) || [], details: msg.details },
        msg.isError ?? false
      );
      if (featureRegistry.sessionKey) {
        toolExecutionController.restoreToolResult(msg, featureRegistry.sessionKey);
      }
    }
  }

  console.log(`[History] Done: ${userCount} users, ${assistantCount} assistants, ${toolCardCount} tools, ${toolResultCount} results`);
  console.log(`[History] DOM tool-card count:`, document.querySelectorAll('.tool-card').length);
  console.log(`[History] DOM thinking-block count:`, document.querySelectorAll('.thinking-block').length);

  updateContextPill();
  fetchContextWindow();

  // Jump to bottom instantly (no smooth scroll animation)
  messagesContainer.style.scrollBehavior = 'auto';
  requestAnimationFrame(() => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    // Restore smooth scrolling after a frame
    requestAnimationFrame(() => {
      messagesContainer.style.scrollBehavior = '';
    });
  });
}

// ═══════════════════════════════════════
// UI helpers
// ═══════════════════════════════════════

function showTypingIndicator(show: boolean) {
  typingIndicator.classList.toggle('hidden', !show);
}

// The single header pill: shows context usage %, falling back to raw tokens
// (no context window info yet) or session cost (no context data yet).
// Clicking it opens the session stats card.
function updateContextPill() {
  if (lastInputTokens > 0 && contextWindowSize > 0) {
    const pct = Math.round((lastInputTokens / contextWindowSize) * 100);
    contextPillEl.textContent = pct === 0 ? '<1%' : `${pct}%`;
    contextPillEl.classList.add('visible');
    contextPillEl.classList.remove('warning', 'critical');
    if (pct >= 80) {
      contextPillEl.classList.add('critical');
    } else if (pct >= 60) {
      contextPillEl.classList.add('warning');
    }
    contextPillEl.title = `上下文：${(lastInputTokens / 1000).toFixed(1)}k / ${(contextWindowSize / 1000).toFixed(0)}k tokens，点击查看会话统计`;
    if (pct >= 80) {
      showCompactButton();
    } else {
      hideCompactButton();
    }
  } else if (lastInputTokens > 0) {
    // No context window info yet, just show raw tokens
    contextPillEl.textContent = `${(lastInputTokens / 1000).toFixed(1)}k`;
    contextPillEl.classList.add('visible');
    contextPillEl.classList.remove('warning', 'critical');
    contextPillEl.title = '上下文 token，点击查看会话统计';
  } else if (sessionTotalCost > 0) {
    // No context data yet — show the session cost as a fallback.
    contextPillEl.textContent = `$${sessionTotalCost.toFixed(3)} (sub)`;
    contextPillEl.classList.add('visible');
    contextPillEl.classList.remove('warning', 'critical');
    contextPillEl.title = '会话成本，点击查看会话统计';
  } else {
    contextPillEl.classList.remove('visible', 'warning', 'critical');
  }
}

function showCompactButton() {
  if (document.getElementById('compact-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'compact-btn';
  btn.className = 'compact-btn';
  btn.textContent = '压缩';
  btn.title = '上下文已超过 80%，建议压缩以节省 token';
  btn.addEventListener('click', () => {
    rpcCommand({ type: 'compact' }, '正在压缩...');
    hideCompactButton();
  });
  // Insert next to the context pill in the header
  const pillParent = contextPillEl.parentElement;
  if (pillParent) pillParent.insertBefore(btn, contextPillEl.nextSibling);
}

function hideCompactButton() {
  const btn = document.getElementById('compact-btn');
  if (btn) btn.remove();
}

async function fetchContextWindow() {
  // Delegate to fetchModelInfo which also updates the model button
  await modelPickerController.fetchModelInfo();
}

let tailscaleUrl = '';

function updateConnectionStatus() {
  if (statusFlashTimer !== null) return;
  const connection = stores.runtime.get().connection;
  const streaming = isActiveStreaming();
  const status = connection === 'connected' && streaming ? 'streaming' : connection;
  statusIndicator.className = `status-indicator ${status}`;

  if (connection === 'connected') {
    statusText.textContent = streaming ? '处理中...' : (tailscaleUrl ? '已连接 • TS' : '已连接');
    statusText.title = tailscaleUrl || '';
    // Fetch tailscale info on first connect
    if (!tailscaleUrl) {
      fetch('/api/health').then(r => r.json()).then(data => {
        if (data.tailscaleUrl) {
          tailscaleUrl = data.tailscaleUrl;
          statusText.textContent = '已连接 • TS';
          statusText.title = tailscaleUrl;
        }
      }).catch(() => {});
    }
  } else statusText.textContent = connection === 'connecting' ? '连接中...' : '已断开';
}

function updateUI() {
  const hasLiveSession = !!activeLiveSessionId && viewingActiveSession;
  const streaming = isActiveStreaming();

  // Don't clobber an active red-dot error flash: it owns both the indicator
  // class and statusText for its full 3 s. The flash's restore callback
  // re-derives the current connection/streaming state, so skipping here is
  // safe. Other UI updates below (input enabling, abort button, etc.) still
  // run normally.
  updateConnectionStatus();
  showTypingIndicator(streaming);

  messageInput.disabled = !hasLiveSession;
  sendBtn.disabled = !hasLiveSession;

  if (streaming) {
    abortBtn.classList.remove('hidden');
    sendBtn.classList.add('hidden');
  } else {
    abortBtn.classList.add('hidden');
    sendBtn.classList.remove('hidden');
  }
}

// ═══════════════════════════════════════
// Theme / Settings
// ═══════════════════════════════════════



const settingsBtn = document.getElementById('settings-btn')!;
const settingsPanel = document.getElementById('settings-panel')!;
const settingsOverlay = document.getElementById('settings-overlay')!;
const settingsClose = document.getElementById('settings-close')!;
const themeGrid = document.getElementById('theme-grid')!;


const toggleAutoCompact = document.getElementById('toggle-auto-compact')!;
const btnThinkingLevel = document.getElementById('btn-thinking-level')!;
const toggleShowThinking = document.getElementById('toggle-show-thinking')!;

function thinkingLevelLabel(level: unknown) {
  const labels: Record<string, string> = {
    off: '关',
    minimal: '极简',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
  };
  return labels[String(level || 'off')] || String(level || '关');
}

function buildThemeGrid() {
  themeGrid.innerHTML = '';
  const current = getCurrentTheme();

  for (const [id, theme] of Object.entries(themes)) {
    const btn = document.createElement('button');
    btn.className = `theme-swatch${current === id ? ' active' : ''}`;
    const dots = (theme.colors || []).map(c => 
      `<span class="swatch-dot" style="background:${c}"></span>`
    ).join('');
    btn.innerHTML = `<span class="swatch-colors">${dots}</span>`;
    btn.addEventListener('click', () => {
      applyTheme(id);
      themeGrid.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
    });
    themeGrid.appendChild(btn);
  }
}

async function openSettings() {
  buildThemeGrid();
  settingsPanel.classList.remove('hidden');
  settingsOverlay.classList.remove('hidden');

  // Fetch current state for toggles
  try {
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_state', sessionId: activeLiveSessionId }),
    });
    const data = await resp.json();
    if (data.success && data.data) {
      const s = data.data;
      // Auto-compaction toggle
      toggleAutoCompact.className = `settings-toggle${s.autoCompactionEnabled ? ' on' : ''}`;
      // Thinking level
      btnThinkingLevel.textContent = thinkingLevelLabel(s.thinkingLevel || 'off');
      modelPickerController.setThinkingLevel(s.thinkingLevel || 'off');
      // Session name is managed by Pi session history; no editable field in Tau settings.
    }
  } catch (e) {
    // Silent
  }

  // Fetch auth state
  try {
    const authData = await rpcCommand({ type: 'get_auth' });
    if (authData?.success && authData.data?.configured) {
      authSection.style.display = '';
      toggleAuth.className = `settings-toggle${authData.data.enabled ? ' on' : ''}`;
    } else {
      authSection.style.display = 'none';
    }
  } catch {
    authSection.style.display = 'none';
  }
}

function closeSettings() {
  settingsPanel.classList.add('hidden');
  settingsOverlay.classList.add('hidden');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);

// Auto-compaction toggle
toggleAutoCompact.addEventListener('click', async () => {
  const isOn = toggleAutoCompact.classList.contains('on');
  toggleAutoCompact.className = `settings-toggle${isOn ? '' : ' on'}`;
  await rpcCommand({ type: 'set_auto_compaction', enabled: !isOn });
});

// Thinking level cycle (settings panel button)
btnThinkingLevel.addEventListener('click', async () => {
  const data = await rpcCommand({ type: 'cycle_thinking_level' });
  if (data?.success && data.data?.level) {
    btnThinkingLevel.textContent = thinkingLevelLabel(data.data.level);
    modelPickerController.setThinkingLevel(data.data.level);
  }
});

// Show thinking toggle (local pref)
const showThinking = localStorage.getItem('tau-show-thinking') !== 'false';
toggleShowThinking.className = `settings-toggle${showThinking ? ' on' : ''}`;
if (!showThinking) document.body.classList.add('hide-thinking');

toggleShowThinking.addEventListener('click', () => {
  const isOn = toggleShowThinking.classList.contains('on');
  toggleShowThinking.className = `settings-toggle${isOn ? '' : ' on'}`;
  document.body.classList.toggle('hide-thinking', isOn);
  localStorage.setItem('tau-show-thinking', String(!isOn));
});

// Auth toggle
const toggleAuth = document.getElementById('toggle-auth')!;
const authSection = document.getElementById('settings-auth-section')!;

toggleAuth.addEventListener('click', async () => {
  const isOn = toggleAuth.classList.contains('on');
  const data = await rpcCommand({ type: 'set_auth', enabled: !isOn });
  if (data?.success) {
    toggleAuth.className = `settings-toggle${!isOn ? ' on' : ''}`;
  }
});





// Restore saved theme
const savedTheme = getCurrentTheme();
applyTheme(savedTheme);

// ═══════════════════════════════════════
// Session stats card (opened from the context pill)
// ═══════════════════════════════════════

// Fetch authoritative session stats from pi's get_session_stats RPC. Uses a
// plain fetch (not rpcCommand) so it never flashes status-bar messages.
// Resolves null when there is no live session or the fetch fails; a stale
// response for a session we already switched away from is discarded, and any
// authoritative numbers are synced into the pill's local state.
async function fetchSessionStats(): Promise<SessionStats | null> {
  if (!viewingActiveSession || !activeLiveSessionId) return null;
  const requestSessionId = activeLiveSessionId;
  try {
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_session_stats', sessionId: requestSessionId }),
    });
    const data = await resp.json();
    if (!data?.success || !data.data) return null;
    if (activeLiveSessionId !== requestSessionId || !viewingActiveSession) return null;
    const stats = data.data as SessionStats;

    // Sync authoritative numbers into the locally-tracked pill state so the
    // pill never drifts from what pi reports. contextUsage (and its fields)
    // may be null right after compaction — keep the last known values then.
    if (typeof stats.cost === 'number') sessionTotalCost = stats.cost;
    const cu = stats.contextUsage;
    if (cu && typeof cu.contextWindow === 'number' && cu.contextWindow > 0) {
      contextWindowSize = cu.contextWindow;
    }
    if (cu && typeof cu.tokens === 'number') {
      lastInputTokens = cu.tokens;
    }
    updateContextPill();
    return stats;
  } catch {
    return null;
  }
}

const sessionStatsCard = setupSessionStatsCard({
  pillEl: contextPillEl,
  cardEl: document.getElementById('session-stats-card')!,
  fetchStats: fetchSessionStats,
  getFallback: () => ({
    usage: lastUsage,
    cost: sessionTotalCost,
    contextTokens: lastInputTokens,
    contextWindow: contextWindowSize,
  }),
});

// Voice Input
setupVoiceInput(document.getElementById('mic-btn')!, messageInput);

// ═══════════════════════════════════════
// Initialize
// ═══════════════════════════════════════

// On mobile, start with the sidebar collapsed. The context pill stays in the
// header on all screen sizes.
if (isMobile()) {
  sidebarEl.classList.add('collapsed');
}

// Kernel store subscriptions — all session/streaming UI derives from these.
let lastKnownSessionIds = new Set<string>();
let lastMetadataSession: LiveSession | null = null;
let wasActiveStreaming = false;
let lastRenderedServerError: AppError | null = null;

stores.session.subscribe((sessionState) => {
  liveInstances = sessionState.sessions.map(s => ({ sessionFile: s.sessionFile, cwd: s.cwd, port: location.port }));
  const ids = new Set(sessionState.sessions.map(s => s.id));
  // A live session vanished (closed remotely or dropped by a poll): run the
  // same cleanup as the legacy liveSessionClosed handler.
  const vanishedActiveId = activeLiveSessionId && !ids.has(activeLiveSessionId) && lastKnownSessionIds.has(activeLiveSessionId)
    ? activeLiveSessionId
    : null;
  lastKnownSessionIds = ids;
  if (vanishedActiveId) {
    handleLiveSessionClosed(vanishedActiveId);
    return;
  }
  const active = sessionState.sessions.find(s => s.id === activeLiveSessionId) || null;
  if (active && active !== lastMetadataSession) {
    lastMetadataSession = active;
    applyActiveSessionMetadata(active);
  }
  // A finished run pulls authoritative post-turn stats from pi and notifies
  // via the tab title when unfocused.
  const nowStreaming = isActiveStreaming();
  if (wasActiveStreaming && !nowStreaming) {
    void sessionStatsCard.refresh();
    if (!hasFocus) {
      unreadCount++;
      document.title = `(${unreadCount}) ● ${originalTitle}`;
    }
  }
  wasActiveStreaming = nowStreaming;
  renderLiveTabs();
  syncSidebarLiveSessions();
  updateLiveSessionInputState();
  updateUI();
});

stores.runtime.subscribe((runtimeState) => {
  updateConnectionStatus();
  const error = runtimeState.lastError;
  if (error && error !== lastRenderedServerError) {
    lastRenderedServerError = error;
    if (error.code === 'server_error') messageRenderer.renderError(error.message);
  }
});

stores.conversation.subscribe(() => handleConversationChange());

stores.extensionUi.subscribe(() => {
  syncExtensionUIDialog();
  renderLiveTabs();
});

// UI-only event side effects (compaction indicator, task entries, tool cards)
// plus the first-state/reconnect session restore.
kernel.onEvent((incoming: KernelUiEvent) => {
  if (incoming.kind === 'state') {
    handleServerStateApplied();
  } else {
    handleKernelRpcEvent(incoming.event, incoming.sessionId);
  }
});

dispatch({ type: 'runtime/connecting' });
wsClient.connect();
messageRenderer.renderWelcome();
updateLiveSessionInputState();
sidebar.loadSessions().then(() => {
  updateLiveSessionIndicators();
});
launcherPanel.init();

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Dismiss mobile splash screen
const splash = document.getElementById('mobile-splash');
if (splash) {
  requestAnimationFrame(() => {
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 300);
  });
}

console.log('🚀 Tau initialized');
