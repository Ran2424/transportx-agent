import { parseCitationEnvelope, type CitationSourceVersion, type CitationLocator } from './citation.ts';
import { asRecord, asString } from './common.ts';

export const DOCUMENT_CANVAS_ADAPTER_ID = 'com.transportx.canvas.document';
export const GEO_CANVAS_ADAPTER_ID = 'com.transportx.canvas.geo';
export const VIDEO_CANVAS_ADAPTER_ID = 'com.transportx.canvas.video';

export type DocumentCanvasFormat = 'markdown' | 'pdf' | 'csv' | 'docx' | 'xlsx' | 'pptx';

export type DocumentCanvasPayloadV1 = {
  format: DocumentCanvasFormat;
  path?: string;
  mimeType?: string;
  source?: CitationSourceVersion;
};

export type DocumentCanvasTarget =
  | { kind: 'rows'; start: number; end?: number; columns?: string[] }
  | { kind: 'page'; number: number }
  | { kind: 'slide'; number: number }
  | { kind: 'sheet'; name: string }
  | { kind: 'sheet-cell'; sheet: string; cell: string }
  | { kind: 'search'; query: string }
  | { kind: 'locator'; page?: number; section?: string; nodeId?: string; quote?: string };

const DOCUMENT_MIME_FORMATS: Record<string, DocumentCanvasFormat> = {
  'text/markdown': 'markdown',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

export function documentCanvasFormat(path: string, mimeType?: string): DocumentCanvasFormat | null {
  const mime = mimeType?.split(';')[0].trim().toLowerCase();
  if (mime && DOCUMENT_MIME_FORMATS[mime]) return DOCUMENT_MIME_FORMATS[mime];
  const extension = path.match(/\.(mdx?|pdf|csv|docx|xlsx|pptx)$/i)?.[1].toLowerCase();
  return extension === 'md' || extension === 'mdx' ? 'markdown' : extension === 'pdf' || extension === 'csv' || extension === 'docx' || extension === 'xlsx' || extension === 'pptx' ? extension : null;
}

function exactKeys(record: Record<string, unknown>, allowed: string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(record).every((key) => keys.has(key));
}

function positiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 1 ? value as number : null;
}

export function parseDocumentCanvasPayload(value: unknown): DocumentCanvasPayloadV1 | null {
  const record = asRecord(value);
  if (!record || !exactKeys(record, ['format', 'path', 'mimeType', 'source'])) return null;
  const format = record.format === 'markdown' || record.format === 'pdf' || record.format === 'csv' || record.format === 'docx' || record.format === 'xlsx' || record.format === 'pptx' ? record.format : null;
  const path = record.path === undefined ? undefined : asString(record.path, 1000) ?? undefined;
  const mimeType = record.mimeType === undefined ? undefined : asString(record.mimeType, 200) ?? undefined;
  if (!format || record.path !== undefined && !path || record.mimeType !== undefined && !mimeType) return null;
  const source = record.source === undefined ? undefined : parseCitationEnvelope({ protocol: 'pi-citation', version: '3.0', sources: [record.source], evidence: [] })?.sources[0];
  if (record.source !== undefined && (!source || source.content.kind !== 'file')) return null;
  return { format, ...(path ? { path } : {}), ...(mimeType ? { mimeType } : {}), ...(source ? { source } : {}) };
}

export function parseDocumentCanvasTarget(value: unknown): DocumentCanvasTarget | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.kind === 'rows') {
    const start = positiveInteger(record.start), end = record.end === undefined ? undefined : positiveInteger(record.end);
    const columns = record.columns;
    if (!start || end === null || end !== undefined && end < start || columns !== undefined && (!Array.isArray(columns) || columns.some((item) => typeof item !== 'string')) || !exactKeys(record, ['kind', 'start', 'end', 'columns'])) return null;
    return { kind: 'rows', start, ...(end !== undefined ? { end } : {}), ...(columns ? { columns: columns as string[] } : {}) };
  }
  if (record.kind === 'page' || record.kind === 'slide') {
    const number = positiveInteger(record.number);
    return number !== null && exactKeys(record, ['kind', 'number']) ? { kind: record.kind, number } : null;
  }
  if (record.kind === 'sheet') {
    const name = asString(record.name, 200);
    return name && exactKeys(record, ['kind', 'name']) ? { kind: 'sheet', name } : null;
  }
  if (record.kind === 'sheet-cell') {
    const sheet = asString(record.sheet, 200);
    const cell = asString(record.cell, 32);
    return sheet && cell && /^[A-Za-z]{1,3}[1-9]\d{0,6}$/.test(cell) && exactKeys(record, ['kind', 'sheet', 'cell'])
      ? { kind: 'sheet-cell', sheet, cell: cell.toUpperCase() }
      : null;
  }
  if (record.kind === 'search') {
    const query = asString(record.query, 500);
    return query && exactKeys(record, ['kind', 'query']) ? { kind: 'search', query } : null;
  }
  if (record.kind === 'locator') {
    if (!exactKeys(record, ['kind', 'page', 'section', 'nodeId', 'quote'])) return null;
    const page = record.page === undefined ? undefined : positiveInteger(record.page) ?? undefined;
    const section = record.section === undefined ? undefined : asString(record.section, 500) ?? undefined;
    const nodeId = record.nodeId === undefined ? undefined : asString(record.nodeId, 500) ?? undefined;
    const quote = record.quote === undefined ? undefined : asString(record.quote, 2000) ?? undefined;
    if (record.page !== undefined && page === undefined || record.section !== undefined && !section || record.nodeId !== undefined && !nodeId || record.quote !== undefined && !quote) return null;
    if (page === undefined && !section && !nodeId && !quote) return null;
    return { kind: 'locator', ...(page !== undefined ? { page } : {}), ...(section ? { section } : {}), ...(nodeId ? { nodeId } : {}), ...(quote ? { quote } : {}) };
  }
  return null;
}

export function citationCanvasTarget(locator: CitationLocator): DocumentCanvasTarget | undefined {
  if (locator.kind === 'document') {
    if (locator.page) return { kind: 'page', number: locator.page };
    if (locator.section || locator.nodeId) return { kind: 'locator', ...(locator.section ? { section: locator.section } : {}), ...(locator.nodeId ? { nodeId: locator.nodeId } : {}) };
  }
  if (locator.kind === 'table') {
    if (locator.sheet && locator.cell) return { kind: 'sheet-cell', sheet: locator.sheet, cell: locator.cell.replace(/\$/g, '').split(':')[0] };
    if (locator.sheet) return { kind: 'sheet', name: locator.sheet };
    if (locator.rowStart) return { kind: 'rows', start: locator.rowStart, ...(locator.rowEnd ? { end: locator.rowEnd } : {}), ...(locator.columns ? { columns: locator.columns } : {}) };
  }
  return undefined;
}
