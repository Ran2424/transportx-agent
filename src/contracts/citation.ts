import { asPositiveInteger, asRecord, asString, type JsonRecord } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';
import { CITATION_ENVELOPE_PROTOCOL, CITATION_ENVELOPE_VERSION } from './version.ts';

export type CitationResourceKind = 'pdf' | 'document' | 'image' | 'web' | 'dataset';
export type CitationResourceScope = 'knowledge' | 'attachment' | 'artifact' | 'web' | 'dataset';
export type CitationContainerType = 'message' | 'document' | 'artifact';
export type CitationRole = 'support' | 'background' | 'data-source' | 'method' | 'counterexample' | 'artifact-source';
export type CitationProvenanceRelation = 'derived-from' | 'queried-from' | 'sourced-from';

export type CitationWork = {
  workId: string;
  citekey?: string;
  type: string;
  title: string;
  author?: string[];
  issuer?: string;
  issuedAt?: string;
  standardNumber?: string;
  edition?: string;
  url?: string;
};

export type CitationResource = {
  resourceId: string;
  workId: string;
  kind: CitationResourceKind;
  scope: CitationResourceScope;
  relativePath: string;
  mimeType: string;
  sha256: string;
  acquiredAt?: string;
  sourceUrl?: string;
};

export type CitationLocator = {
  locatorId: string;
  resourceId: string;
  quote?: string;
  nodeId?: string;
  clause?: string;
  section?: string;
  page?: number;
  printedPage?: string;
  sourceUnit?: string;
  lineStart?: number;
  lineEnd?: number;
  table?: string;
  figure?: string;
};

export type CitationOccurrence = {
  occurrenceId: string;
  locatorId: string;
  containerType: CitationContainerType;
  containerId: string;
  anchorId?: string;
  role?: CitationRole;
};

export type CitationProvenanceEdge = {
  provenanceId: string;
  fromResourceId: string;
  toResourceId: string;
  relation: CitationProvenanceRelation;
  generatedAt?: string;
};

export type CitationEnvelope = {
  protocol: typeof CITATION_ENVELOPE_PROTOCOL;
  version: typeof CITATION_ENVELOPE_VERSION;
  citationSetId: string;
  generatedAt: string;
  works: CitationWork[];
  resources: CitationResource[];
  locators: CitationLocator[];
  occurrences: CitationOccurrence[];
  provenance: CitationProvenanceEdge[];
};

export type CitationRegistry = CitationEnvelope & {
  schemaVersion: 1;
  sessionId: string;
  updatedAt: string;
};

export type CitationParseResult<T = CitationEnvelope> =
  | { ok: true; value: T; diagnostics: [] }
  | { ok: false; value: null; diagnostics: ContractDiagnostic[] };

const RESOURCE_KINDS = new Set<CitationResourceKind>(['pdf', 'document', 'image', 'web', 'dataset']);
const RESOURCE_SCOPES = new Set<CitationResourceScope>(['knowledge', 'attachment', 'artifact', 'web', 'dataset']);
const CONTAINER_TYPES = new Set<CitationContainerType>(['message', 'document', 'artifact']);
const ROLES = new Set<CitationRole>(['support', 'background', 'data-source', 'method', 'counterexample', 'artifact-source']);
const PROVENANCE_RELATIONS = new Set<CitationProvenanceRelation>(['derived-from', 'queried-from', 'sourced-from']);
const SHA256_RE = /^[a-f0-9]{64}$/;

function optionalText(record: JsonRecord, key: string, max = 4000) {
  const value = record[key];
  return value === undefined ? undefined : asString(value, max) ?? undefined;
}

function textList(value: unknown, maxItems = 80, maxLength = 300) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const items = value.map((item) => asString(item, maxLength));
  return items.every(Boolean) ? items as string[] : null;
}

function invalid<T = CitationEnvelope>(path: string, message: string): CitationParseResult<T> {
  return { ok: false, value: null, diagnostics: [diagnostic({ code: 'invalid_type', path, message })] };
}

function uniqueId(record: JsonRecord | null, key: string, ids: Set<string>, path: string) {
  const id = asString(record?.[key], 180);
  if (!id || ids.has(id)) return null;
  ids.add(id);
  return id;
}

