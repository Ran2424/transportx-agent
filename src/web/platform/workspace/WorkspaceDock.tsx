import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LiveSession } from '../../../public/app-types.js';
import type { WorkspaceFile } from '../../../public/kernel/commands.js';
import { appKernel } from '../../app/composition-root';
import { useSessionState } from '../../app/store-hooks';
import { Icon } from '../../components/icons';
import { basename } from '../../lib/formatting';
import { FilePreview, filePresentation } from './FilePreview';
import { useOpenDocument } from '../canvas/document-context';
import { documentFormat } from '../canvas/document-state';

function parentPath(path: string) {
  const separator = path.includes('\\') ? '\\' : '/';
  const normalized = path.endsWith(separator) ? path.slice(0, -1) : path;
  const index = normalized.lastIndexOf(separator);
  if (index <= 0) return separator === '/' ? '/' : null;
  return normalized.slice(0, index) || separator;
}

function fileSize(bytes?: number | null) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function FileRow({ item, onOpen }: { item: WorkspaceFile; onOpen(item: WorkspaceFile): void }) {
  const presentation = filePresentation(item);
  return <button className={`workspace-file-row is-${presentation.kind}`} type="button" onClick={() => onOpen(item)} title={`${presentation.label}：${item.path}`}>
    <span className="workspace-file-icon" aria-hidden="true"><Icon name={presentation.icon} /></span><strong>{item.name}</strong>{!item.isDirectory && fileSize(item.size) ? <small>{fileSize(item.size)}</small> : null}
  </button>;
}

/** The resource dock intentionally exposes only session files. */
export function WorkspaceDock({ open, session, onClose }: { open: boolean; session: LiveSession | null; onClose(): void }) {
  const { t } = useTranslation();
  const kernel = appKernel;
  const openDocument = useOpenDocument();
  const sessions = useSessionState();
  const attachmentRevision = sessions.attachmentRevisionBySession[session?.id || ''] || 0;
  const [path, setPath] = useState('');
  const [items, setItems] = useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copiedPath, setCopiedPath] = useState('');
  const [previewFiles, setPreviewFiles] = useState<WorkspaceFile[]>([]);
  const load = useCallback(async (nextPath?: string) => {
    if (!session) { setPath(''); setItems([]); return; }
    setLoading(true); setError('');
    try {
      const response = await kernel.commands.session.listFiles(session.id, nextPath);
      setPath(response.path); setItems(response.items);
    } catch (cause) {
      setError((cause as Error).message || t('workspace.loadFailed'));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [kernel, session, t]);

  useEffect(() => { if (open) void load(); }, [load, open]);
  useEffect(() => { if (open && attachmentRevision) void load(path || undefined); }, [attachmentRevision, load, open]);
  useEffect(() => { setPreviewFiles([]); }, [session?.id]);

  async function openFile(item: WorkspaceFile) {
    if (item.isDirectory) { await load(item.path); return; }
    if (session && documentFormat(item.path)) { openDocument({ sessionId: session.id, title: item.name, path: item.path }); return; }
    if (filePresentation(item).preview) { setPreviewFiles((current) => [...current.filter((file) => file.path !== item.path), item]); return; }
    await navigator.clipboard?.writeText(item.path);
    setCopiedPath(item.path);
    window.setTimeout(() => setCopiedPath((current) => current === item.path ? '' : current), 1_500);
  }

  return <aside className={`workspace-dock${open ? ' is-open' : ''}`} aria-label={t('workspace.filePanel')} data-testid="workspace-dock">
    <div className="workspace-dock-header">
      <strong>{t('workspace.files')}</strong>
      <button className="icon-button" type="button" aria-label={t('workspace.closeFiles')} onClick={onClose}><Icon name="close" /></button>
    </div>
    <div className="workspace-file-toolbar">
      <button className="icon-button" type="button" aria-label={t('workspace.parent')} disabled={!path || !parentPath(path)} onClick={() => { const parent = parentPath(path); if (parent) void load(parent); }}><Icon name="chevron" /></button>
      <button
        className="workspace-file-location"
        type="button"
        title={t('workspace.openInSystem', { path })}
        disabled={!session || !path}
        onClick={() => { if (session && path) void kernel.commands.session.openInSystem(session.id, path).catch((cause) => setError((cause as Error).message || t('workspace.loadFailed'))); }}
      >
        <span>{session ? (path || basename(session.cwd || '')) : t('workspace.noTask')}</span>
        <Icon name="open" />
      </button>
      <button className="icon-button" type="button" aria-label={t('workspace.refresh')} disabled={!session || loading} onClick={() => void load(path || undefined)}><Icon name="refresh" /></button>
    </div>
    <div className="workspace-file-list" role="tabpanel" aria-label={t('workspace.taskFiles')}>
      {!session ? <WorkspaceEmpty title={t('workspace.noTask')} description={t('workspace.waitingDescription')} /> : loading ? <p className="workspace-file-status">{t('workspace.loading')}</p> : error ? <p className="workspace-file-status is-error">{error}</p> : !items.length ? <WorkspaceEmpty title={t('workspace.emptyDirectory')} description={t('workspace.emptyDirectoryDescription')} /> : <>{items.map((item) => <FileRow key={item.path} item={item} onOpen={(file) => void openFile(file)} />)}{copiedPath ? <p className="workspace-file-copied">{t('workspace.copiedPath', { name: basename(copiedPath) })}</p> : null}</>}
    </div>
    <footer className="workspace-dock-footer"><span>SESSION SCOPED</span><span>{session?.id.slice(-8) || 'NO SESSION'}</span></footer>
    {session ? previewFiles.map((file, index) => <FilePreview key={file.path} item={file} sessionId={session.id} stackIndex={index} initialOffset={index} onActivate={() => setPreviewFiles((current) => [...current.filter((item) => item.path !== file.path), file])} onClose={() => setPreviewFiles((current) => current.filter((item) => item.path !== file.path))} />) : null}
  </aside>;
}

function WorkspaceEmpty({ title, description }: { title: string; description: string }) {
  return <section className="workspace-empty"><strong>{title}</strong><p>{description}</p></section>;
}
