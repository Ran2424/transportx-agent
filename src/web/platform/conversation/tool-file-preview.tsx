import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/icons';
import { FilePreview, filePresentation } from '../workspace/FilePreview';
import { toolFileName } from './tool-card-utils';

export function ToolFilePreview({ sessionId, path }: { sessionId: string; path: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const item = { name: toolFileName(path), path, isDirectory: false };
  const presentation = filePresentation(item);
  const previewUrl = `/api/file/preview?${new URLSearchParams({ sessionId, path })}`;
  return <div className={`tool-read-preview is-${presentation.kind}`}>
    {presentation.preview === 'image' ? <button className="tool-read-image-button" type="button" onClick={() => setOpen(true)} title={t('conversation.tool.preview', { name: item.name })}><img src={previewUrl} alt={t('conversation.tool.imageAlt', { name: item.name })} /></button> : null}
    {presentation.preview && presentation.preview !== 'image' ? <button className="tool-read-open" type="button" onClick={() => setOpen(true)}><Icon name={presentation.icon} /><span>{t('conversation.tool.previewRead', { type: presentation.label, name: item.name })}</span></button> : presentation.preview ? null : <span className="tool-read-unavailable"><Icon name={presentation.icon} />{t('conversation.tool.previewUnsupported', { name: item.name })}</span>}
    {open ? <FilePreview item={item} sessionId={sessionId} stackIndex={0} initialOffset={0} onActivate={() => {}} onClose={() => setOpen(false)} /> : null}
  </div>;
}
