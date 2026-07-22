import type { ReactNode } from 'react';

export function AppShell({ header, sidebar, tabs, conversation, workspace, floats, overlays }: {
  header: ReactNode;
  sidebar: ReactNode;
  tabs: ReactNode;
  conversation: ReactNode;
  workspace: ReactNode;
  floats: ReactNode;
  overlays: ReactNode;
}) {
  return (
    <div className="agent-shell" data-testid="react-shell">
      <div className="react-grain" aria-hidden="true" />
      {header}
      <div className="agent-shell-body">
        {sidebar}
        <section className="agent-main-column">
          {tabs}
          {conversation}
          {floats}
        </section>
        {workspace}
      </div>
      {overlays}
    </div>
  );
}
