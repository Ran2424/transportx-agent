export type SessionAttachmentKind =
  | 'image'
  | 'pdf'
  | 'document'
  | 'table'
  | 'archive'
  | 'other';

export type SessionAttachmentSource = 'picker' | 'drop' | 'clipboard';
export type SessionAttachmentStatus = 'uploading' | 'ready' | 'error';

export type SessionAttachment = {
  id: string;
  name: string;
  relativePath: string;
  mimeType: string;
  size: number;
  sha256: string;
  kind: SessionAttachmentKind;
  source: SessionAttachmentSource;
  status: SessionAttachmentStatus;
  createdAt?: string;
  error?: string;
};

export const ATTACHMENT_CONTEXT_BEGIN = '<!-- transportx-attachment-context -->';
export const ATTACHMENT_CONTEXT_END = '<!-- /transportx-attachment-context -->';

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildAttachmentContext(attachments: SessionAttachment[]) {
  if (!attachments.length) return '';
  const lines = [
    '本轮用户消息包含以下会话附件。文件均位于当前任务工作目录内：',
    ...attachments.map((attachment, index) => `${index + 1}. ${attachment.name}\n   相对路径：${attachment.relativePath}\n   类型：${attachment.mimeType}\n   大小：${formatBytes(attachment.size)}`),
    '请根据用户请求读取所需附件。不要假定尚未读取的文件内容。',
  ];
  return `\n\n${ATTACHMENT_CONTEXT_BEGIN}\n${lines.join('\n')}\n${ATTACHMENT_CONTEXT_END}`;
}

export function stripAttachmentContext(text: string) {
  if (!text.endsWith(ATTACHMENT_CONTEXT_END)) return text.trimEnd();
  const start = text.lastIndexOf(`\n\n${ATTACHMENT_CONTEXT_BEGIN}`);
  return start === -1 ? text.trimEnd() : text.slice(0, start).trimEnd();
}
