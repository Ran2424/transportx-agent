import type { SessionEntry } from '../../../public/app-types.js';
import i18n from '../../i18n/index.ts';
import { CITATION_CONTENT_LABELS, parseCitationEnvelope, type CitationEnvelope } from '../../../contracts/citation.ts';
import { replaceCitationMarkers, citationIdsInText, citationEvidenceIndex, citationLocatorText, type ResolvedCitationEvidence } from '../../../contracts/citation-compiler.ts';
export type ResolvedCitation = ResolvedCitationEvidence & { number: number };
export type AvailableCitation = ResolvedCitationEvidence;
export type MessageCitationProjection = { citations: ResolvedCitation[]; artifacts: ResolvedCitation[]; numbers: Record<string, number>; unavailableIds: string[]; available: Map<string, AvailableCitation> };
function messageText(message: SessionEntry['message']) { return typeof message?.content === 'string' ? message.content : Array.isArray(message?.content) ? message.content.filter((block) => block.type === 'text').map((block) => block.text || '').join('\n') : ''; }
function projectionForIds(ids: string[], available: Map<string, AvailableCitation>, deliverables = new Set<string>()): MessageCitationProjection {
  const sourceNumbers = new Map<string, number>();
  const citations = ids.flatMap((id) => {
    const item = available.get(id);
    if (!item) return [];
    const number = sourceNumbers.get(item.source.sourceVersionId) || sourceNumbers.size + 1;
    sourceNumbers.set(item.source.sourceVersionId, number);
    return [{ ...item, number }];
  });
  return { citations, artifacts: citations.filter((item) => deliverables.has(item.evidence.evidenceId)), numbers: Object.fromEntries(citations.map((item) => [item.evidence.evidenceId, item.number])), unavailableIds: ids.filter((id) => !available.has(id)), available: new Map(available) };
}
export function projectMessageCitations(entries: SessionEntry[], registry?: CitationEnvelope | null) {
  const byEntry = new Map<SessionEntry, MessageCitationProjection>();
  const available = registry ? citationEvidenceIndex(registry) : new Map<string, AvailableCitation>(), deliverables = new Set<string>();
  for (const entry of entries) {
    const message = entry.message;
    if (message?.role === 'toolResult') {
      const details = message.details as { citations?: unknown; deliverableEvidenceIds?: unknown } | undefined;
      const envelope = parseCitationEnvelope(details?.citations);
      if (envelope) for (const [id, citation] of citationEvidenceIndex(envelope)) available.set(id, citation);
      if (Array.isArray(details?.deliverableEvidenceIds)) for (const id of details.deliverableEvidenceIds) if (typeof id === 'string') deliverables.add(id);
    }
    if (message?.role !== 'assistant' && message?.role !== 'user') continue;
    const ids = citationIdsInText(messageText(message));
    if (ids.length) byEntry.set(entry, projectionForIds(ids, available, deliverables));
  }
  return { byEntry, available };
}
export function projectCitationText(text: string, available: Map<string, AvailableCitation>) { const ids = citationIdsInText(text); return ids.length ? projectionForIds(ids, available) : undefined; }
export function citationReferenceMarkdown(projection?: MessageCitationProjection) {
  if (!projection?.citations.length) return '';
  const groups = new Map<string, ResolvedCitation[]>();
  for (const item of projection.citations) groups.set(item.source.sourceVersionId, [...(groups.get(item.source.sourceVersionId) || []), item]);
  return [i18n.language === 'en-US' ? '## References' : '## 参考文献', '', ...[...groups.values()].map((items) => `${items[0].number}. **${items[0].source.title}** — ${items.map(({ evidence }) => `${citationLocatorText(evidence.locator)}（${CITATION_CONTENT_LABELS[evidence.contentKind]}）${evidence.text ? `：${evidence.text.replace(/\s+/g, ' ')}` : ''}`).join('；')}`)].join('\n');
}
export function citationCopyText(text: string, projection?: MessageCitationProjection) {
  if (!projection) return text;
  const output = replaceCitationMarkers(text, (ids) => [...new Set(ids.map((id) => Object.hasOwn(projection.numbers, id) ? `[${projection.numbers[id]}]` : '[引用不可用]'))].join(''));
  return output + (projection.citations.length ? `\n\n${citationReferenceMarkdown(projection)}` : '');
}
