import fs from 'node:fs';
import path from 'node:path';
import { asRecord } from '../contracts/common.js';
import type { SessionEntry } from '../contracts/session.js';
import { relativePosixPath } from './util/path.js';

/** Read-only projection. Old live IDs and authentication parameters never establish ownership. */
export function historicalResourceLinks(entries: SessionEntry[], conversationId: string, directory: string, resolveFile: (value: string) => string) {
  const links: Record<string, string> = {};
  for (const entry of entries) {
    const content = entry.message?.content;
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.flatMap((value) => { const part = asRecord(value); return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []; }) : [];
    for (const text of texts) for (const [value] of text.matchAll(/https?:\/\/[^\s<>"')\]]+|\/api\/file\/(?:raw|preview)\?[^\s<>"')\]]+/g)) {
      if (Object.hasOwn(links, value)) continue;
      try {
        const url = new URL(value, 'http://localhost');
        if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['/api/file/raw', '/api/file/preview'].includes(url.pathname)) continue;
        const requested = url.searchParams.get('path');
        if (!requested || url.searchParams.getAll('path').length !== 1 || !path.isAbsolute(requested)) continue;
        const file = resolveFile(requested);
        if (!fs.statSync(file).isFile()) continue;
        const params = new URLSearchParams({ path: relativePosixPath(directory, file) });
        if (url.pathname === '/api/file/raw' && url.searchParams.get('download') === '1') params.set('download', '1');
        links[value] = `/api/conversations/${encodeURIComponent(conversationId)}/files/${url.pathname.endsWith('/preview') ? 'preview' : 'raw'}?${params}`;
      } catch { /* An unprovable historical address remains unavailable. */ }
    }
  }
  return links;
}
