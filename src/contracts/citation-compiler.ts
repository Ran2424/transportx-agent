import type { CitationEnvelope, CitationLocator, CitationOccurrence, CitationResource, CitationWork } from './citation.ts';

export type CitationProfile = 'chat-numeric' | 'gbt7714-numeric';
export type CompiledCitation = { occurrenceId: string; number: number; work: CitationWork; resource: CitationResource; locator: CitationLocator };
export type CitationCompileResult = {
  markdown: string;
  numbers: Record<string, number>;
  references: CompiledCitation[];
  citationMap: Record<string, { workId: string; resourceId: string; locatorId: string; number: number }>;
  unavailableIds: string[];
};
export type CitationExportFormat = 'bibtex' | 'csl-json' | 'ris';

const MARKER_RE = /\[\[cite:([A-Za-z0-9_.:-]+(?:\s*,\s*[A-Za-z0-9_.:-]+)*)\]\]/g;
const GENERATED_REFERENCE_RE = /\n*<!-- tau:references:start -->[\s\S]*?<!-- tau:references:end -->\s*$/;

function bodyWithoutReferences(markdown: string) {
  return markdown.replace(GENERATED_REFERENCE_RE, '').trimEnd();
}

function occurrenceIndex(envelope: CitationEnvelope) {
  const works = new Map(envelope.works.map((item) => [item.workId, item]));
  const resources = new Map(envelope.resources.map((item) => [item.resourceId, item]));
  const locators = new Map(envelope.locators.map((item) => [item.locatorId, item]));
  const resolved = new Map<string, Omit<CompiledCitation, 'number'>>();
  for (const occurrence of envelope.occurrences) {
    const locator = locators.get(occurrence.locatorId);
    const resource = locator && resources.get(locator.resourceId);
    const work = resource && works.get(resource.workId);
    if (locator && resource && work) resolved.set(occurrence.occurrenceId, { occurrenceId: occurrence.occurrenceId, work, resource, locator });
  }
  return resolved;
}

function locatorText(locator: CitationLocator) {
  const text: string[] = [];
  if (locator.page) text.push(`第${locator.page}页`);
  if (locator.clause) text.push(locator.clause);
  else if (locator.section) text.push(locator.section);
  else if (locator.sourceUnit) text.push(locator.sourceUnit);
  if (locator.table) text.push(locator.table);
  if (locator.figure) text.push(locator.figure);
  return text.join('，');
}

export function formatGbt7714Reference(citation: CompiledCitation) {
  const { work, locator } = citation;
  const author = work.author?.join('，') || work.issuer || '佚名';
  const suffix = [work.issuedAt, work.edition, work.standardNumber].filter(Boolean).join('，');
  const location = locatorText(locator);
  return `${citation.number}. ${author}. ${work.title}[${work.type || 'Z'}]${suffix ? `. ${suffix}` : ''}${location ? `. ${location}` : ''}${work.url ? `. ${work.url}` : ''}.`;
}

export function compileCitations(markdown: string, envelope: CitationEnvelope, profile: CitationProfile = 'gbt7714-numeric'): CitationCompileResult {
  const available = occurrenceIndex(envelope);
  const numbers: Record<string, number> = {};
  const citationMap: CitationCompileResult['citationMap'] = {};
  const references: CompiledCitation[] = [];
  const workNumbers = new Map<string, number>();
  const unavailableIds: string[] = [];
  const body = bodyWithoutReferences(markdown);
  const searchable = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  for (const match of searchable.matchAll(MARKER_RE)) {
    for (const occurrenceId of match[1].split(',').map((item) => item.trim())) {
      const citation = available.get(occurrenceId);
      if (!citation) { if (!unavailableIds.includes(occurrenceId)) unavailableIds.push(occurrenceId); continue; }
      const number = workNumbers.get(citation.work.workId) || references.length + 1;
      if (!workNumbers.has(citation.work.workId)) {
        workNumbers.set(citation.work.workId, number);
        references.push({ ...citation, number });
      }
      numbers[occurrenceId] = number;
      citationMap[occurrenceId] = { workId: citation.work.workId, resourceId: citation.resource.resourceId, locatorId: citation.locator.locatorId, number };
    }
  }
  const referenceLines = profile === 'gbt7714-numeric'
    ? references.map(formatGbt7714Reference)
    : references.map((item) => `${item.number}. ${item.work.title}`);
  const referenceBlock = references.length ? `\n\n<!-- tau:references:start -->\n## 参考文献\n\n${referenceLines.join('\n')}\n<!-- tau:references:end -->` : '';
  return { markdown: `${body}${referenceBlock}`, numbers, references, citationMap, unavailableIds };
}

function exportWorks(envelope: CitationEnvelope) {
  const seen = new Set<string>();
  return envelope.works.filter((work) => !seen.has(work.workId) && !!seen.add(work.workId));
}

export function exportCitationBibliography(envelope: CitationEnvelope, format: CitationExportFormat) {
  const works = exportWorks(envelope);
  if (format === 'csl-json') return JSON.stringify(works.map((work) => ({ id: work.citekey || work.workId, type: work.type, title: work.title, author: work.author?.map((literal) => ({ literal })), publisher: work.issuer, issued: work.issuedAt ? { raw: work.issuedAt } : undefined, number: work.standardNumber, edition: work.edition, URL: work.url })), null, 2);
  if (format === 'ris') return works.map((work) => ['TY  - GEN', `ID  - ${work.citekey || work.workId}`, `TI  - ${work.title}`, ...(work.author || []).map((author) => `AU  - ${author}`), ...(work.issuer ? [`PB  - ${work.issuer}`] : []), ...(work.issuedAt ? [`PY  - ${work.issuedAt}`] : []), ...(work.standardNumber ? [`SN  - ${work.standardNumber}`] : []), ...(work.url ? [`UR  - ${work.url}`] : []), 'ER  - '].join('\n')).join('\n\n');
  return works.map((work) => `@misc{${work.citekey || work.workId},\n  title = {${work.title}},${work.author?.length ? `\n  author = {${work.author.join(' and ')}},` : ''}${work.issuer ? `\n  publisher = {${work.issuer}},` : ''}${work.issuedAt ? `\n  year = {${work.issuedAt}},` : ''}${work.standardNumber ? `\n  number = {${work.standardNumber}},` : ''}${work.url ? `\n  url = {${work.url}},` : ''}\n}`).join('\n\n');
}
