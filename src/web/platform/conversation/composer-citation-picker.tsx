import { useCitationDetail } from './citation-detail';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CitationEnvelope } from '../../../contracts/citation.ts';
import { appKernel } from '../../app/composition-root';
import { citationEvidenceIndex, citationLocatorText } from '../../../contracts/citation-compiler';

export type CiteCandidate = { evidenceId: string; title: string; position: string; quote?: string };

export function useComposerCitationPicker({ sessionId, onCitationEnvelope, onInsert, onError, onFocus }: { sessionId: string; onCitationEnvelope(citations: CitationEnvelope): void; onInsert(marker: string): void; onError(message: string): void; onFocus(): void }) {
  const { t } = useTranslation();
  const [citeOpen, setCiteOpen] = useState(false);
  const [citeLoading, setCiteLoading] = useState(false);
  const [citeCandidates, setCiteCandidates] = useState<CiteCandidate[]>([]);
  const [envelope, setEnvelope] = useState<CitationEnvelope | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => { setCiteOpen(false); setCiteCandidates([]); setEnvelope(null); return () => { pending.current?.abort(); }; }, [sessionId]);
  async function openCitePicker() {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setCiteOpen(true); setCiteLoading(true); onError('');
    try {
      const citations = await appKernel.commands.citation.list(sessionId, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setEnvelope(citations);
      setCiteCandidates([...citationEvidenceIndex(citations).values()].map(({ source, evidence }) => ({ evidenceId: evidence.evidenceId, title: source.title, position: citationLocatorText(evidence.locator), quote: evidence.text })));
    } catch (cause) { if (controller.signal.aborted) return; onError((cause as Error).message || t('conversation.citationUnavailable')); setCiteCandidates([]); }
    finally { if (!controller.signal.aborted) setCiteLoading(false); }
  }
  async function insertCitation(evidenceId: string) {
    try {
      if (envelope) onCitationEnvelope(envelope);
      onInsert(`[[cite:${evidenceId}]]`);
      setCiteOpen(false);
      requestAnimationFrame(onFocus);
    } catch (cause) { onError((cause as Error).message || t('conversation.createCitationFailed')); }
  }
  return { citeOpen, citeLoading, citeCandidates, setCiteOpen, openCitePicker, insertCitation };
}

export function ComposerCitationPicker({ sessionId, loading, candidates, onClose, onSelect }: { sessionId: string; loading: boolean; candidates: CiteCandidate[]; onClose(): void; onSelect(evidenceId: string): void }) {
  const { t } = useTranslation();
  const openDetail = useCitationDetail();
  return <section className="composer-cite-picker" role="listbox" aria-label={t('conversation.chooseCitation')}>
    <header><strong>{t('conversation.insertCitation')}</strong><button type="button" onClick={onClose} aria-label={t('conversation.closeCitationPicker')}>×</button></header>
    {candidates.length === 200 ? <p>当前显示前 200 项；其余依据请在引用管理器分页查看。</p> : null}
    {loading ? <p>{t('conversation.loadingCitations')}</p> : candidates.length ? <div>{candidates.map((candidate) => <div key={candidate.evidenceId}><button type="button" role="option" onClick={() => onSelect(candidate.evidenceId)}><strong>{candidate.title}</strong><span>{candidate.position}</span>{candidate.quote ? <small>{candidate.quote}</small> : null}</button><button type="button" onClick={() => openDetail(sessionId, [candidate.evidenceId])}>查看依据</button></div>)}</div> : <p>{t('conversation.noInsertableCitation')}</p>}
  </section>;
}
