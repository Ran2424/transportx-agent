import { useTranslation } from 'react-i18next';

export type CiteCandidate = { locatorId: string; title: string; position: string; quote?: string };

export function ComposerCitationPicker({ loading, candidates, onClose, onSelect }: { loading: boolean; candidates: CiteCandidate[]; onClose(): void; onSelect(locatorId: string): void }) {
  const { t } = useTranslation();
  return <section className="composer-cite-picker" role="listbox" aria-label={t('conversation.chooseCitation')}>
    <header><strong>{t('conversation.insertCitation')}</strong><button type="button" onClick={onClose} aria-label={t('conversation.closeCitationPicker')}>×</button></header>
    {loading ? <p>{t('conversation.loadingCitations')}</p> : candidates.length ? <div>{candidates.map((candidate) => <button key={candidate.locatorId} type="button" role="option" onClick={() => onSelect(candidate.locatorId)}><strong>{candidate.title}</strong><span>{candidate.position}</span>{candidate.quote ? <small>{candidate.quote}</small> : null}</button>)}</div> : <p>{t('conversation.noInsertableCitation')}</p>}
  </section>;
}
