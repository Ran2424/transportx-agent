import type { SessionEntry } from '../../../public/app-types.js';
import i18n from '../../i18n';
import {
  parseCitationEnvelope,
  type CitationLocator,
  type CitationOccurrence,
  type CitationResource,
  type CitationWork,
} from '../../../contracts/citation.ts';

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

const MARKER_RE = /\[\[cite:([A-Za-z0-9_.:-]+(?:\s*,\s*[A-Za-z0-9_.:-]+)*)\]\]/g;
const GENERATED_REFERENCE_START = '<!-- tau:references:start -->';

function messageText(message: SessionEntry['message']) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return Array.isArray(message.content)
    ? message.content.filter((block) => block.type === 'text').map((block) => block.text || '').join('\n')
    : '';
}

export function citationIdsInText(text: string) {
  const searchable = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  const ids: string[] = [];
  for (const match of searchable.matchAll(MARKER_RE)) {
    for (const id of match[1].split(',').map((value) => value.trim())) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function resolveEnvelope(envelope: NonNullable<ReturnType<typeof parseCitationEnvelope>>) {
  const works = new Map(envelope.works.map((item) => [item.workId, item]));
  const resources = new Map(envelope.resources.map((item) => [item.resourceId, item]));
  const locators = new Map(envelope.locators.map((item) => [item.locatorId, item]));
  const resolved = new Map<string, AvailableCitation>();
  for (const occurrence of envelope.occurrences) {
    const locator = locators.get(occurrence.locatorId);
    const resource = locator ? resources.get(locator.resourceId) : null;
    const work = resource ? works.get(resource.workId) : null;
    if (locator && resource && work) resolved.set(occurrence.occurrenceId, { occurrence, locator, resource, work });
  }
  return resolved;
}

export function projectMessageCitations(entries: SessionEntry[]) {
  const byEntry = new Map<SessionEntry, MessageCitationProjection>();
  let available = new Map<string, AvailableCitation>();
  for (const entry of entries) {
    const message = entry.message;
    if (message?.role === 'toolResult') {
      const envelope = parseCitationEnvelope((message.details as { citations?: unknown } | undefined)?.citations);
      if (envelope) for (const [id, citation] of resolveEnvelope(envelope)) available.set(id, citation);
      continue;
    }
    if (message?.role !== 'assistant') continue;
    const ids = citationIdsInText(messageText(message));
    if (!ids.length) continue;
    const resolved = ids.flatMap((id) => {
      const citation = available.get(id);
      return citation ? [citation] : [];
    });
    const citations = resolved.filter((item) => item.resource.scope !== 'artifact').map((item, index) => ({ ...item, number: index + 1 }));
    const artifacts = resolved.filter((item) => item.resource.scope === 'artifact').map((item) => ({ ...item, number: 0 }));
    const numbers = Object.fromEntries(citations.map((item) => [item.occurrence.occurrenceId, item.number]));
    byEntry.set(entry, { citations, artifacts, numbers, unavailableIds: ids.filter((id) => !available.has(id)), available: new Map(available) });
  }
  return { byEntry, available };
}

export function projectCitationText(text: string, available: Map<string, AvailableCitation>): MessageCitationProjection | undefined {
  const ids = citationIdsInText(text);
  if (!ids.length) return undefined;
  const resolved = ids.flatMap((id) => available.get(id) ? [available.get(id)!] : []);
  const citations = resolved.filter((item) => item.resource.scope !== 'artifact').map((item, index) => ({ ...item, number: index + 1 }));
  const artifacts = resolved.filter((item) => item.resource.scope === 'artifact').map((item) => ({ ...item, number: 0 }));
  const numbers = Object.fromEntries(citations.map((item) => [item.occurrence.occurrenceId, item.number]));
  return { citations, artifacts, numbers, unavailableIds: ids.filter((id) => !available.has(id)), available: new Map(available) };
}

export function stripManualCitationReferenceTail(markdown: string) {
  const generatedStart = markdown.indexOf(GENERATED_REFERENCE_START);
  const suffix = generatedStart >= 0 ? markdown.slice(generatedStart).trimStart() : '';
  const body = (generatedStart >= 0 ? markdown.slice(0, generatedStart) : markdown)
    .replace(/\n+(?:---\s*\n+)?#{1,3}\s+(?:参考依据|参考文献|引用依据)\s*\n[\s\S]*$/u, '')
    .trimEnd();
  return suffix ? `${body}\n\n${suffix}` : body;
}

export function citationDisplayText(text: string, _projection?: MessageCitationProjection) { return text; }

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
  return [english ? '## References' : '## 参考文献', '', ...projection.citations.map(({ number, work, locator }) => {
    const quote = locator.quote?.replace(/\s+/g, ' ').trim() || '';
    return `${number}. **${english ? work.title : `《${work.title}》`}** — ${locatorText(locator)}${quote ? (english ? `. Excerpt: “${quote.length > 240 ? `${quote.slice(0, 240)}…` : quote}”` : `。原文摘录：“${quote.length > 240 ? `${quote.slice(0, 240)}…` : quote}”`) : ''}`;
  })].join('\n');
}

export function citationCopyText(text: string, projection?: MessageCitationProjection) {
  if (!projection) return text;
  let output = text.replace(MARKER_RE, (_marker, raw: string) => raw.split(',').map((id) => projection.numbers[id.trim()] ? `[${projection.numbers[id.trim()]}]` : `[${i18n.language === 'en-US' ? 'citation unavailable' : '引用不可用'}]`).join(''));
  if (projection.citations.length) output += `\n\n${citationReferenceMarkdown(projection)}`;
  return output;
}
