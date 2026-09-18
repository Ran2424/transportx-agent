import type { CitationLocator } from '../../../contracts/citation.ts';
import i18n from '../../i18n';

export function citationLocatorPosition(locator: CitationLocator) {
  if (locator.page) return i18n.language === 'en-US' ? `PDF page ${locator.page}${locator.printedPage ? ` (printed page ${locator.printedPage})` : ''}` : `PDF 第${locator.page}页${locator.printedPage ? `（正文第${locator.printedPage}页）` : ''}`;
  return locator.section || locator.sourceUnit || locator.nodeId || i18n.t('conversation.sourceLocation');
}

export function citationResourceUrl(sessionId: string, resourceId: string, view: 'content' | 'preview' = 'content') {
  return `/api/live-sessions/${encodeURIComponent(sessionId)}/citation-resources/${encodeURIComponent(resourceId)}/${view}`;
}
