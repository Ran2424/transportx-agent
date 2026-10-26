import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlatformOverview } from '../../../public/kernel/commands.js';
import { appKernel } from '../../app/composition-root';
import { BrandMark } from '../../components/BrandMark';
import { projectCapabilities } from '../capabilities/capability-projection';

export function ConversationStart({ sessionId, onDraft }: { sessionId: string; onDraft(message: string): void }) {
  const { t, i18n } = useTranslation();
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  useEffect(() => {
    let current = true;
    appKernel.commands.platform.getOverview(sessionId).then(value => { if (current) setOverview(value); }).catch(() => {});
    return () => { current = false; };
  }, [sessionId]);
  const suggestions = useMemo(() => {
    const items = overview ? projectCapabilities(overview, t, i18n.resolvedLanguage || i18n.language) : [];
    return items.filter((item, index) => item.moduleType === 'capability' && item.status === 'ready' && items.findIndex(candidate => candidate.moduleId === item.moduleId) === index).slice(0, 3);
  }, [overview, t, i18n.resolvedLanguage, i18n.language]);
  return <div className="conversation-empty"><BrandMark className="conversation-empty-mark" /><h1>{t('conversation.startTitle')}</h1><p>{t('conversation.startDescription')}</p><div className="conversation-start-actions" aria-label={t('conversation.analysisIdeas')}><button type="button" onClick={() => onDraft(t('conversation.inspectDraft'))}>{t('conversation.inspectData')}</button>{suggestions.map(item => <button key={item.moduleId} type="button" title={t('conversation.draftOnly')} onClick={() => onDraft(t('conversation.capabilityDraft', { name: item.moduleName }))}>{item.moduleName}</button>)}</div></div>;
}
