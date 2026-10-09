import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionAttachment, SessionAttachmentSource } from '../../../public/app-types.js';
import { appKernel } from '../../app/composition-root';
import { Icon } from '../../components/icons';
import { filePresentation } from '../workspace/FilePreview';
import { attachmentPreviewUrl, formatBytes } from './conversation-attachments';

export type PendingAttachment = { localId: string; file: File; attachment?: SessionAttachment; status: 'uploading' | 'ready' | 'error'; error?: string };

function clipboardFileName(index: number) {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `clipboard-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${index + 1}.png`;
}

export function useComposerAttachments(sessionId: string, setError: (message: string) => void) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  async function addAttachments(files: FileList | File[], source: SessionAttachmentSource) {
    const unique = Array.from(files).filter((file, index, all) => all.findIndex((candidate) => `${candidate.name}:${candidate.size}:${candidate.lastModified}:${candidate.type}` === `${file.name}:${file.size}:${file.lastModified}:${file.type}`) === index);
    for (const [index, original] of unique.entries()) {
      const file = source === 'clipboard' && (!original.name || original.name === 'image.png' || original.name === 'blob')
        ? new File([original], clipboardFileName(index), { type: original.type || 'image/png' })
        : original;
      const localId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      setPending((current) => [...current, { localId, file, status: 'uploading' }]);
      try {
        const attachment = await appKernel.commands.session.uploadAttachment({ sessionId, file, source });
        setPending((current) => current.map((item) => item.localId === localId ? { ...item, attachment, status: 'ready' } : item));
      } catch (cause) {
        setPending((current) => current.map((item) => item.localId === localId ? { ...item, status: 'error', error: (cause as Error).message || t('conversation.uploadFailed') } : item));
      }
    }
    if (unique.length) setError('');
  }
  async function removeAttachment(item: PendingAttachment) {
    setPending((current) => current.filter((candidate) => candidate.localId !== item.localId));
    if (item.attachment) {
      try { await appKernel.commands.session.deleteAttachment(sessionId, item.attachment.id); } catch { /* the input item is removed even when cleanup is unavailable */ }
    }
  }
  return { pending, setPending, addAttachments, removeAttachment };
}

export function ComposerAttachmentList({ sessionId, pending, onRemove }: { sessionId: string; pending: PendingAttachment[]; onRemove(item: PendingAttachment): void }) {
  const { t } = useTranslation();
  if (!pending.length) return null;
  return <div className="attachment-list attachment-list--cards">{pending.map((item) => { const attachment = item.attachment; const presentation = attachment ? filePresentation({ name: attachment.name, path: attachment.relativePath, isDirectory: false }) : null; const name = attachment?.name || item.file.name;     const detail: string = item.status === 'uploading' ? t('conversation.uploading') : item.status === 'error' ? (item.error || t('conversation.uploadFailed')) : attachment ? `${presentation?.label} · ${formatBytes(attachment.size)}` : t('conversation.ready'); return <div className={`pending-attachment is-${item.status}`} key={item.localId}>{attachment?.kind === 'image' ? <img src={attachmentPreviewUrl(sessionId, attachment)} alt={attachment.name} /> : <span className="pending-attachment-icon"><Icon name={presentation?.icon || 'file'} /></span>}<span className="pending-attachment-copy"><strong title={name}>{name}</strong>{item.status === 'error' ? <div className="pending-attachment-error">{detail.split('\n').map((line, idx) => <span key={idx} className="pending-attachment-error-line">{line}</span>)}</div> : <small>{detail}</small>}</span><button type="button" aria-label={t('conversation.removeAttachment', { name })} onClick={() => onRemove(item)}>×</button></div>; })}</div>;
}
