import { asRecord, asString } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';
import { CITATION_ENVELOPE_PROTOCOL, CITATION_ENVELOPE_VERSION } from './version.ts';

export const CITATION_INLINE_LIMIT = 256 * 1024;
export const CITATION_REGISTRY_LIMIT = 8 * 1024 * 1024;
export const CITATION_PREVIEW_LIMIT = 2 * 1024 * 1024;
export const CITATION_PREVIEW_ROWS = 200;
export type CitationTable = { columns: string[]; rows: (string | number | boolean | null)[][] };
export type CitationInline = string | CitationTable;
export type CitationFile = { kind: 'file'; scope: 'session' | 'asset'; assetId?: string; path: string; mimeType: string; sha256: string; size: number };
export type CitationContent = CitationFile | { kind: 'inline'; sha256: string; value?: CitationInline };
export type CitationMetadata = { author?: string[]; issuer?: string; issuedAt?: string; standardNumber?: string; edition?: string; url?: string; version?: string; timeRange?: string; querySummary?: string; bibliographicType?: 'S' | 'R' | 'M' | 'J' | 'EB/OL' | 'DS' | 'Z' };
export type CitationSourceVersion = {
  sourceVersionId: string; sourceKey: string; title: string; content: CitationContent; acquiredAt: string;
  metadata?: CitationMetadata;
  executionRef?: { path: string; sha256: string; operation: string; inputHashes: string[] };
};
export type CitationLocator =
  | { kind: 'document'; page?: number; printedPage?: string; section?: string; nodeId?: string; lineStart?: number; lineEnd?: number }
  | { kind: 'table'; rowStart?: number; rowEnd?: number; columns?: string[]; sheet?: string; cell?: string }
  | { kind: 'result'; field: string }
  | { kind: 'source' };
