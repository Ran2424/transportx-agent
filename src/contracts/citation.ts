import { asPositiveInteger, asRecord, asString, type JsonRecord } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';
import { CITATION_ENVELOPE_PROTOCOL, CITATION_ENVELOPE_VERSION } from './version.ts';

export type CitationSourceKind = 'pdf' | 'document' | 'image';
export type CitationSourceScope = 'knowledge' | 'session';

export type CitationSource = {
  sourceId: string;
  kind: CitationSourceKind;
  scope: CitationSourceScope;
  title: string;
  relativePath: string;
  mimeType: string;
  sha256: string;
};

export type CitationLocator = {
  locatorId: string;
  sourceId: string;
  quote?: string;
  nodeId?: string;
  clause?: string;
  section?: string;
  page?: number;
  printedPage?: string;
  sourceUnit?: string;
  lineStart?: number;
  lineEnd?: number;
};

export type CitationRecord = {
  citationId: string;
  sourceId: string;
  locatorId: string;
  knowledgeId?: string;
  documentClass?: string;
  normativeForce?: string;
  verificationStatus?: string;
};

export type CitationEnvelope = {
  protocol: typeof CITATION_ENVELOPE_PROTOCOL;
  version: typeof CITATION_ENVELOPE_VERSION;
  citationSetId: string;
  citations: CitationRecord[];
  sources: CitationSource[];
  locators: CitationLocator[];
  generatedAt: string;
};

export type CitationParseResult =
  | { ok: true; value: CitationEnvelope; diagnostics: [] }
  | { ok: false; value: null; diagnostics: ContractDiagnostic[] };

const SOURCE_KINDS = new Set<CitationSourceKind>(['pdf', 'document', 'image']);
const SOURCE_SCOPES = new Set<CitationSourceScope>(['knowledge', 'session']);
const SHA256_RE = /^[a-f0-9]{64}$/;

function optionalText(record: JsonRecord, key: string, max = 4000) {
  const value = record[key];
  return value === undefined ? undefined : asString(value, max) ?? undefined;
}

