import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConversationView } from '../../../public/app-types.js';
import type { WorkspaceFile } from '../../../public/kernel/session-commands.js';
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
export function WorkspaceDock({ open, session, onClose }: { open: boolean; session: ConversationView | null; onClose(): void }) {
  return <WorkspaceFiles key={session?.id ?? ''} open={open} session={session} onClose={onClose} />;
}

function WorkspaceFiles({ open, session, onClose }: { open: boolean; session: ConversationView | null; onClose(): void }) {
  const { t } = useTranslation();
  const kernel = appKernel;
  const openDocument = useOpenDocument();
  const sessions = useSessionState();
  const attachmentRevision = sessions.attachmentRevisionBySession[session?.id || ''] || 0;
  const sessionId = session?.id;
  const [directory, setDirectory] = useState<{ path?: string }>({});
  const [result, setResult] = useState<{ directory: typeof directory; revision: number; path: string; items: WorkspaceFile[]; error?: string }>();
  const [operationError, setOperationError] = useState('');
  const active = useRef(false);
  const request = useRef<AbortController | null>(null);
  const [copiedPath, setCopiedPath] = useState('');
  const [previewFiles, setPreviewFiles] = useState<WorkspaceFile[]>([]);
  const path = result?.directory === directory ? result.path : directory.path ?? '';
  const items = result?.directory === directory ? result.items : [];
  const error = result?.directory === directory ? result.error : undefined;
  const loading = !!sessionId && open && (result?.directory !== directory || result.revision !== attachmentRevision);
  const load = (path?: string) => {
    request.current?.abort();
    setOperationError('');
    setDirectory({ path });
  };
  useEffect(() => { active.current = open; return () => { active.current = false; }; }, [open]);
  useEffect(() => {
    if (!open || !sessionId) return;
    const controller = new AbortController();
    request.current = controller;
    void kernel.commands.session.listFiles(sessionId, directory.path, controller.signal).then((value) => {
      if (!controller.signal.aborted) setResult({ directory, revision: attachmentRevision, ...value });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setResult({ directory, revision: attachmentRevision, path: directory.path ?? '', items: [], error: (cause as Error).message || t('workspace.loadFailed') });
    });
    return () => controller.abort();
  }, [open, sessionId, attachmentRevision, directory, kernel, t]);

  async function openFile(item: WorkspaceFile) {
    if (item.isDirectory) { load(item.path); return; }
    if (session && (documentFormat(item.path) || /\.dxf$/i.test(item.path))) { openDocument({ sessionId: session.id, title: item.name, path: item.path }); return; }
    if (filePresentation(item).preview) { setPreviewFiles((current) => [...current.filter((file) => file.path !== item.path), item]); return; }
    try { await navigator.clipboard?.writeText(item.path); }
    catch (cause) { if (active.current) setOperationError((cause as Error).message || t('workspace.loadFailed')); return; }
    if (!active.current) return;
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
        onClick={() => { if (session && path) void kernel.commands.session.openInSystem(session.id, path).catch((cause: unknown) => { if (active.current) setOperationError((cause as Error).message || t('workspace.loadFailed')); }); }}
      >
        <span>{session ? (path || basename(session.cwd || '')) : t('workspace.noTask')}</span>
        <Icon name="open" />
      </button>
      <button className="icon-button" type="button" aria-label={t('workspace.refresh')} disabled={!session || loading} onClick={() => void load(path || undefined)}><Icon name="refresh" /></button>
    </div>
    <div className="workspace-file-list" role="region" aria-label={t('workspace.taskFiles')} aria-busy={loading}>
      {operationError ? <p role="status" className="workspace-file-status is-error">{operationError}</p> : null}
      {!session ? <WorkspaceEmpty title={t('workspace.noTask')} description={t('workspace.waitingDescription')} /> : loading ? <p role="status" className="workspace-file-status">{t('workspace.loading')}</p> : error ? <div><p role="status" className="workspace-file-status is-error">{error}</p><button type="button" className="secondary-button" onClick={() => load(directory.path)}>{t('common.retry')}</button></div> : !items.length ? <WorkspaceEmpty title={t('workspace.emptyDirectory')} description={t('workspace.emptyDirectoryDescription')} /> : <>{items.map((item) => <FileRow key={item.path} item={item} onOpen={(file) => void openFile(file)} />)}{copiedPath ? <p role="status" className="workspace-file-copied">{t('workspace.copiedPath', { name: basename(copiedPath) })}</p> : null}</>}
    </div>
    <footer className="workspace-dock-footer"><span>{t('workspace.sharedFiles')}</span><span>{session?.workspaceId?.slice(-8) || 'NO SESSION'}</span></footer>
    {session ? previewFiles.map((file, index) => <FilePreview key={file.path} item={file} sessionId={session.id} stackIndex={index} initialOffset={index} onActivate={() => setPreviewFiles((current) => [...current.filter((item) => item.path !== file.path), file])} onClose={() => setPreviewFiles((current) => current.filter((item) => item.path !== file.path))} />) : null}
  </aside>;
}

function WorkspaceEmpty({ title, description }: { title: string; description: string }) {
  return <section className="workspace-empty"><strong>{title}</strong><p>{description}</p></section>;
}
