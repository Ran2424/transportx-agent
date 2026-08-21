import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CitationEnvelope } from '../../../contracts/citation.ts';
import { appKernel } from '../../app/composition-root';
import i18n from '../../i18n';

export type CiteCandidate = { locatorId: string; title: string; position: string; quote?: string };

export function useComposerCitationPicker({ sessionId, onCitationEnvelope, onInsert, onError, onFocus }: { sessionId: string; onCitationEnvelope(citations: CitationEnvelope): void; onInsert(marker: string): void; onError(message: string): void; onFocus(): void }) {
  const { t } = useTranslation();
  const [citeOpen, setCiteOpen] = useState(false);
  const [citeLoading, setCiteLoading] = useState(false);
  const [citeCandidates, setCiteCandidates] = useState<CiteCandidate[]>([]);
  async function openCitePicker() {
    setCiteOpen(true); setCiteLoading(true); onError('');
    try {
      const citations = await appKernel.commands.citation.list(sessionId);
      const works = new Map(citations.works.map((item) => [item.workId, item]));
      const resources = new Map(citations.resources.map((item) => [item.resourceId, item]));
      setCiteCandidates(citations.locators.flatMap((locator) => {
        const resource = resources.get(locator.resourceId);
        const work = resource ? works.get(resource.workId) : null;
        if (!resource || !work) return [];
        const position = locator.page ? (i18n.language === 'en-US' ? `Page ${locator.page}` : `第 ${locator.page} 页`) : locator.clause || locator.section || locator.sourceUnit || locator.nodeId || t('conversation.sourceLocation');
        return [{ locatorId: locator.locatorId, title: work.title, position, quote: locator.quote }];
      }));
    } catch (cause) { onError((cause as Error).message || t('conversation.citationUnavailable')); setCiteCandidates([]); }
    finally { setCiteLoading(false); }
  }
  async function insertCitation(locatorId: string) {
    try {
      const { marker, citations } = await appKernel.commands.citation.createOccurrence(sessionId, locatorId, 'support');
      onCitationEnvelope(citations);
      onInsert(marker);
      setCiteOpen(false);
      requestAnimationFrame(onFocus);
    } catch (cause) { onError((cause as Error).message || t('conversation.createCitationFailed')); }
  }
  return { citeOpen, citeLoading, citeCandidates, setCiteOpen, openCitePicker, insertCitation };
}

export function ComposerCitationPicker({ loading, candidates, onClose, onSelect }: { loading: boolean; candidates: CiteCandidate[]; onClose(): void; onSelect(locatorId: string): void }) {
  const { t } = useTranslation();
  return <section className="composer-cite-picker" role="listbox" aria-label={t('conversation.chooseCitation')}>
    <header><strong>{t('conversation.insertCitation')}</strong><button type="button" onClick={onClose} aria-label={t('conversation.closeCitationPicker')}>×</button></header>
    {loading ? <p>{t('conversation.loadingCitations')}</p> : candidates.length ? <div>{candidates.map((candidate) => <button key={candidate.locatorId} type="button" role="option" onClick={() => onSelect(candidate.locatorId)}><strong>{candidate.title}</strong><span>{candidate.position}</span>{candidate.quote ? <small>{candidate.quote}</small> : null}</button>)}</div> : <p>{t('conversation.noInsertableCitation')}</p>}
  </section>;
}
