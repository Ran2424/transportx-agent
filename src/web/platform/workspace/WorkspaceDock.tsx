import { useCallback, useEffect, useState } from 'react';
import type { LiveSession } from '../../../public/app-types.js';
import type { WorkspaceFile } from '../../../public/kernel/commands.js';
import { useAppServices } from '../../app/AppProviders';
import { Icon } from '../../components/icons';
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
  const { kernel } = useAppServices();
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
      setError((cause as Error).message || '文件加载失败');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [kernel, session]);

  useEffect(() => { if (open) void load(); }, [load, open]);
  useEffect(() => { setPreviewFiles([]); }, [session?.id]);

  async function openFile(item: WorkspaceFile) {
    if (item.isDirectory) { await load(item.path); return; }
    if (filePresentation(item).preview) { setPreviewFiles((current) => [...current.filter((file) => file.path !== item.path), item]); return; }
    await navigator.clipboard?.writeText(item.path);
    setCopiedPath(item.path);
    window.setTimeout(() => setCopiedPath((current) => current === item.path ? '' : current), 1_500);
  }

  return <aside className={`workspace-dock${open ? ' is-open' : ''}`} aria-label="文件栏" data-testid="workspace-dock">
    <div className="workspace-dock-header">
      <strong>文件</strong>
      <button className="icon-button" type="button" aria-label="关闭文件栏" onClick={onClose}><Icon name="close" /></button>
    </div>
    <div className="workspace-file-toolbar">
      <button className="icon-button" type="button" aria-label="返回上级目录" disabled={!path || !parentPath(path)} onClick={() => { const parent = parentPath(path); if (parent) void load(parent); }}><Icon name="chevron" /></button>
      <span title={path}>{session ? (path || basename(session.cwd || '')) : '未选择任务'}</span>
      <button className="icon-button" type="button" aria-label="刷新文件" disabled={!session || loading} onClick={() => void load(path || undefined)}><Icon name="refresh" /></button>
    </div>
    <div className="workspace-file-list" role="tabpanel" aria-label="任务文件">
      {!session ? <WorkspaceEmpty mark="01" title="等待任务上下文" description="选择一个运行中的任务后，可以浏览其工作目录。" /> : loading ? <p className="workspace-file-status">正在读取文件…</p> : error ? <p className="workspace-file-status is-error">{error}</p> : !items.length ? <WorkspaceEmpty mark="01" title="目录为空" description="当前工作目录中没有可显示的文件。" /> : <>{items.map((item) => <FileRow key={item.path} item={item} onOpen={(file) => void openFile(file)} />)}{copiedPath ? <p className="workspace-file-copied">已复制路径：{basename(copiedPath)}</p> : null}</>}
    </div>
    <footer className="workspace-dock-footer"><span>SESSION SCOPED</span><span>{session?.id.slice(-8) || 'NO SESSION'}</span></footer>
    {session ? previewFiles.map((file, index) => <FilePreview key={file.path} item={file} sessionId={session.id} stackIndex={index} initialOffset={index} onActivate={() => setPreviewFiles((current) => [...current.filter((item) => item.path !== file.path), file])} onClose={() => setPreviewFiles((current) => current.filter((item) => item.path !== file.path))} />) : null}
  </aside>;
}

export function WorkspaceFloat({ kind, open, session, fileOpen = false, onClose }: { kind: 'tasks' | 'map'; open: boolean; session: LiveSession | null; fileOpen?: boolean; onClose(): void }) {
  const map = kind === 'map';
  return <aside className={`workspace-float workspace-float--${kind}${open ? ' is-open' : ''}${!map && fileOpen ? ' is-file-offset' : ''}`} aria-label={map ? '地图视图' : '任务面板'} data-testid={`workspace-float-${kind}`}>
    <header className="workspace-float-header"><strong>{map ? '地图' : '任务'}</strong><button className="icon-button" type="button" aria-label={`关闭${map ? '地图视图' : '任务面板'}`} onClick={onClose}><Icon name="close" /></button></header>
    <div className="workspace-float-body">{map ? <GeoWorkspace session={session} active={open} /> : <TaskBoard session={session} />}</div>
  </aside>;
}

function WorkspaceEmpty({ mark, title, description }: { mark: string; title: string; description: string }) {
  return <section className="workspace-empty"><span>{mark}</span><strong>{title}</strong><p>{description}</p></section>;
}
