import { useEffect, useState } from 'react';
import type { CitationEnvelope } from '../../../contracts/citation';
import { citationEvidenceIndex, citationLocatorText, exportCitationBibliography, type CitationExportFormat } from '../../../contracts/citation-compiler';
import { appKernel } from '../../app/composition-root';
import { Dialog } from '../../components/ui/dialog';
import { useCitationDetail } from './citation-detail';
export function CitationManager({ sessionId, onClose }: { sessionId: string; onClose(): void }) {
  const [envelope, setEnvelope] = useState<CitationEnvelope | null>(null), [error, setError] = useState(''), [offset, setOffset] = useState(0), [query, setQuery] = useState('');
  const openDetail = useCitationDetail();
  useEffect(() => {
    let active = true; setEnvelope(null); setError('');
    void appKernel.commands.citation.list(sessionId, { offset }).then((value) => { if (active) setEnvelope(value); }).catch((cause) => { if (active) setError((cause as Error).message); });
    return () => { active = false; };
  }, [sessionId, offset]);
  async function download(format: CitationExportFormat) {
    try {
      const all: CitationEnvelope = { protocol: 'pi-citation', version: '3.0', sources: [], evidence: [] };
      let next: number | undefined = 0;
      do {
        const page = await appKernel.commands.citation.list(sessionId, { offset: next });
        for (const source of page.sources) if (!all.sources.some((item) => item.sourceVersionId === source.sourceVersionId)) all.sources.push(source);
        all.evidence.push(...page.evidence); next = page.nextOffset;
      } while (next !== undefined);
      const anchor = document.createElement('a'), url = URL.createObjectURL(new Blob([exportCitationBibliography(all, format)], { type: 'text/plain;charset=utf-8' }));
      anchor.href = url; anchor.download = `citations.${format === 'bibtex' ? 'bib' : format === 'csl-json' ? 'json' : 'ris'}`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError((cause as Error).message); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} title="引用依据管理" className="citation-manager">
    <div className="citation-manager-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选本页依据" aria-label="筛选本页依据" />{(['bibtex', 'csl-json', 'ris'] as const).map((format) => <button type="button" key={format} onClick={() => void download(format)}>{format.toUpperCase()}</button>)}</div>
    {error ? <p role="alert">{error}</p> : !envelope ? <p role="status">正在读取…</p> : <div className="citation-manager-body">{[...citationEvidenceIndex(envelope).values()].filter(({ source }) => source.title.includes(query)).map(({ source, evidence }) => <article key={evidence.evidenceId}><div><strong>{source.title}</strong><small>{citationLocatorText(evidence.locator)}</small></div><button type="button" onClick={() => openDetail(sessionId, [evidence.evidenceId])}>查看依据</button></article>)}</div>}
    <div className="citation-detail-actions"><button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 200))}>上一页</button><button type="button" disabled={envelope?.nextOffset === undefined} onClick={() => setOffset(envelope!.nextOffset!)}>下一页</button></div>
  </Dialog>;
}
