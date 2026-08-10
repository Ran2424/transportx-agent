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
