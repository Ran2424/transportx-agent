import type { LiveSession } from '../../../public/app-types.js';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/icons';
import { compactModelLabel, sessionTitle } from '../../lib/formatting';

type LiveTabsProps = {
  sessions: LiveSession[];
  activeSessionId: string | null;
  streamingBySession: Record<string, boolean>;
  pendingDialogSessions: Set<string>;
  onSelect(sessionId: string): void;
  onClose(sessionId: string): void;
  onNewSession(): void;
};

export function LiveTabs({ sessions, activeSessionId, streamingBySession, pendingDialogSessions, onSelect, onClose, onNewSession }: LiveTabsProps) {
  const { t } = useTranslation();
  return (
    <nav className="live-tabs" aria-label={t('sessions.running')} data-testid="live-tabs">
      <div className="live-tabs-scroll">
        {sessions.length === 0 ? <span className="live-tabs-empty">{t('sessions.noneRunning')}</span> : null}
        {sessions.map((session) => (
          <div className={`live-tab${activeSessionId === session.id ? ' is-active' : ''}`} key={session.id}>
            <button className="live-tab-select" type="button" onClick={() => onSelect(session.id)} title={session.cwd}>
              {streamingBySession[session.id] ? <span className="streaming-beacon" aria-label={t('sessions.processing')} /> : null}
              {pendingDialogSessions.has(session.id) ? <span className="pending-dialog-beacon" title={t('sessions.awaitingResponse')}>?</span> : null}
              <span className="live-tab-copy"><strong>{sessionTitle(session)}</strong><small>{compactModelLabel(session)}</small></span>
            </button>
            <button className="live-tab-close" type="button" aria-label={t('sessions.closeNamed', { name: sessionTitle(session) })} onClick={() => onClose(session.id)}>×</button>
          </div>
        ))}
      </div>
      <button className="live-tab-add" type="button" aria-label={t('sessions.newTask')} onClick={onNewSession}><Icon name="plus" /></button>
    </nav>
  );
}
