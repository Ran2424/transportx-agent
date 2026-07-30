import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

const DEFAULT_CONVERSATION_WIDTH = 440;
const SPLITTER_WIDTH = 10;

function clampConversationWidth(containerWidth: number, requestedWidth: number) {
  const width = Math.max(0, containerWidth);
  const minimumConversation = Math.min(360, Math.max(180, width * .4));
  const minimumMap = Math.min(360, Math.max(180, width * .35));
  const maximumConversation = Math.max(minimumConversation, width - minimumMap - SPLITTER_WIDTH);
  return Math.round(Math.min(maximumConversation, Math.max(minimumConversation, requestedWidth)));
}

function savedConversationWidth() {
  if (typeof window === 'undefined') return DEFAULT_CONVERSATION_WIDTH;
  const value = Number.parseFloat(window.localStorage.getItem('tau-conversation-pane-width') || '');
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CONVERSATION_WIDTH;
}

export function AppShell({ header, sidebar, tabs, conversation, workspace, taskFloat, mapPanel, mapOpen, overlays }: {
  header: ReactNode;
  sidebar: ReactNode;
  tabs: ReactNode;
  conversation: ReactNode;
  workspace: ReactNode;
  taskFloat: ReactNode;
  mapPanel: ReactNode;
  mapOpen: boolean;
  overlays: ReactNode;
}) {
  const mainRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [preferredWidth, setPreferredWidth] = useState(savedConversationWidth);
  const [conversationWidth, setConversationWidth] = useState(savedConversationWidth);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const main = mainRef.current;
    if (!main || !mapOpen) return;
    const resize = () => setConversationWidth(clampConversationWidth(main.getBoundingClientRect().width, preferredWidth));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(main);
    return () => observer.disconnect();
  }, [mapOpen, preferredWidth]);

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

  const mainStyle = { '--conversation-pane-width': `${conversationWidth}px` } as CSSProperties;

  return (
    <div className="agent-shell" data-testid="react-shell">
      <div className="react-grain" aria-hidden="true" />
      {header}
      <div className="agent-shell-body">
        {sidebar}
        <section ref={mainRef} className={`agent-main-column${mapOpen ? ' is-map-focused' : ''}${resizing ? ' is-resizing-conversation' : ''}`} style={mainStyle}>
          <section className="map-focus-panel">{mapPanel}</section>
          <div
            className="conversation-resizer"
            role="separator"
            aria-label="调整聊天区域宽度"
            aria-orientation="vertical"
            aria-valuenow={conversationWidth}
            tabIndex={mapOpen ? 0 : -1}
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
      </div>
      {overlays}
    </div>
  );
}
