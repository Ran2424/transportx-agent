import { Icon } from '../../components/icons';
import type { SessionAttachment } from '../../../public/app-types.js';
import { filePresentation } from '../workspace/FilePreview';

export function attachmentPreviewUrl(sessionId: string, attachment: SessionAttachment) {
  return `/api/file/preview?${new URLSearchParams({ sessionId, path: attachment.relativePath })}`;
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentCards({ sessionId, attachmentIds, attachments, compact = false }: { sessionId: string; attachmentIds?: string[]; attachments: Record<string, SessionAttachment>; compact?: boolean }) {
  const items = (attachmentIds || []).map((id) => attachments[id]).filter((item): item is SessionAttachment => !!item);
  if (!items.length) return null;
  return <div className={`message-attachments${compact ? ' is-compact' : ''}`}>{items.map((attachment) => {
    const presentation = filePresentation({ name: attachment.name, path: attachment.relativePath, isDirectory: false });
    return <div className="message-attachment-card" key={attachment.id}>
      {attachment.kind === 'image' ? <img src={attachmentPreviewUrl(sessionId, attachment)} alt={attachment.name} /> : <span className="message-attachment-icon"><Icon name={presentation.icon} /></span>}
      <span><strong title={attachment.name}>{attachment.name}</strong><small>{presentation.label} · {formatBytes(attachment.size)}</small></span>
    </div>;
  })}</div>;
}
