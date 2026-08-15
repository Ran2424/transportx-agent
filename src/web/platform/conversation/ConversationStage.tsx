import type { LiveSession } from '../../../public/app-types.js';
import { useTranslation } from 'react-i18next';
import { BrandMark } from '../../components/BrandMark';
import { Button } from '../../components/ui/button';
import { ConversationWorkspace } from './ConversationWorkspace';

export function ConversationStage({ session, loading, onNewSession, showThinking, expandThinking }: { session: LiveSession | null; loading: boolean; onNewSession(): void; showThinking: boolean; expandThinking: boolean }) {
  const { t } = useTranslation();
  if (loading) {
    return <main className="conversation-stage" aria-busy="true"><div className="stage-loader"><span /><strong>{t('welcome.syncing')}</strong><small>{t('welcome.syncingDetail')}</small></div></main>;
  }

  if (!session) {
    return (
      <main className="conversation-stage">
        <section className="workspace-welcome">
          <BrandMark className="welcome-mark" />
          <h1>{t('welcome.titleBefore')}<br /><em>{t('welcome.titleEmphasis')}</em>{t('welcome.titleAfter')}</h1>
          <Button onClick={onNewSession}>{t('welcome.newTask')} <span aria-hidden="true">↗</span></Button>
          <div className="welcome-capabilities"><article><strong>{t('welcome.query.title')}</strong><span>{t('welcome.query.detail')}</span></article><article><strong>{t('welcome.map.title')}</strong><span>{t('welcome.map.detail')}</span></article><article><strong>{t('welcome.report.title')}</strong><span>{t('welcome.report.detail')}</span></article></div>
        </section>
      </main>
    );
  }

  return <ConversationWorkspace sessionId={session.id} showThinking={showThinking} expandThinking={expandThinking} />;
}
