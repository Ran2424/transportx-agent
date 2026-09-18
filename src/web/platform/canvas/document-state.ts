import type { CitationEnvelope, CitationLocator, CitationResource } from '../../../contracts/citation.ts';

export type DocumentRequest = { sessionId: string; title: string; path: string; resource?: CitationResource; locator?: CitationLocator };
export type DocumentView = DocumentRequest & { id: string; kind: 'document'; format: 'markdown' | 'pdf'; navigationId: number };
export type DocumentPosition = { scrollTop: number; navigationId: number };

export function documentFormat(path: string, mimeType?: string): DocumentView['format'] | null {
  if (mimeType === 'application/pdf' || /\.pdf$/i.test(path)) return 'pdf';
  if (mimeType === 'text/markdown' || /\.mdx?$/i.test(path)) return 'markdown';
  return null;
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
