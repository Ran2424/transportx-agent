import { isCitationResourceErrorCode, type CitationResourceErrorCode } from '../../../contracts/citation.ts';
export { citationLocatorText as citationLocatorPosition } from '../../../contracts/citation-compiler.ts';
export function citationResourceUrl(sessionId: string, sourceVersionId: string, view: 'content' | 'preview' = 'content') {
  return `/api/live-sessions/${encodeURIComponent(sessionId)}/citation-resources/${encodeURIComponent(sourceVersionId)}/${view}`;
}
export function citationResponseError(response: Response): CitationResourceErrorCode {
  const code = response.headers.get('X-Citation-Error');
  return isCitationResourceErrorCode(code) ? code : response.status === 404 ? 'missing' : response.status === 403 ? 'forbidden' : 'read-failed';
}
