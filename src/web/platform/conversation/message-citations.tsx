import { useState } from 'react';
import { useOpenDocument } from '../canvas/document-context';
import { documentFormat } from '../canvas/document-state';
import { FilePreview } from '../workspace/FilePreview';
import { citationResourceUrl } from './citation-resource';
import type { CitationSourceVersion } from '../../../contracts/citation';
import { useCitationDetail, citationContentLabels } from './citation-detail';
import { citationLocatorText } from '../../../contracts/citation-compiler';
import type { MessageCitationProjection } from '../../features/citation/citation-projection';
export function MessageArtifacts({ projection, sessionId }: { projection?: MessageCitationProjection; sessionId: string }) {
  const openDocument = useOpenDocument();
  const [preview, setPreview] = useState<CitationSourceVersion | null>(null);
  if (!projection?.artifacts.length) return null;
  const sources = new Set<string>();
  function open(source: CitationSourceVersion) {
    if (source.content.kind !== 'file') return;
    if (documentFormat(source.content.path, source.content.mimeType)) openDocument({ sessionId, title: source.title, path: source.content.path, source });
    else setPreview(source);
  }
  return <section className="message-artifacts"><header><strong>交付成果</strong></header><div>{projection.artifacts.filter((item) => !sources.has(item.source.sourceVersionId) && !!sources.add(item.source.sourceVersionId)).map((item) => <button type="button" key={item.evidence.evidenceId} onClick={() => open(item.source)}><span><strong>{item.source.title}</strong><small>打开固定版本原件</small></span></button>)}</div>
    {preview?.content.kind === 'file' ? <FilePreview item={{ name: preview.title, path: preview.content.path, isDirectory: false }} sessionId={sessionId} stackIndex={0} initialOffset={0} externalSource={{ url: `${citationResourceUrl(sessionId, preview.sourceVersionId)}?sha256=${preview.content.sha256}`, kind: preview.content.mimeType.startsWith('image/') ? 'image' : 'document', mimeType: preview.content.mimeType }} onActivate={() => {}} onClose={() => setPreview(null)} /> : null}
  </section>;
}
export function CitationFooter({ projection, sessionId }: { projection?: MessageCitationProjection; sessionId: string }) {
  const openDetail = useCitationDetail();
  if (!projection || (!projection.citations.length && !projection.unavailableIds.length)) return null;
  return <section className="citation-footer">
    <details className="citation-disclosure"><summary>引用依据 <span>{projection.citations.length} 项</span>{projection.unavailableIds.length ? <span className="citation-warning"> · {projection.unavailableIds.length} 项不可用</span> : null}</summary>
      <ol>{projection.citations.map(({ source, evidence, number }) => <li key={evidence.evidenceId}><button className="citation-evidence-row" type="button" data-citation-card={evidence.evidenceId} title={`${source.title} · ${citationLocatorText(evidence.locator)}`} onClick={() => openDetail(sessionId, [evidence.evidenceId])}><span className="citation-number">{number}</span><span><strong>{source.title}</strong><small>{citationContentLabels[evidence.contentKind]} · {citationLocatorText(evidence.locator)}</small></span></button></li>)}</ol>
    </details>
    {projection.unavailableIds.length ? <p className="citation-warning" role="status">部分依据不可用或使用旧格式：{projection.unavailableIds.join('、')}</p> : null}
  </section>;
}
