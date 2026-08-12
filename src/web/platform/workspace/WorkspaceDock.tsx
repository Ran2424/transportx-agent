import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { LiveSession } from '../../../public/app-types.js';
import type { WorkspaceFile } from '../../../public/kernel/commands.js';
import { useAppServices } from '../../app/AppProviders';
import { useConversationState } from '../../app/store-hooks';
import { Icon } from '../../components/icons';
import { projectMessageCitations, type MessageCitationProjection } from '../../features/citation/citation-projection';
import { GeoWorkspace } from '../../features/geo/GeoWorkspace';
import { TaskBoard } from '../../features/task/TaskBoard';
import { basename } from '../../lib/formatting';
import { FilePreview, filePresentation } from './FilePreview';

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
  const { kernel } = useAppServices();
  const conversation = useConversationState();
  const [path, setPath] = useState('');
  const [items, setItems] = useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copiedPath, setCopiedPath] = useState('');
  const [previewFiles, setPreviewFiles] = useState<WorkspaceFile[]>([]);
  const artifactProjections = useMemo(() => {
    const result = new Map<string, MessageCitationProjection>();
    if (!session) return result;
    const entries = conversation.bySession[session.id]?.snapshotEntries || [];
    for (const projection of projectMessageCitations(entries).byEntry.values()) {
      for (const artifact of projection.artifacts) result.set(artifact.resource.relativePath.replaceAll('\\', '/'), projection);
    }
    return result;
  }, [conversation.bySession, session]);

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
  useEffect(() => {
    const refresh = () => { if (open) void load(path || undefined); };
    window.addEventListener('transportx-attachments-changed', refresh);
    return () => window.removeEventListener('transportx-attachments-changed', refresh);
  }, [load, open, path]);
  useEffect(() => { setPreviewFiles([]); }, [session?.id]);

  async function openFile(item: WorkspaceFile) {
    if (item.isDirectory) { await load(item.path); return; }
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
      <span title={path}>{session ? (path || basename(session.cwd || '')) : t('workspace.noTask')}</span>
      <button className="icon-button" type="button" aria-label={t('workspace.refresh')} disabled={!session || loading} onClick={() => void load(path || undefined)}><Icon name="refresh" /></button>
    </div>
    <div className="workspace-file-list" role="tabpanel" aria-label={t('workspace.taskFiles')}>
      {!session ? <WorkspaceEmpty mark="01" title={t('task.waitingContext')} description={t('workspace.waitingDescription')} /> : loading ? <p className="workspace-file-status">{t('workspace.loading')}</p> : error ? <p className="workspace-file-status is-error">{error}</p> : !items.length ? <WorkspaceEmpty mark="01" title={t('workspace.emptyDirectory')} description={t('workspace.emptyDirectoryDescription')} /> : <>{items.map((item) => <FileRow key={item.path} item={item} onOpen={(file) => void openFile(file)} />)}{copiedPath ? <p className="workspace-file-copied">{t('workspace.copiedPath', { name: basename(copiedPath) })}</p> : null}</>}
    </div>
    <footer className="workspace-dock-footer"><span>SESSION SCOPED</span><span>{session?.id.slice(-8) || 'NO SESSION'}</span></footer>
    {session ? previewFiles.map((file, index) => {
      const normalizedPath = file.path.replaceAll('\\', '/');
      const citationProjection = [...artifactProjections].find(([relativePath]) => normalizedPath === relativePath || normalizedPath.endsWith(`/${relativePath}`))?.[1];
      return <FilePreview key={file.path} item={file} sessionId={session.id} stackIndex={index} initialOffset={index} citationProjection={citationProjection} onActivate={() => setPreviewFiles((current) => [...current.filter((item) => item.path !== file.path), file])} onClose={() => setPreviewFiles((current) => current.filter((item) => item.path !== file.path))} />;
    }) : null}
  </aside>;
}

export function WorkspaceFloat({ kind, open, session, fileOpen = false, onClose }: { kind: 'tasks' | 'map'; open: boolean; session: LiveSession | null; fileOpen?: boolean; onClose(): void }) {
  const { t } = useTranslation();
  const map = kind === 'map';
  const panelRef = useRef<HTMLElement>(null);
  const dragOffset = useRef({ x: 0, y: 0 });
  const dragState = useRef<null | { pointerId: number; startX: number; startY: number; originX: number; originY: number; minX: number; maxX: number; minY: number; maxY: number }>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (map) return;
    dragOffset.current = { x: 0, y: 0 };
    panelRef.current?.style.setProperty('--workspace-drag-x', '0px');
    panelRef.current?.style.setProperty('--workspace-drag-y', '0px');
  }, [map, session?.id]);

  function startDrag(event: ReactPointerEvent<HTMLElement>) {
    if (map || event.button !== 0 || window.matchMedia('(max-width: 760px)').matches || (event.target as HTMLElement).closest('button')) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const bounds = panel.offsetParent?.getBoundingClientRect() || { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const origin = dragOffset.current;
    const inset = 8;
    dragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: origin.x,
      originY: origin.y,
      minX: origin.x + bounds.left + inset - rect.left,
      maxX: origin.x + bounds.right - inset - rect.right,
      minY: origin.y + bounds.top + inset - rect.top,
      maxY: origin.y + bounds.bottom - inset - rect.bottom,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function moveDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragState.current;
    const panel = panelRef.current;
    if (!drag || !panel || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const x = Math.min(drag.maxX, Math.max(drag.minX, drag.originX + event.clientX - drag.startX));
    const y = Math.min(drag.maxY, Math.max(drag.minY, drag.originY + event.clientY - drag.startY));
    dragOffset.current = { x, y };
    panel.style.setProperty('--workspace-drag-x', `${x}px`);
    panel.style.setProperty('--workspace-drag-y', `${y}px`);
  }

  function endDrag(event: ReactPointerEvent<HTMLElement>) {
    if (dragState.current?.pointerId !== event.pointerId) return;
    dragState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  }

  return <aside ref={panelRef} className={`workspace-float workspace-float--${kind}${open ? ' is-open' : ''}${!map && fileOpen ? ' is-file-offset' : ''}${dragging ? ' is-dragging' : ''}`} aria-label={map ? t('workspace.mapView') : t('workspace.taskPanel')} data-testid={`workspace-float-${kind}`}>
    <header className="workspace-float-header" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}><strong>{map ? t('workspace.map') : t('workspace.task')}</strong><button className="icon-button" type="button" aria-label={map ? t('workspace.closeMap') : t('workspace.closeTasks')} onClick={onClose}><Icon name="close" /></button></header>
    <div className="workspace-float-body">{map ? <GeoWorkspace session={session} active={open} /> : <TaskBoard session={session} />}</div>
  </aside>;
}

function WorkspaceEmpty({ mark, title, description }: { mark: string; title: string; description: string }) {
  return <section className="workspace-empty"><span>{mark}</span><strong>{title}</strong><p>{description}</p></section>;
}
