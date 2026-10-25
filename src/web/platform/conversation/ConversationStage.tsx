import type { ConversationView } from '../../../public/app-types.js';
import { useTranslation } from 'react-i18next';
import { BrandMark } from '../../components/BrandMark';
import { Button } from '../../components/ui/button';
import { ConversationWorkspace } from './ConversationWorkspace';

export function ConversationStage({ session, loading, onNewSession, onActivate, activating, showThinking, expandThinking }: { session: ConversationView | null; loading: boolean; onNewSession(): void; onActivate(): void; activating: boolean; showThinking: boolean; expandThinking: boolean }) {
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

  return <div className="conversation-persistent-stage">{!session.liveSessionId && <div className="conversation-offline-bar"><span>历史预览 · 尚未启动执行{session.record?.lastStartFailure ? ` · ${session.record.lastStartFailure.message}` : ''}</span><Button disabled={activating} onClick={onActivate}>{activating ? '正在激活…' : '激活此会话'}</Button></div>}<ConversationWorkspace key={session.id} sessionId={session.id} showThinking={showThinking} expandThinking={expandThinking} /></div>;
}
