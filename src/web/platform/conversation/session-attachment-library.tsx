import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionAttachment } from '../../../public/app-types.js';
import { Icon } from '../../components/icons';
import { useOpenDocument } from '../canvas/document-context';
import { documentFormat } from '../canvas/document-state';
import { FilePreview, filePresentation } from '../workspace/FilePreview';
import { formatBytes } from './conversation-attachments';

export function SessionAttachmentLibrary({ sessionId, attachments, selectedIds, error, onReload, onReuse }: { sessionId: string; attachments: Record<string, SessionAttachment>; selectedIds: string[]; error?: string; onReload(): void; onReuse(attachment: SessionAttachment): void }) {
  const { t } = useTranslation();
  const openDocument = useOpenDocument();
  const [preview, setPreview] = useState<SessionAttachment | null>(null);
  const items = Object.values(attachments).filter((item) => item.status === 'ready');
  function view(attachment: SessionAttachment) {
    if (documentFormat(attachment.relativePath, attachment.mimeType)) openDocument({ sessionId, title: attachment.name, path: attachment.relativePath });
    else setPreview(attachment);
  }
  return <>
    <details className="session-attachment-library">
      <summary>{t('conversation.uploadedFiles', { count: items.length })}</summary>
      <p>{t('conversation.uploadedFilesHelp')}</p>
      {error ? <p role="alert">{error}<button type="button" onClick={onReload}>{t('conversation.reloadAttachments')}</button></p> : null}
      <div className="session-attachment-library-list">{items.length ? items.map((attachment) => <article key={attachment.id}>
        <button className="session-attachment-preview" type="button" aria-label={t('conversation.previewAttachment', { name: attachment.name })} onClick={() => view(attachment)}><Icon name={filePresentation({ name: attachment.name, path: attachment.relativePath, isDirectory: false }).icon} /><strong title={attachment.name}>{attachment.name}</strong></button>
        <small>{formatBytes(attachment.size)} · {t('conversation.attachmentReadable')}</small>
        <code>{attachment.relativePath}</code>
        <button className="session-attachment-reuse" type="button" disabled={selectedIds.includes(attachment.id)} aria-label={t('conversation.reuseAttachment', { name: attachment.name })} onClick={() => onReuse(attachment)}>{t(selectedIds.includes(attachment.id) ? 'conversation.attachmentSelected' : 'conversation.useAttachment')}</button>
      </article>) : <p>{t('conversation.noUploadedFiles')}</p>}</div>
    </details>
    {preview ? <FilePreview item={{ name: preview.name, path: preview.relativePath, isDirectory: false }} sessionId={sessionId} stackIndex={0} initialOffset={0} onActivate={() => {}} onClose={() => setPreview(null)} /> : null}
  </>;
}
