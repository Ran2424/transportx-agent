import { CITATION_CONTENT_LABELS } from './citation.ts';
import type { CitationEnvelope, CitationEvidence, CitationLocator, CitationSourceVersion } from './citation.ts';
export type CitationProfile = 'chat-numeric' | 'gbt7714-numeric';
export type ResolvedCitationEvidence = { source: CitationSourceVersion; evidence: CitationEvidence };
export type CompiledCitation = { source: CitationSourceVersion; number: number; evidence: CitationEvidence[] };
export type CitationCompileResult = { markdown: string; numbers: Record<string, number>; references: CompiledCitation[]; citationMap: Record<string, { sourceVersionId: string; evidenceId: string; number: number }>; unavailableIds: string[] };
export type CitationExportFormat = 'bibtex' | 'csl-json' | 'ris';
export const CITATION_MARKER_RE = /\[\[cite:([A-Za-z0-9_.:-]+(?:\s*,\s*[A-Za-z0-9_.:-]+)*)\]\]/g;
const GENERATED_REFERENCE_RE = /\n*<!-- tau:references:start -->[\s\S]*?<!-- tau:references:end -->\s*$/;
export function citationEvidenceIndex(envelope: CitationEnvelope) {
  const sources = new Map(envelope.sources.map((source) => [source.sourceVersionId, source]));
  const index = new Map<string, ResolvedCitationEvidence>();
  for (const evidence of envelope.evidence) { const source = sources.get(evidence.sourceVersionId); if (source) index.set(evidence.evidenceId, { source, evidence }); }
  return index;
}
export function citationIdsInText(text: string) {
  const searchable = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  return [...new Set([...searchable.matchAll(CITATION_MARKER_RE)].flatMap((match) => match[1].split(',').map((id) => id.trim())))];
}
export function citationLocatorText(locator: CitationLocator) {
  if (locator.kind === 'source') return '整份来源';
  if (locator.kind === 'result') return `结果字段 ${locator.field}`;
  if (locator.kind === 'table') return [locator.sheet, locator.cell, locator.rowStart ? `数据行 ${locator.rowStart}${locator.rowEnd && locator.rowEnd !== locator.rowStart ? `–${locator.rowEnd}` : ''}` : '', locator.columns?.join('、')].filter(Boolean).join(' · ');
  return [locator.page ? `第 ${locator.page} 页` : '', locator.printedPage ? `印刷页 ${locator.printedPage}` : '', locator.section || locator.nodeId, locator.lineStart ? `行 ${locator.lineStart}${locator.lineEnd ? `–${locator.lineEnd}` : ''}` : ''].filter(Boolean).join(' · ');
}
export function formatGbt7714Reference(citation: CompiledCitation) {
  const meta = citation.source.metadata;
  return `${citation.number}. ${meta?.author?.join('，') || meta?.issuer || '佚名'}. ${citation.source.title}[${meta?.bibliographicType || 'Z'}]. ${[meta?.issuedAt, meta?.edition, meta?.standardNumber, meta?.version, `版本 ${citation.source.content.sha256.slice(0, 8)}`, ...citation.evidence.map((item) => `${citationLocatorText(item.locator)}（${CITATION_CONTENT_LABELS[item.contentKind]}）`), meta?.url].filter(Boolean).join('，')}.`;
}
export function compileCitations(markdown: string, envelope: CitationEnvelope, profile: CitationProfile = 'gbt7714-numeric'): CitationCompileResult {
  const available = citationEvidenceIndex(envelope), numbers: Record<string, number> = {}, citationMap: CitationCompileResult['citationMap'] = {}, references: CompiledCitation[] = [], unavailableIds: string[] = [];
  const body = markdown.replace(GENERATED_REFERENCE_RE, '').trimEnd();
  for (const id of citationIdsInText(body)) {
    const citation = available.get(id);
    if (!citation) { unavailableIds.push(id); continue; }
    let reference = references.find((item) => item.source.sourceVersionId === citation.source.sourceVersionId);
    if (!reference) { reference = { source: citation.source, number: references.length + 1, evidence: [] }; references.push(reference); }
    reference.evidence.push(citation.evidence);
    numbers[id] = reference.number; citationMap[id] = { sourceVersionId: citation.source.sourceVersionId, evidenceId: id, number: reference.number };
  }
  const lines = references.map((item) => profile === 'gbt7714-numeric' ? formatGbt7714Reference(item) : `${item.number}. ${item.source.title}（${item.evidence.map((evidence) => `${citationLocatorText(evidence.locator)}（${CITATION_CONTENT_LABELS[evidence.contentKind]}）`).join('；')}）`);
  return { markdown: `${body}${lines.length ? `\n\n<!-- tau:references:start -->\n## 参考文献\n\n${lines.join('\n')}\n<!-- tau:references:end -->` : ''}`, numbers, references, citationMap, unavailableIds };
}
function escapeBib(value: string) { return value.replace(/[{}\\]/g, (char) => `\\${char}`).replace(/[\r\n]+/g, ' '); }
function line(value: string) { return value.replace(/[\r\n]+/g, ' '); }
export function exportCitationBibliography(envelope: CitationEnvelope, format: CitationExportFormat) {
  const sources = envelope.sources;
  const locations = (source: CitationSourceVersion) => envelope.evidence.filter((item) => item.sourceVersionId === source.sourceVersionId).map((item) => `${citationLocatorText(item.locator)}（${CITATION_CONTENT_LABELS[item.contentKind]}）`).join('；');
  if (format === 'csl-json') return JSON.stringify(sources.map((source) => ({ id: source.sourceVersionId, type: 'document', title: source.title, author: source.metadata?.author?.map((literal) => ({ literal })), publisher: source.metadata?.issuer, number: source.metadata?.standardNumber, edition: source.metadata?.edition, issued: source.metadata?.issuedAt ? { raw: source.metadata.issuedAt } : undefined, URL: source.metadata?.url, note: locations(source) })), null, 2);
  if (format === 'ris') return sources.map((source) => ['TY  - GEN', `ID  - ${source.sourceVersionId}`, `TI  - ${line(source.title)}`, ...(source.metadata?.author || []).map((author) => `AU  - ${line(author)}`), ...(source.metadata?.url ? [`UR  - ${line(source.metadata.url)}`] : []), ...(source.metadata?.issuer ? [`PB  - ${line(source.metadata.issuer)}`] : []), ...(source.metadata?.issuedAt ? [`PY  - ${line(source.metadata.issuedAt)}`] : []), ...(source.metadata?.standardNumber ? [`SN  - ${line(source.metadata.standardNumber)}`] : []), ...(source.metadata?.edition ? [`ET  - ${line(source.metadata.edition)}`] : []), `N1  - ${line(locations(source))}`, 'ER  - '].join('\n')).join('\n\n');
  return sources.map((source) => `@misc{${source.sourceVersionId},\n  title = {${escapeBib(source.title)}},\n  author = {${escapeBib(source.metadata?.author?.join(' and ') || source.metadata?.issuer || '')}},\n  year = {${escapeBib(source.metadata?.issuedAt || '')}},\n  number = {${escapeBib(source.metadata?.standardNumber || '')}},\n  edition = {${escapeBib(source.metadata?.edition || '')}},\n  url = {${escapeBib(source.metadata?.url || '')}},\n  note = {${escapeBib(locations(source))}}\n}`).join('\n\n');
}

export function replaceCitationMarkers(text: string, replace: (ids: string[]) => string) {
  return text.split(/(```[\s\S]*?```|`[^`]*`)/g).map((part, index) => index % 2 ? part : part.replace(CITATION_MARKER_RE, (_match, raw: string) => replace(raw.split(',').map((id) => id.trim())))).join('');
}
export function exportCitationMarkdown(text: string, envelope: CitationEnvelope) {
  const compiled = compileCitations(text, envelope);
  return replaceCitationMarkers(compiled.markdown, (ids) => [...new Set(ids.map((id) => Object.hasOwn(compiled.numbers, id) ? `[${compiled.numbers[id]}]` : '[引用不可用]'))].join(''));
}
