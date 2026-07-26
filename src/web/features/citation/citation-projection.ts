import type { SessionEntry } from '../../../public/app-types.js';
import {
  parseCitationEnvelope,
  type CitationLocator,
  type CitationRecord,
  type CitationSource,
} from '../../../contracts/citation.ts';

export type ResolvedCitation = {
  citation: CitationRecord;
  source: CitationSource;
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
  const searchable = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '');
  const ids: string[] = [];
  for (const match of searchable.matchAll(MARKER_RE)) {
    for (const id of match[1].split(',').map((value) => value.trim())) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function sessionArtifacts(available: Map<string, AvailableCitation>) {
  const byPath = new Map<string, AvailableCitation>();
  for (const item of available.values()) {
    if (item.source.scope === 'session') byPath.set(item.source.relativePath.replaceAll('\\', '/'), item);
  }
  return [...byPath.values()].map((item) => ({ ...item, number: 0 }));
}

export function projectMessageCitations(entries: SessionEntry[]) {
  const byEntry = new Map<SessionEntry, MessageCitationProjection>();
  let available = new Map<string, AvailableCitation>();

  for (const entry of entries) {
    const message = entry.message;
    if (message?.role === 'user') {
      available = new Map();
      continue;
    }
    if (message?.role === 'toolResult') {
      const envelope = parseCitationEnvelope((message.details as { citations?: unknown } | undefined)?.citations);
      if (!envelope) continue;
      const sources = new Map(envelope.sources.map((source) => [source.sourceId, source]));
      const locators = new Map(envelope.locators.map((locator) => [locator.locatorId, locator]));
      for (const citation of envelope.citations) {
        const source = sources.get(citation.sourceId);
        const locator = locators.get(citation.locatorId);
        if (source && locator) available.set(citation.citationId, { citation, source, locator });
      }
      continue;
    }
    if (message?.role !== 'assistant') continue;
    const ids = citationIdsInText(messageText(message));
    const artifacts = sessionArtifacts(available);
    if (!ids.length && !artifacts.length) continue;
    const evidenceIds = ids.filter((id) => available.get(id)?.source.scope !== 'session');
    const numbers = Object.fromEntries(evidenceIds.map((id, index) => [id, index + 1]));
    const resolved = ids.flatMap((id) => {
      const citation = available.get(id);
      return citation ? [{ ...citation, number: numbers[id] || 0 }] : [];
    });
    byEntry.set(entry, {
      citations: resolved.filter((item) => item.source.scope !== 'session'),
      artifacts,
      numbers,
      unavailableIds: ids.filter((id) => !available.has(id)),
      available: new Map(available),
    });
  }

  return { byEntry, available };
}

export function projectCitationText(text: string, available: Map<string, AvailableCitation>): MessageCitationProjection | undefined {
  const ids = citationIdsInText(text);
  const artifacts = sessionArtifacts(available);
  if (!ids.length && !artifacts.length) return undefined;
  const evidenceIds = ids.filter((id) => available.get(id)?.source.scope !== 'session');
  const numbers = Object.fromEntries(evidenceIds.map((id, index) => [id, index + 1]));
  const resolved = ids.flatMap((id) => available.get(id) ? [{ ...available.get(id)!, number: numbers[id] || 0 }] : []);
  return {
    citations: resolved.filter((item) => item.source.scope !== 'session'),
    artifacts,
    numbers,
    unavailableIds: ids.filter((id) => !available.has(id)),
    available: new Map(available),
  };
}

export function stripManualCitationReferenceTail(markdown: string) {
  const generatedStart = markdown.indexOf(GENERATED_REFERENCE_START);
  const suffix = generatedStart >= 0 ? markdown.slice(generatedStart).trimStart() : '';
  const body = (generatedStart >= 0 ? markdown.slice(0, generatedStart) : markdown)
    .replace(/\n+(?:---\s*\n+)?#{1,3}\s+(?:参考依据|参考文献|引用依据)\s*\n[\s\S]*$/u, '')
    .trimEnd();
  return suffix ? `${body}\n\n${suffix}` : body;
}

export function citationDisplayText(text: string, projection?: MessageCitationProjection) {
  if (!projection?.artifacts.length) return text;
  const artifactIds = new Set(projection.artifacts.map((item) => item.citation.citationId));
  return text.replace(MARKER_RE, (marker, raw: string) => {
    const evidenceIds = raw.split(',').map((id) => id.trim()).filter((id) => !artifactIds.has(id));
    return evidenceIds.length ? `[[cite:${evidenceIds.join(', ')}]]` : '';
  });
}

export function citationReferenceMarkdown(projection?: MessageCitationProjection) {
  if (!projection?.citations.length) return '';
  const citations = [...projection.citations].sort((left, right) => left.number - right.number);
  return [
    '## 引用依据（逐条出处）',
    '',
    ...citations.map(({ number, source, locator }) => {
      const positions: string[] = [];
      if (locator.page) positions.push(`PDF 第 ${locator.page} 页`);
      if (locator.printedPage && locator.printedPage !== String(locator.page ?? '')) {
        positions.push(`正文第 ${locator.printedPage} 页`);
      }
      if (locator.sourceUnit) positions.push(locator.sourceUnit);
      else if (locator.nodeId) positions.push(locator.nodeId);
      else if (locator.section) positions.push(locator.section);
      if (locator.lineStart) {
        positions.push(
          locator.lineEnd && locator.lineEnd !== locator.lineStart
            ? `第 ${locator.lineStart}–${locator.lineEnd} 行`
            : `第 ${locator.lineStart} 行`,
        );
      }
      const normalizedQuote = locator.quote?.replace(/\s+/g, ' ').trim() || '';
      const quote = normalizedQuote.length > 240 ? `${normalizedQuote.slice(0, 240)}…` : normalizedQuote;
      return `${number}. **《${source.title}》** — ${positions.join('，') || '原始资料'}${quote ? `。原文摘录：“${quote}”` : ''}`;
    }),
  ].join('\n');
}

export function citationCopyText(text: string, projection?: MessageCitationProjection) {
  if (!projection) return text;
  let output = citationDisplayText(text, projection).replace(MARKER_RE, (_marker, raw: string) => raw
    .split(',')
    .map((id) => projection.numbers[id.trim()] ? `[${projection.numbers[id.trim()]}]` : '[引用不可用]')
    .join(''));
  if (!projection.citations.length) return output;
  output += '\n\n引用依据：\n';
  output += projection.citations.map(({ number, source, locator }) => {
    const position = locator.page
      ? `PDF 第${locator.page}页${locator.printedPage ? `（正文第${locator.printedPage}页）` : ''}`
      : locator.section || locator.sourceUnit || locator.nodeId || '';
    return `[${number}] ${source.title}${position ? `，${position}` : ''}`;
  }).join('\n');
  return output;
}
