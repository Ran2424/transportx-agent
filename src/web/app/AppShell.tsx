import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const DEFAULT_CONVERSATION_WIDTH = 440;
const SPLITTER_WIDTH = 10;
const MAP_TRANSITION_MS = 400;

function clampConversationWidth(containerWidth: number, requestedWidth: number) {
  const width = Math.max(0, containerWidth);
  // Workspace Focus 目标比例约 65:35，会话区可在 25%–45% 之间拖动。
  const minimumConversation = Math.min(480, Math.max(320, width * 0.25));
  const minimumWorkspace = Math.min(720, Math.max(320, width * 0.55));
  const maximumConversation = Math.max(minimumConversation, width - minimumWorkspace - SPLITTER_WIDTH);
  return Math.round(Math.min(maximumConversation, Math.max(minimumConversation, requestedWidth)));
}

function savedConversationWidth() {
  if (typeof window === 'undefined') return DEFAULT_CONVERSATION_WIDTH;
  const value = Number.parseFloat(window.localStorage.getItem('tau-conversation-pane-width') || '');
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CONVERSATION_WIDTH;
}

export function AppShell({ header, sidebar, tabs, conversation, workspace, taskFloat, mapPanel, videoPanel, mapOpen, videoOpen, settings, settingsOpen, overlays }: {
  header: ReactNode;
  sidebar: ReactNode;
  tabs: ReactNode;
  conversation: ReactNode;
  workspace: ReactNode;
  taskFloat: ReactNode;
  mapPanel: ReactNode;
  videoPanel: ReactNode;
  mapOpen: boolean;
  videoOpen: boolean;
  settings: ReactNode;
  settingsOpen: boolean;
  overlays: ReactNode;
}) {
  const { t } = useTranslation();
  const mainRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [preferredWidth, setPreferredWidth] = useState(savedConversationWidth);
  const [conversationWidth, setConversationWidth] = useState(savedConversationWidth);
  const [resizing, setResizing] = useState(false);
  const focusOpen = mapOpen || videoOpen;
  const [focusPhase, setFocusPhase] = useState<'closed' | 'opening' | 'open' | 'closing'>(focusOpen ? 'opening' : 'closed');

  const focusState = focusOpen ? (focusPhase === 'open' ? 'open' : 'opening') : (focusPhase === 'closed' ? 'closed' : 'closing');
  const focusVisible = focusState !== 'closed';

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setFocusPhase(focusOpen ? 'open' : 'closed');
      return;
    }
    if (focusOpen) {
      setFocusPhase('opening');
      const frame = window.requestAnimationFrame(() => setFocusPhase('open'));
      return () => window.cancelAnimationFrame(frame);
    }
    if (focusPhase === 'closed') return;
    setFocusPhase('closing');
    const timer = window.setTimeout(() => setFocusPhase('closed'), MAP_TRANSITION_MS);
    return () => window.clearTimeout(timer);
  }, [focusOpen]);

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const resize = () => {
      const width = main.getBoundingClientRect().width;
      if (focusVisible) setConversationWidth(clampConversationWidth(width, preferredWidth));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(main);
    return () => observer.disconnect();
  }, [focusVisible, preferredWidth, settingsOpen]);

  useEffect(() => {
    window.localStorage.setItem('tau-conversation-pane-width', String(preferredWidth));
  }, [preferredWidth]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      const main = mainRef.current;
      if (!drag || !main || drag.pointerId !== event.pointerId) return;
      const next = clampConversationWidth(main.getBoundingClientRect().width, drag.startWidth + drag.startX - event.clientX);
      setPreferredWidth(next);
      setConversationWidth(next);
    };
    const stop = (event: PointerEvent) => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      dragRef.current = null;
      setResizing(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  function updateWidth(requestedWidth: number) {
    const main = mainRef.current;
    if (!main) return;
    const next = clampConversationWidth(main.getBoundingClientRect().width, requestedWidth);
    setPreferredWidth(next);
    setConversationWidth(next);
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: conversationWidth };
    setResizing(true);
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return;
    event.preventDefault();
    updateWidth(event.key === 'Home'
      ? DEFAULT_CONVERSATION_WIDTH
      : conversationWidth + (event.key === 'ArrowLeft' ? 24 : -24));
  }

  const mainStyle = {
    '--conversation-pane-width': `${conversationWidth}px`,
  } as CSSProperties;

  return (
    <div className="agent-shell" data-testid="react-shell">
      <div className="react-grain" aria-hidden="true" />
      {header}
      <div className="agent-shell-body">
        {settings || <>
          {sidebar}
          <section ref={mainRef} className={`agent-main-column${focusVisible ? ' is-workspace-focused' : ''}${focusState === 'opening' ? ' is-workspace-entering' : ''}${focusState === 'closing' ? ' is-workspace-closing' : ''}${resizing ? ' is-resizing-conversation' : ''}`} style={mainStyle}>
            <section className="workspace-focus-panel">{mapPanel}{videoPanel}</section>
            <div
              className="conversation-resizer"
              role="separator"
              aria-label={t('shell.resizeConversation')}
              aria-orientation="vertical"
              aria-valuenow={conversationWidth}
              tabIndex={focusVisible ? 0 : -1}
              data-testid="conversation-resizer"
              onDoubleClick={() => updateWidth(DEFAULT_CONVERSATION_WIDTH)}
              onKeyDown={resizeWithKeyboard}
              onPointerDown={startResize}
            />
            <section className="conversation-pane">
              {tabs}
              {conversation}
            </section>
            {taskFloat}
          </section>
          {workspace}
        </>}
      </div>
      {overlays}
    </div>
  );
}