export const CITATION_CONTENT_LABELS = { excerpt: '原文摘录', summary: '知识归纳', result: '数据结果', 'source-only': '出处' } as const;
export type CitationEvidence = { evidenceId: string; sourceVersionId: string; locator: CitationLocator; contentKind: 'excerpt' | 'summary' | 'result' | 'source-only'; text?: string };
export type CitationEnvelope = { protocol: typeof CITATION_ENVELOPE_PROTOCOL; version: typeof CITATION_ENVELOPE_VERSION; sources: CitationSourceVersion[]; evidence: CitationEvidence[]; nextOffset?: number };
export type CitationRegistry = CitationEnvelope & { schemaVersion: 2; sessionId: string };
export type CitationPreview = { kind: 'text'; text: string; truncated: boolean } | { kind: 'table'; table: CitationTable; rowStart?: number; truncated: boolean } | { kind: 'none'; reason: string };
export type CitationDetail = { source: CitationSourceVersion; evidence: CitationEvidence; preview: CitationPreview };
export type CitationParseResult<T = CitationEnvelope> = { ok: true; value: T; diagnostics: [] } | { ok: false; value: null; diagnostics: ContractDiagnostic[] };
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.:-]{1,180}$/;
export function citationRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/^[\\/]|^[A-Za-z]:|\\|\x00/.test(value) && value.split('/').every((part) => part !== '..' && part !== '' && part !== '.');
}
function exactKeys(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).every((key) => keys.includes(key)); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length <= 4000); }
export function isCitationInline(value: unknown): value is CitationInline {
  if (new TextEncoder().encode(JSON.stringify(value) ?? '').length > CITATION_INLINE_LIMIT) return false;
  if (typeof value === 'string') return true;
  const table = asRecord(value);
  return !!table && strings(table.columns) && table.columns.length > 0 && Array.isArray(table.rows) && table.rows.length <= CITATION_PREVIEW_ROWS && table.rows.every((row) => Array.isArray(row) && row.length === (table.columns as string[]).length && row.every((cell) => cell === null || typeof cell === 'string' || typeof cell === 'boolean' || (typeof cell === 'number' && Number.isFinite(cell))));
}
export function parseCitationLocator(value: unknown): CitationLocator | null {
  const item = asRecord(value);
  if (!item) return null;
  const fields: Record<string, string[]> = { source: [], result: ['field'], document: ['page', 'printedPage', 'section', 'nodeId', 'lineStart', 'lineEnd'], table: ['rowStart', 'rowEnd', 'columns', 'sheet', 'cell'] };
  if (typeof item.kind !== 'string' || !Object.hasOwn(fields, item.kind) || Object.keys(item).some((key) => key !== 'kind' && !fields[item.kind as string].includes(key))) return null;
  for (const key of fields[item.kind]) {
    if (item[key] === undefined) continue;
    if (['page', 'lineStart', 'lineEnd', 'rowStart', 'rowEnd'].includes(key)) { if (!Number.isSafeInteger(item[key]) || Number(item[key]) < 1) return null; }
    else if (key === 'columns') { if (!strings(item[key])) return null; }
    else if (!asString(item[key], 4000)) return null;
  }
  if (item.kind === 'result' && !asString(item.field, 4000)) return null;
  if (item.kind === 'document' && !fields.document.some((key) => item[key] !== undefined)) return null;
  if (item.kind === 'table' && !item.rowStart && !item.sheet && !item.cell && !(Array.isArray(item.columns) && item.columns.length)) return null;
  if (item.lineEnd !== undefined && (item.lineStart === undefined || Number(item.lineEnd) < Number(item.lineStart))) return null;
  if (item.rowEnd !== undefined && (item.rowStart === undefined || Number(item.rowEnd) < Number(item.rowStart))) return null;
  if (item.cell !== undefined && !/^\$?[A-Z]+\$?[1-9]\d*(?::\$?[A-Z]+\$?[1-9]\d*)?$/.test(String(item.cell))) return null;
  return Object.fromEntries([['kind', item.kind], ...fields[item.kind].flatMap((key) => item[key] === undefined ? [] : [[key, item[key]]])]) as CitationLocator;
}
function invalid<T>(message: string): CitationParseResult<T> { return { ok: false, value: null, diagnostics: [diagnostic({ code: 'invalid_type', path: 'citations', message })] }; }
export function parseCitationEnvelopeStructured(value: unknown): CitationParseResult {
  const root = asRecord(value);
  if (!root || root.protocol !== CITATION_ENVELOPE_PROTOCOL || root.version !== CITATION_ENVELOPE_VERSION) return invalid('Unsupported citation format; only pi-citation 3.0 is supported. Existing files have not been modified.');
  if (!Array.isArray(root.sources) || !Array.isArray(root.evidence)) return invalid('sources and evidence must be arrays.');
  const sources: CitationSourceVersion[] = [], evidence: CitationEvidence[] = [], ids = new Set<string>(), evidenceIds = new Set<string>();
  for (const raw of root.sources) {
    const item = asRecord(raw), content = asRecord(item?.content);
    if (!item || !content || !exactKeys(item, ['sourceVersionId', 'sourceKey', 'title', 'content', 'acquiredAt', 'metadata', 'executionRef']) || !exactKeys(content, content.kind === 'file' ? ['kind', 'scope', 'assetId', 'path', 'mimeType', 'sha256', 'size'] : ['kind', 'sha256', 'value']) || typeof item.sourceVersionId !== 'string' || !ID.test(item.sourceVersionId) || ids.has(item.sourceVersionId) || !asString(item.sourceKey, 1500) || !asString(item.title, 500) || !asString(item.acquiredAt, 80) || typeof content.sha256 !== 'string' || !SHA.test(content.sha256)) return invalid('Invalid or duplicate SourceVersion.');
    if (content.kind === 'file') {
      if (!citationRelativePath(content.path) || !asString(content.mimeType, 180) || !Number.isSafeInteger(content.size) || Number(content.size) < 0 || !['session', 'asset'].includes(String(content.scope)) || (content.scope === 'asset' ? typeof content.assetId !== 'string' || !ID.test(content.assetId) : content.assetId !== undefined)) return invalid('Invalid controlled file reference.');
    } else if (content.kind !== 'inline' || (content.value !== undefined && !isCitationInline(content.value))) return invalid('Invalid or oversized inline result.');
    if (item.metadata !== undefined) {
      const meta = asRecord(item.metadata);
      if (!meta || Object.entries(meta).some(([key, val]) => key === 'author' ? !strings(val) : !['issuer', 'issuedAt', 'standardNumber', 'edition', 'url', 'version', 'timeRange', 'querySummary', 'bibliographicType'].includes(key) || !asString(val, 4000))) return invalid('Invalid source metadata.');
      if (meta.bibliographicType !== undefined && !['S', 'R', 'M', 'J', 'EB/OL', 'DS', 'Z'].includes(String(meta.bibliographicType))) return invalid('Invalid bibliography type.');
      if (meta.url !== undefined && !/^https?:\/\//i.test(String(meta.url))) return invalid('Source URL must be an HTTP(S) URL, not a local path.');
    }
    if (item.executionRef !== undefined) {
      const ref = asRecord(item.executionRef);
      if (!ref || !citationRelativePath(ref.path) || typeof ref.sha256 !== 'string' || !SHA.test(ref.sha256) || !asString(ref.operation, 180) || !strings(ref.inputHashes) || ref.inputHashes.some((hash) => !SHA.test(hash))) return invalid('Invalid execution reference.');
    }
    ids.add(item.sourceVersionId); sources.push(item as CitationSourceVersion);
  }
  for (const raw of root.evidence) {
    const item = asRecord(raw), locator = parseCitationLocator(item?.locator);
    if (!item || !exactKeys(item, ['evidenceId', 'sourceVersionId', 'locator', 'contentKind', 'text']) || typeof item.evidenceId !== 'string' || !ID.test(item.evidenceId) || evidenceIds.has(item.evidenceId) || typeof item.sourceVersionId !== 'string' || !ids.has(item.sourceVersionId) || !locator || !['excerpt', 'summary', 'result', 'source-only'].includes(String(item.contentKind)) || (item.text !== undefined && !asString(item.text, 16000))) return invalid('Invalid, duplicate or dangling Evidence.');
    evidenceIds.add(item.evidenceId); evidence.push({ evidenceId: item.evidenceId, sourceVersionId: item.sourceVersionId, locator, contentKind: item.contentKind as CitationEvidence['contentKind'], ...(item.text !== undefined ? { text: String(item.text) } : {}) });
  }
  if (root.nextOffset !== undefined && (!Number.isSafeInteger(root.nextOffset) || Number(root.nextOffset) < 0)) return invalid('Invalid pagination offset.');
  return { ok: true, value: { protocol: CITATION_ENVELOPE_PROTOCOL, version: CITATION_ENVELOPE_VERSION, sources, evidence, ...(root.nextOffset !== undefined ? { nextOffset: Number(root.nextOffset) } : {}) }, diagnostics: [] };
}
export function parseCitationEnvelope(value: unknown) { const result = parseCitationEnvelopeStructured(value); return result.ok ? result.value : null; }
export function parseCitationRegistryStructured(value: unknown): CitationParseResult<CitationRegistry> {
  const root = asRecord(value), parsed = parseCitationEnvelopeStructured(value);
  if (!parsed.ok) return parsed;
  if (!root || root.schemaVersion !== 2 || typeof root.sessionId !== 'string' || !ID.test(root.sessionId) || parsed.value.sources.some((source) => source.content.kind === 'inline' && source.content.value === undefined)) return invalid('Unsupported or incomplete Citation registry. Existing files have not been modified.');
  return { ok: true, value: { ...parsed.value, schemaVersion: 2, sessionId: root.sessionId }, diagnostics: [] };
}
export function parseCitationRegistry(value: unknown) { const result = parseCitationRegistryStructured(value); return result.ok ? result.value : null; }
export function publicCitationSource(source: CitationSourceVersion): CitationSourceVersion {
  return source.content.kind === 'inline' ? { ...source, content: { kind: 'inline', sha256: source.content.sha256 } } : source;
}
export function parseCitationDetail(value: unknown): CitationDetail | null {
  const root = asRecord(value);
  if (!root) return null;
  const envelope = parseCitationEnvelope({ protocol: 'pi-citation', version: '3.0', sources: [root.source], evidence: [root.evidence] });
  const preview = asRecord(root.preview);
  if (!envelope || !preview) return null;
  if (preview.kind === 'none' && typeof preview.reason === 'string') return { source: envelope.sources[0], evidence: envelope.evidence[0], preview: { kind: 'none', reason: preview.reason } };
  if (typeof preview.truncated !== 'boolean') return null;
  if (preview.kind === 'text' && typeof preview.text === 'string' && new TextEncoder().encode(preview.text).length <= CITATION_PREVIEW_LIMIT) return { source: envelope.sources[0], evidence: envelope.evidence[0], preview: { kind: 'text', text: preview.text, truncated: preview.truncated } };
  const table = asRecord(preview.table);
  if (preview.kind === 'table' && table && strings(table.columns) && Array.isArray(table.rows) && table.rows.length <= CITATION_PREVIEW_ROWS && table.rows.every((row) => Array.isArray(row) && row.length === (table.columns as string[]).length && row.every((cell) => cell === null || ['string', 'number', 'boolean'].includes(typeof cell))) && new TextEncoder().encode(JSON.stringify(table)).length <= CITATION_PREVIEW_LIMIT) return { source: envelope.sources[0], evidence: envelope.evidence[0], preview: { kind: 'table', table: table as CitationTable, ...(Number.isSafeInteger(preview.rowStart) && Number(preview.rowStart) > 0 ? { rowStart: Number(preview.rowStart) } : {}), truncated: preview.truncated } };
  return null;
}