export function parseCitationEnvelopeStructured(value: unknown): CitationParseResult {
  const root = asRecord(value);
  if (!root) return invalid('citations', 'Citation envelope must be an object.');
  if (root.protocol !== CITATION_ENVELOPE_PROTOCOL || root.version !== CITATION_ENVELOPE_VERSION) {
    return invalid('citations.version', `Unsupported citation envelope ${String(root.protocol)} ${String(root.version)}.`);
  }
  const citationSetId = asString(root.citationSetId, 120);
  const generatedAt = asString(root.generatedAt, 80);
  if (!citationSetId || !generatedAt) return invalid('citations', 'citationSetId and generatedAt are required.');
  if (!Array.isArray(root.sources) || !Array.isArray(root.locators) || !Array.isArray(root.citations)) {
    return invalid('citations', 'sources, locators and citations must be arrays.');
  }
  if (root.sources.length > 50 || root.locators.length > 100 || root.citations.length > 100) {
    return invalid('citations', 'Citation envelope exceeds its item limit.');
  }

  const sources: CitationSource[] = [];
  const sourceIds = new Set<string>();
  for (const [index, candidate] of root.sources.entries()) {
    const item = asRecord(candidate);
    const sourceId = asString(item?.sourceId, 160);
    const title = asString(item?.title, 500);
    const relativePath = asString(item?.relativePath, 1000);
    const mimeType = asString(item?.mimeType, 120);
    const sha256 = asString(item?.sha256, 64);
    if (!item || !sourceId || !title || !relativePath || !mimeType || !sha256 || !SHA256_RE.test(sha256)
      || !SOURCE_KINDS.has(item.kind as CitationSourceKind) || !SOURCE_SCOPES.has(item.scope as CitationSourceScope)
      || sourceIds.has(sourceId)) {
      return invalid(`citations.sources[${index}]`, 'Invalid or duplicate citation source.');
    }
    sourceIds.add(sourceId);
    sources.push({ sourceId, title, relativePath, mimeType, sha256, kind: item.kind as CitationSourceKind, scope: item.scope as CitationSourceScope });
  }

  const locators: CitationLocator[] = [];
  const locatorIds = new Set<string>();
  for (const [index, candidate] of root.locators.entries()) {
    const item = asRecord(candidate);
    const locatorId = asString(item?.locatorId, 180);
    const sourceId = asString(item?.sourceId, 160);
    const page = item?.page === undefined ? undefined : asPositiveInteger(item.page) ?? undefined;
    const lineStart = item?.lineStart === undefined ? undefined : asPositiveInteger(item.lineStart) ?? undefined;
    const lineEnd = item?.lineEnd === undefined ? undefined : asPositiveInteger(item.lineEnd) ?? undefined;
    if (!item || !locatorId || !sourceId || !sourceIds.has(sourceId) || locatorIds.has(locatorId)
      || (item.page !== undefined && page === undefined)
      || (item.lineStart !== undefined && lineStart === undefined)
      || (item.lineEnd !== undefined && lineEnd === undefined)
      || (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart)) {
      return invalid(`citations.locators[${index}]`, 'Invalid or duplicate citation locator.');
    }
    locatorIds.add(locatorId);
    locators.push({
      locatorId,
      sourceId,
      ...(optionalText(item, 'quote') ? { quote: optionalText(item, 'quote') } : {}),
      ...(optionalText(item, 'nodeId', 300) ? { nodeId: optionalText(item, 'nodeId', 300) } : {}),
      ...(optionalText(item, 'clause', 300) ? { clause: optionalText(item, 'clause', 300) } : {}),
      ...(optionalText(item, 'section', 500) ? { section: optionalText(item, 'section', 500) } : {}),
      ...(page ? { page } : {}),
      ...(optionalText(item, 'printedPage', 80) ? { printedPage: optionalText(item, 'printedPage', 80) } : {}),
      ...(optionalText(item, 'sourceUnit', 300) ? { sourceUnit: optionalText(item, 'sourceUnit', 300) } : {}),
      ...(lineStart ? { lineStart } : {}),
      ...(lineEnd ? { lineEnd } : {}),
    });
  }

  const citations: CitationRecord[] = [];
  const citationIds = new Set<string>();
  for (const [index, candidate] of root.citations.entries()) {
    const item = asRecord(candidate);
    const citationId = asString(item?.citationId, 180);
    const sourceId = asString(item?.sourceId, 160);
    const locatorId = asString(item?.locatorId, 180);
    if (!item || !citationId || !sourceId || !locatorId || citationIds.has(citationId)
      || !sourceIds.has(sourceId) || !locatorIds.has(locatorId)) {
      return invalid(`citations.citations[${index}]`, 'Invalid or duplicate citation record.');
    }
    citationIds.add(citationId);
    citations.push({
      citationId,
      sourceId,
      locatorId,
      ...(optionalText(item, 'knowledgeId', 180) ? { knowledgeId: optionalText(item, 'knowledgeId', 180) } : {}),
      ...(optionalText(item, 'documentClass', 120) ? { documentClass: optionalText(item, 'documentClass', 120) } : {}),
      ...(optionalText(item, 'normativeForce', 120) ? { normativeForce: optionalText(item, 'normativeForce', 120) } : {}),
      ...(optionalText(item, 'verificationStatus', 120) ? { verificationStatus: optionalText(item, 'verificationStatus', 120) } : {}),
    });
  }

  return {
    ok: true,
    value: { protocol: CITATION_ENVELOPE_PROTOCOL, version: CITATION_ENVELOPE_VERSION, citationSetId, citations, sources, locators, generatedAt },
    diagnostics: [],
  };
}

export function parseCitationEnvelope(value: unknown): CitationEnvelope | null {
  const result = parseCitationEnvelopeStructured(value);
  return result.ok ? result.value : null;
}

function invalid(path: string, message: string): CitationParseResult {
  return { ok: false, value: null, diagnostics: [diagnostic({ code: 'invalid_type', path, message })] };
}
