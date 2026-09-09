import type { SessionEntry } from '../../../public/app-types.js';
import i18n from '../../i18n/index.ts';
import {
  parseCitationEnvelope,
  type CitationEnvelope,
  type CitationLocator,
  type CitationOccurrence,
  type CitationResource,
  type CitationWork,
} from '../../../contracts/citation.ts';
import { CITATION_MARKER_RE, citationIdsInText, citationOccurrenceIndex } from '../../../contracts/citation-compiler.ts';

export type ResolvedCitation = {
  occurrence: CitationOccurrence;
  work: CitationWork;
  resource: CitationResource;
  locator: CitationLocator;
  number: number;
};

export type MessageCitationProjection = {
  citations: ResolvedCitation[];
  artifacts: ResolvedCitation[];
  numbers: Record<string, number>;
  unavailableIds: string[];
  available: Map<string, AvailableCitation>;
};
export type AvailableCitation = Omit<ResolvedCitation, 'number'>;


function messageText(message: SessionEntry['message']) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return Array.isArray(message.content)
    ? message.content.filter((block) => block.type === 'text').map((block) => block.text || '').join('\n')
    : '';
}

function resolveEnvelope(envelope: NonNullable<ReturnType<typeof parseCitationEnvelope>>) {
  return citationOccurrenceIndex(envelope);
}

function projectionForIds(ids: string[], available: Map<string, AvailableCitation>): MessageCitationProjection {
  const resolved = ids.flatMap((id) => {
    const citation = available.get(id);
    return citation ? [citation] : [];
  });
  const workNumbers = new Map<string, number>();
  const citations = resolved.filter((item) => item.resource.scope !== 'artifact').map((item) => {
    const number = workNumbers.get(item.work.workId) || workNumbers.size + 1;
    workNumbers.set(item.work.workId, number);
    return { ...item, number };
  });
  const artifacts = resolved.filter((item) => item.resource.scope === 'artifact').map((item) => ({ ...item, number: 0 }));
  const numbers = Object.fromEntries(citations.map((item) => [item.occurrence.occurrenceId, item.number]));
  return { citations, artifacts, numbers, unavailableIds: ids.filter((id) => !available.has(id)), available: new Map(available) };
}

export function projectMessageCitations(entries: SessionEntry[], registry?: CitationEnvelope | null) {
  const byEntry = new Map<SessionEntry, MessageCitationProjection>();
  let available = registry ? resolveEnvelope(registry) : new Map<string, AvailableCitation>();
  for (const entry of entries) {
    const message = entry.message;
    if (message?.role === 'toolResult') {
      const envelope = parseCitationEnvelope((message.details as { citations?: unknown } | undefined)?.citations);
      if (envelope) for (const [id, citation] of resolveEnvelope(envelope)) available.set(id, citation);
      continue;
    }
    if (message?.role !== 'assistant' && message?.role !== 'user') continue;
    const ids = citationIdsInText(messageText(message));
    if (!ids.length) continue;
    byEntry.set(entry, projectionForIds(ids, available));
  }
  return { byEntry, available };
}

export function projectCitationText(text: string, available: Map<string, AvailableCitation>): MessageCitationProjection | undefined {
  const ids = citationIdsInText(text);
  if (!ids.length) return undefined;
  return projectionForIds(ids, available);
}

function locatorText(locator: CitationLocator) {
  const positions: string[] = [];
  const english = i18n.language === 'en-US';
  if (locator.page) positions.push(english ? `PDF page ${locator.page}` : `PDF 第 ${locator.page} 页`);
  if (locator.printedPage && locator.printedPage !== String(locator.page ?? '')) positions.push(english ? `printed page ${locator.printedPage}` : `正文第 ${locator.printedPage} 页`);
  if (locator.clause) positions.push(locator.clause);
  if (locator.sourceUnit) positions.push(locator.sourceUnit);
  else if (locator.nodeId) positions.push(locator.nodeId);
  else if (locator.section) positions.push(locator.section);
  if (locator.lineStart) positions.push(locator.lineEnd && locator.lineEnd !== locator.lineStart ? (english ? `lines ${locator.lineStart}–${locator.lineEnd}` : `第 ${locator.lineStart}–${locator.lineEnd} 行`) : (english ? `line ${locator.lineStart}` : `第 ${locator.lineStart} 行`));
  return positions.join(english ? ', ' : '，') || i18n.t('workspace.type.source');
}

export function citationReferenceMarkdown(projection?: MessageCitationProjection) {
  if (!projection?.citations.length) return '';
  const english = i18n.language === 'en-US';
  const references = [...projection.citations.reduce((items, item) => {
    if (!items.has(item.work.workId)) items.set(item.work.workId, item);
    return items;
  }, new Map<string, ResolvedCitation>()).values()];
  return [english ? '## References' : '## 参考文献', '', ...references.map(({ number, work, locator }) => {
    const quote = locator.quote?.replace(/\s+/g, ' ').trim() || '';
    return `${number}. **${english ? work.title : `《${work.title}》`}** — ${locatorText(locator)}${quote ? (english ? `. Excerpt: “${quote.length > 240 ? `${quote.slice(0, 240)}…` : quote}”` : `。原文摘录：“${quote.length > 240 ? `${quote.slice(0, 240)}…` : quote}”`) : ''}`;
  })].join('\n');
}

export function citationCopyText(text: string, projection?: MessageCitationProjection) {
  if (!projection) return text;
  let output = text.replace(CITATION_MARKER_RE, (_marker, raw: string) => raw.split(',').map((id) => projection.numbers[id.trim()] ? `[${projection.numbers[id.trim()]}]` : `[${i18n.language === 'en-US' ? 'citation unavailable' : '引用不可用'}]`).join(''));
  if (projection.citations.length) output += `\n\n${citationReferenceMarkdown(projection)}`;
  return output;
}