export function parseCitationEnvelopeStructured(value: unknown): CitationParseResult {
  const root = asRecord(value);
  if (!root) return invalid('citations', 'Citation envelope must be an object.');
  if (root.protocol !== CITATION_ENVELOPE_PROTOCOL || root.version !== CITATION_ENVELOPE_VERSION) {
    return invalid('citations.version', `Unsupported citation envelope ${String(root.protocol)} ${String(root.version)}.`);
  }
  const citationSetId = asString(root.citationSetId, 180);
  const generatedAt = asString(root.generatedAt, 80);
  if (!citationSetId || !generatedAt) return invalid('citations', 'citationSetId and generatedAt are required.');
  if (!Array.isArray(root.works) || !Array.isArray(root.resources) || !Array.isArray(root.locators) || !Array.isArray(root.occurrences) || !Array.isArray(root.provenance)) {
    return invalid('citations', 'works, resources, locators, occurrences and provenance must be arrays.');
  }
  if (root.works.length > 100 || root.resources.length > 100 || root.locators.length > 200 || root.occurrences.length > 300 || root.provenance.length > 300) {
    return invalid('citations', 'Citation envelope exceeds its item limit.');
  }

  const works: CitationWork[] = [];
  const workIds = new Set<string>();
  for (const [index, candidate] of root.works.entries()) {
    const item = asRecord(candidate);
    const workId = uniqueId(item, 'workId', workIds, `citations.works[${index}]`);
    const type = asString(item?.type, 120);
    const title = asString(item?.title, 500);
    const author = textList(item?.author);
    if (!item || !workId || !type || !title || author === null) return invalid(`citations.works[${index}]`, 'Invalid or duplicate citation work.');
    works.push({ workId, type, title, ...(optionalText(item, 'citekey', 180) ? { citekey: optionalText(item, 'citekey', 180) } : {}), ...(author?.length ? { author } : {}), ...(optionalText(item, 'issuer', 300) ? { issuer: optionalText(item, 'issuer', 300) } : {}), ...(optionalText(item, 'issuedAt', 80) ? { issuedAt: optionalText(item, 'issuedAt', 80) } : {}), ...(optionalText(item, 'standardNumber', 180) ? { standardNumber: optionalText(item, 'standardNumber', 180) } : {}), ...(optionalText(item, 'edition', 180) ? { edition: optionalText(item, 'edition', 180) } : {}), ...(optionalText(item, 'url', 2000) ? { url: optionalText(item, 'url', 2000) } : {}) });
  }

  const resources: CitationResource[] = [];
  const resourceIds = new Set<string>();
  for (const [index, candidate] of root.resources.entries()) {
    const item = asRecord(candidate);
    const resourceId = uniqueId(item, 'resourceId', resourceIds, `citations.resources[${index}]`);
    const workId = asString(item?.workId, 180);
    const relativePath = asString(item?.relativePath, 1000);
    const mimeType = asString(item?.mimeType, 120);
    const sha256 = asString(item?.sha256, 64);
    if (!item || !resourceId || !workId || !workIds.has(workId) || !relativePath || !mimeType || !sha256 || !SHA256_RE.test(sha256) || !RESOURCE_KINDS.has(item.kind as CitationResourceKind) || !RESOURCE_SCOPES.has(item.scope as CitationResourceScope)) return invalid(`citations.resources[${index}]`, 'Invalid or duplicate citation resource.');
    resources.push({ resourceId, workId, relativePath, mimeType, sha256, kind: item.kind as CitationResourceKind, scope: item.scope as CitationResourceScope, ...(optionalText(item, 'acquiredAt', 80) ? { acquiredAt: optionalText(item, 'acquiredAt', 80) } : {}), ...(optionalText(item, 'sourceUrl', 2000) ? { sourceUrl: optionalText(item, 'sourceUrl', 2000) } : {}) });
  }

  const locators: CitationLocator[] = [];
  const locatorIds = new Set<string>();
  for (const [index, candidate] of root.locators.entries()) {
    const item = asRecord(candidate);
    const locatorId = uniqueId(item, 'locatorId', locatorIds, `citations.locators[${index}]`);
    const resourceId = asString(item?.resourceId, 180);
    const page = item?.page === undefined ? undefined : asPositiveInteger(item.page) ?? undefined;
    const lineStart = item?.lineStart === undefined ? undefined : asPositiveInteger(item.lineStart) ?? undefined;
    const lineEnd = item?.lineEnd === undefined ? undefined : asPositiveInteger(item.lineEnd) ?? undefined;
    if (!item || !locatorId || !resourceId || !resourceIds.has(resourceId) || (item.page !== undefined && page === undefined) || (item.lineStart !== undefined && lineStart === undefined) || (item.lineEnd !== undefined && lineEnd === undefined) || (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart)) return invalid(`citations.locators[${index}]`, 'Invalid or duplicate citation locator.');
    locators.push({ locatorId, resourceId, ...(optionalText(item, 'quote') ? { quote: optionalText(item, 'quote') } : {}), ...(optionalText(item, 'nodeId', 300) ? { nodeId: optionalText(item, 'nodeId', 300) } : {}), ...(optionalText(item, 'clause', 300) ? { clause: optionalText(item, 'clause', 300) } : {}), ...(optionalText(item, 'section', 500) ? { section: optionalText(item, 'section', 500) } : {}), ...(page ? { page } : {}), ...(optionalText(item, 'printedPage', 80) ? { printedPage: optionalText(item, 'printedPage', 80) } : {}), ...(optionalText(item, 'sourceUnit', 300) ? { sourceUnit: optionalText(item, 'sourceUnit', 300) } : {}), ...(lineStart ? { lineStart } : {}), ...(lineEnd ? { lineEnd } : {}), ...(optionalText(item, 'table', 300) ? { table: optionalText(item, 'table', 300) } : {}), ...(optionalText(item, 'figure', 300) ? { figure: optionalText(item, 'figure', 300) } : {}) });
  }

  const occurrences: CitationOccurrence[] = [];
  const occurrenceIds = new Set<string>();
  for (const [index, candidate] of root.occurrences.entries()) {
    const item = asRecord(candidate);
    const occurrenceId = uniqueId(item, 'occurrenceId', occurrenceIds, `citations.occurrences[${index}]`);
    const locatorId = asString(item?.locatorId, 180);
    const containerId = asString(item?.containerId, 300);
    if (!item || !occurrenceId || !locatorId || !locatorIds.has(locatorId) || !containerId || !CONTAINER_TYPES.has(item.containerType as CitationContainerType) || (item.role !== undefined && !ROLES.has(item.role as CitationRole))) return invalid(`citations.occurrences[${index}]`, 'Invalid or duplicate citation occurrence.');
    occurrences.push({ occurrenceId, locatorId, containerId, containerType: item.containerType as CitationContainerType, ...(optionalText(item, 'anchorId', 300) ? { anchorId: optionalText(item, 'anchorId', 300) } : {}), ...(item.role ? { role: item.role as CitationRole } : {}) });
  }

  const provenance: CitationProvenanceEdge[] = [];
  const provenanceIds = new Set<string>();
  for (const [index, candidate] of root.provenance.entries()) {
    const item = asRecord(candidate);
    const provenanceId = uniqueId(item, 'provenanceId', provenanceIds, `citations.provenance[${index}]`);
    const fromResourceId = asString(item?.fromResourceId, 180);
    const toResourceId = asString(item?.toResourceId, 180);
    if (!item || !provenanceId || !fromResourceId || !toResourceId || !resourceIds.has(fromResourceId) || !resourceIds.has(toResourceId) || fromResourceId === toResourceId || !PROVENANCE_RELATIONS.has(item.relation as CitationProvenanceRelation)) return invalid(`citations.provenance[${index}]`, 'Invalid or duplicate citation provenance edge.');
    provenance.push({ provenanceId, fromResourceId, toResourceId, relation: item.relation as CitationProvenanceRelation, ...(optionalText(item, 'generatedAt', 80) ? { generatedAt: optionalText(item, 'generatedAt', 80) } : {}) });
  }
  return { ok: true, value: { protocol: CITATION_ENVELOPE_PROTOCOL, version: CITATION_ENVELOPE_VERSION, citationSetId, generatedAt, works, resources, locators, occurrences, provenance }, diagnostics: [] };
}

export function parseCitationEnvelope(value: unknown): CitationEnvelope | null {
  const result = parseCitationEnvelopeStructured(value);
  return result.ok ? result.value : null;
}

export function parseCitationRegistryStructured(value: unknown): CitationParseResult<CitationRegistry> {
  const root = asRecord(value);
  const parsed = parseCitationEnvelopeStructured(value);
  const sessionId = asString(root?.sessionId, 180);
  const updatedAt = asString(root?.updatedAt, 80);
  if (!parsed.ok) return parsed;
  if (!root || root.schemaVersion !== 1 || !sessionId || !updatedAt) return invalid('citationRegistry', 'schemaVersion, sessionId and updatedAt are required.');
  return { ok: true, value: { ...parsed.value, schemaVersion: 1, sessionId, updatedAt }, diagnostics: [] };
}

export function parseCitationRegistry(value: unknown): CitationRegistry | null {
  const result = parseCitationRegistryStructured(value);
  return result.ok ? result.value : null;
}
