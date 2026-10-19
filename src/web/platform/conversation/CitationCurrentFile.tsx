import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { citationRelativePath, type CitationSourceVersion } from '../../../contracts/citation';
import { useOpenDocument } from '../canvas/document-context';
import { documentFormat } from '../canvas/document-state';
import { sessionFileUrl } from '../workspace/file-urls';

export function CitationCurrentFile({ sessionId, source, onOpened }: { sessionId: string; source: CitationSourceVersion; onOpened?(): void }) {
  const { t } = useTranslation();
  const openDocument = useOpenDocument();
  const file = source.content.kind === 'file' && source.content.scope === 'session' && citationRelativePath(source.content.path) && documentFormat(source.content.path, source.content.mimeType) ? source.content : null;
  const url = file ? sessionFileUrl(sessionId, file.path) : null;
  const [availableUrl, setAvailableUrl] = useState<string | null>(null);
  useEffect(() => {
    setAvailableUrl(null);
    if (!url) return;
    const controller = new AbortController();
    void fetch(url, { method: 'HEAD', cache: 'no-store', signal: controller.signal }).then((response) => {
      if (!controller.signal.aborted && response.ok) setAvailableUrl(url);
    }).catch(() => {});
    return () => controller.abort();
  }, [url]);
  if (!file || !url || availableUrl !== url) return null;
  return <button type="button" onClick={() => {
    openDocument({ sessionId, title: source.title, path: file.path });
    onOpened?.();
  }}>{t('citation.openCurrent')}</button>;
}
