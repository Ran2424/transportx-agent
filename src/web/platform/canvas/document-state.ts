import type { CitationEnvelope, CitationLocator, CitationResource } from '../../../contracts/citation.ts';
import type { CanvasPresentationV1, CanvasResourceRef } from '../../../contracts/canvas.ts';
import type { DocumentCanvasTarget } from '../../../contracts/canvas-document.ts';

export type DocumentRequest = { sessionId: string; title: string; path: string; resource?: CitationResource; locator?: CitationLocator };
export type DocumentFormat = 'markdown' | 'pdf' | 'csv' | 'docx' | 'xlsx' | 'pptx';
export type DocumentView = DocumentRequest & {
  id: string;
  kind: 'document';
  format: DocumentFormat;
  navigationId: number;
  revision?: number;
  canvasResources?: CanvasResourceRef[];
  canvasTarget?: DocumentCanvasTarget;
  canvas?: CanvasPresentationV1;
};
export type DocumentPosition = { scrollTop: number; navigationId: number };

const OFFICE_MIME_TYPES: Record<string, Extract<DocumentFormat, 'docx' | 'xlsx' | 'pptx'>> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

export function documentFormat(path: string, mimeType?: string): DocumentFormat | null {
  const mime = mimeType?.split(';')[0].trim().toLowerCase();
  if (mime === 'application/pdf' || /\.pdf$/i.test(path)) return 'pdf';
  if (mime === 'text/markdown' || /\.mdx?$/i.test(path)) return 'markdown';
  if (mime === 'text/csv' || /\.csv$/i.test(path)) return 'csv';
  const extension = path.match(/\.(docx|xlsx|pptx)$/i)?.[1].toLowerCase() as 'docx' | 'xlsx' | 'pptx' | undefined;
  if (extension) return extension;
  if (mime && OFFICE_MIME_TYPES[mime]) return OFFICE_MIME_TYPES[mime];
  return null;
}

export function isOfficeFormat(format: DocumentFormat): format is 'docx' | 'xlsx' | 'pptx' {
  return format === 'docx' || format === 'xlsx' || format === 'pptx';
}

// Identity only; authorization and realpath checks remain on the server.
export function documentPath(path: string, cwd: string): string {
  const value = path.replaceAll('\\', '/');
  const absolute = /^(?:\/|[a-z]:\/)/i.test(value) ? value : `${cwd.replaceAll('\\', '/')}/${value}`;
  const prefix = absolute.startsWith('//') ? '//' : absolute.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (parts.length && !/^[a-z]:$/i.test(parts.at(-1)!)) parts.pop(); }
    else parts.push(part);
  }
  return prefix + parts.join('/');
}

export function resolveDocument(request: DocumentRequest, cwd: string, registry?: CitationEnvelope | null, canonicalCwd = cwd): DocumentView | null {
  const requestedPath = documentPath(request.path, cwd);
  const root = documentPath(cwd, '');
  const path = documentPath(requestedPath.startsWith(`${root}/`) ? requestedPath.slice(root.length + 1) : requestedPath, canonicalCwd);
  const matches = registry?.resources.filter((resource) => resource.scope !== 'knowledge' && documentPath(resource.relativePath, canonicalCwd) === path) ?? [];
  const resource = request.resource ?? (matches.length === 1 ? matches[0] : undefined);
  const format = documentFormat(resource?.relativePath ?? path, resource?.mimeType);
  if (!format) return null;
  const identity = resource ? ['citation', resource.resourceId, resource.sha256] : ['file', path];
  return { ...request, resource, path: resource?.relativePath ?? path, id: `document:${encodeURIComponent(JSON.stringify([request.sessionId, ...identity]))}`, kind: 'document', format, navigationId: 0 };
}

export type DocumentHeading = { id: string; text: string; level: number };

export function documentHeadings(headings: Array<{ text: string; level: number }>): DocumentHeading[] {
  const used = new Set<string>();
  return headings.map((heading) => {
    const base = heading.text.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-|-$/g, '') || 'section';
    let id = base;
    for (let suffix = 2; used.has(id); suffix++) id = `${base}-${suffix}`;
    used.add(id);
    return { ...heading, id };
  });
}

export function documentTarget(headings: DocumentHeading[], locator: CitationLocator): string | null {
  const nodeId = locator.nodeId?.replace(/^#/, '');
  if (nodeId && headings.some((heading) => heading.id === nodeId)) return nodeId;
  const matches = locator.section ? headings.filter((heading) => heading.text.trim() === locator.section?.trim()) : [];
  return matches.length === 1 ? matches[0].id : null;
}
