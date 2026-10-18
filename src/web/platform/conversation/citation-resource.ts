export { citationLocatorText as citationLocatorPosition } from '../../../contracts/citation-compiler.ts';
export function citationResourceUrl(sessionId: string, sourceVersionId: string, view: 'content' | 'preview' = 'content') {
  return `/api/live-sessions/${encodeURIComponent(sessionId)}/citation-resources/${encodeURIComponent(sourceVersionId)}/${view}`;
}
