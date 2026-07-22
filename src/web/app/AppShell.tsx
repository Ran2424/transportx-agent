import type { ReactNode } from 'react';

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
  return (
    <div className="agent-shell" data-testid="react-shell">
      <div className="react-grain" aria-hidden="true" />
      {header}
      <div className="agent-shell-body">
        {sidebar}
        <section className={`agent-main-column${mapOpen ? ' is-map-focused' : ''}`}>
          <section className="map-focus-panel">{mapPanel}</section>
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
