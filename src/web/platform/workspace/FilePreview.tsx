import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import 'katex/dist/katex.min.css';
import { renderMarkdown } from '../../../public/markdown.js';
import type { WorkspaceFile, WorkspaceFileContent } from '../../../public/kernel/commands.js';
import { useAppServices } from '../../app/AppProviders';
import { Icon } from '../../components/icons';

type FileIcon = 'workspace' | 'file' | 'report' | 'code' | 'image' | 'table';
type PreviewKind = 'code' | 'table' | 'report' | 'image' | null;

export type FilePresentation = { kind: string; icon: FileIcon; label: string; preview: PreviewKind; extension: string };

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico']);
const TABLE_EXTENSIONS = new Set(['csv', 'tsv', 'xlsx', 'xls', 'ods']);
const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'sh', 'bash', 'zsh', 'css', 'scss', 'html', 'sql', 'json', 'yaml', 'yml', 'xml', 'java', 'c', 'h', 'cpp', 'hpp', 'go', 'rs']);

export function filePresentation(item: WorkspaceFile): FilePresentation {
  if (item.isDirectory) return { kind: 'directory', icon: 'workspace', label: '文件夹', preview: null, extension: '' };
  const extension = item.name.split('.').pop()?.toLowerCase() || '';
  if (extension === 'md' || extension === 'mdx') return { kind: 'report', icon: 'report', label: 'Markdown 报告', preview: 'report', extension };
  if (IMAGE_EXTENSIONS.has(extension)) return { kind: 'image', icon: 'image', label: '图片', preview: 'image', extension };
  if (TABLE_EXTENSIONS.has(extension)) return { kind: 'table', icon: 'table', label: '表格', preview: 'table', extension };
  if (CODE_EXTENSIONS.has(extension)) return { kind: 'code', icon: 'code', label: '代码', preview: 'code', extension };
  return { kind: 'document', icon: 'file', label: '文档', preview: null, extension };
}

function syntaxLanguage(extension: string) {
  return ({ ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript', py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', scss: 'scss', yml: 'yaml', html: 'html', json: 'json', xml: 'xml', cpp: 'cpp', hpp: 'cpp' } as Record<string, string>)[extension] || extension || 'text';
}

function parseDelimited(source: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { cell += '"'; index += 1; } else quoted = !quoted;
    } else if (char === delimiter && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  row.push(cell); if (row.some(Boolean)) rows.push(row);
  return rows;
}

function CodePreview({ source, extension }: { source: string; extension: string }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let active = true;
    void import('shiki').then(({ codeToHtml }) => codeToHtml(source, { lang: syntaxLanguage(extension) as never, theme: 'github-light' })).then((next) => { if (active) setHtml(next); }).catch(() => { if (active) setHtml(''); });
    return () => { active = false; };
  }, [extension, source]);
  return html ? <div className="file-preview-code" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="file-preview-plain-code">{source}</pre>;
}

function TablePreview({ file, content }: { file: FilePresentation; content: WorkspaceFileContent }) {
  const [rows, setRows] = useState<string[][]>([]);
  const [sheetName, setSheetName] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setRows([]); setSheetName(''); setError('');
    if (file.extension === 'csv' || file.extension === 'tsv') { setRows(parseDelimited(content.content, file.extension === 'tsv' ? '\t' : ',')); return; }
    void import('xlsx').then((XLSX) => {
      const workbook = XLSX.read(content.content, { type: content.encoding === 'base64' ? 'base64' : 'string' });
      const name = workbook.SheetNames[0];
      const sheet = name ? workbook.Sheets[name] : null;
      const next = sheet ? (XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as unknown[][]).map((row) => row.map((cell) => String(cell))) : [];
      if (active) { setSheetName(name || ''); setRows(next); }
    }).catch((cause) => { if (active) setError((cause as Error).message || '无法解析表格'); });
    return () => { active = false; };
  }, [content, file.extension]);
  if (error) return <p className="file-preview-error">{error}</p>;
  if (!rows.length) return <p className="file-preview-empty">表格没有可展示的数据。</p>;
  const header = rows[0];
  return <div className="file-preview-table-wrap">{sheetName ? <p className="file-preview-sheet">工作表：{sheetName}</p> : null}<table className="file-preview-table"><thead><tr>{header.map((cell, index) => <th key={`${cell}-${index}`}>{cell}</th>)}</tr></thead><tbody>{rows.slice(1).map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, cellIndex) => <td key={cellIndex}>{row[cellIndex] || ''}</td>)}</tr>)}</tbody></table></div>;
}

async function renderReport(source: string) {
  const replacements: Array<{ token: string; value: string }> = [];
  let index = 0;
  const token = () => `FILE_PREVIEW_RENDER_${index++}`;
  let markdown = source.replace(/```mermaid\s*\n([\s\S]*?)```/gi, (_, chart) => {
    const placeholder = token();
    replacements.push({ token: placeholder, value: chart.trim() });
    return placeholder;
  });
  const { renderToString } = await import('katex');
  const addMath = (expression: string, displayMode: boolean) => {
    const placeholder = token();
    replacements.push({ token: placeholder, value: renderToString(expression.trim(), { displayMode, throwOnError: false }) });
    return placeholder;
  };
  markdown = markdown.replace(/\$\$([\s\S]+?)\$\$/g, (_, expression) => addMath(expression, true));
  markdown = markdown.replace(/(^|[^\\])\$([^$\n]+)\$/g, (_, prefix, expression) => `${prefix}${addMath(expression, false)}`);
  let html = renderMarkdown(markdown);
  for (const replacement of replacements) {
    let value = replacement.value;
    if (!value.startsWith('<')) {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
        value = `<div class="file-preview-mermaid">${(await mermaid.render(`file-preview-chart-${replacement.token}`, value)).svg}</div>`;
      } catch { value = `<pre class="file-preview-plain-code">${replacement.value}</pre>`; }
    }
    html = html.replace(`<p>${replacement.token}</p>`, value).split(replacement.token).join(value);
  }
  return html;
}

function ReportPreview({ source }: { source: string }) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setHtml(''); setError('');
    void renderReport(source).then((next) => { if (active) setHtml(next); }).catch((cause) => { if (active) setError((cause as Error).message || '报告渲染失败'); });
    return () => { active = false; };
  }, [source]);
  if (error) return <p className="file-preview-error">{error}</p>;
  return html ? <article className="file-preview-report" dangerouslySetInnerHTML={{ __html: html }} /> : <p className="file-preview-loading">正在渲染报告…</p>;
}

type PreviewCorner = 'nw' | 'ne' | 'se' | 'sw';

const MIN_PREVIEW_WIDTH = 420;
const MIN_PREVIEW_HEIGHT = 300;

function previewSize() {
  return { width: Math.min(720, window.innerWidth - 44), height: Math.min(540, window.innerHeight - 44) };
}

export function FilePreview({ item, sessionId, stackIndex, initialOffset, onActivate, onClose }: { item: WorkspaceFile; sessionId: string; stackIndex: number; initialOffset: number; onActivate(): void; onClose(): void }) {
  const { kernel } = useAppServices();
  const presentation = useMemo(() => filePresentation(item), [item]);
  const [content, setContent] = useState<WorkspaceFileContent | null>(null);
  const [error, setError] = useState('');
  const [position, setPosition] = useState(() => ({ x: initialOffset * 26, y: initialOffset * 22 }));
  const [size, setSize] = useState(previewSize);
  const drag = useRef<{ id: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const resize = useRef<{ id: number; corner: PreviewCorner; x: number; y: number; originX: number; originY: number; width: number; height: number } | null>(null);
  const imageUrl = useMemo(() => `/api/file/preview?${new URLSearchParams({ sessionId, path: item.path })}`, [item.path, sessionId]);

  useEffect(() => {
    let active = true;
    setContent(null); setError('');
    if (!presentation.preview || presentation.preview === 'image') return;
    void kernel.commands.session.readFileContent(sessionId, item.path).then((next) => { if (active) setContent(next); }).catch((cause) => { if (active) setError((cause as Error).message || '文件预览加载失败'); });
    return () => { active = false; };
  }, [item.path, kernel, presentation.preview, sessionId]);

  function startDrag(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    onActivate();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: position.x, originY: position.y };
  }
  function dragPreview(event: ReactPointerEvent<HTMLElement>) {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    setPosition({ x: state.originX + event.clientX - state.x, y: state.originY + event.clientY - state.y });
  }
  function stopDrag(event: ReactPointerEvent<HTMLElement>) {
    if (drag.current?.id === event.pointerId) drag.current = null;
  }

  function startResize(corner: PreviewCorner, event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); onActivate();
    event.currentTarget.setPointerCapture(event.pointerId);
    resize.current = { id: event.pointerId, corner, x: event.clientX, y: event.clientY, originX: position.x, originY: position.y, width: size.width, height: size.height };
  }
  function resizePreview(event: ReactPointerEvent<HTMLElement>) {
    const state = resize.current;
    if (!state || state.id !== event.pointerId) return;
    const maxWidth = Math.max(320, window.innerWidth - 32);
    const maxHeight = Math.max(240, window.innerHeight - 32);
    const minWidth = Math.min(MIN_PREVIEW_WIDTH, maxWidth);
    const minHeight = Math.min(MIN_PREVIEW_HEIGHT, maxHeight);
    const width = Math.max(minWidth, Math.min(maxWidth, state.width + (state.corner.includes('e') ? event.clientX - state.x : state.x - event.clientX)));
    const height = Math.max(minHeight, Math.min(maxHeight, state.height + (state.corner.includes('s') ? event.clientY - state.y : state.y - event.clientY)));
    setSize({ width, height });
    setPosition({ x: state.originX + (state.corner.includes('e') ? width - state.width : state.width - width) / 2, y: state.originY + (state.corner.includes('s') ? height - state.height : state.height - height) / 2 });
  }
  function stopResize(event: ReactPointerEvent<HTMLElement>) {
    if (resize.current?.id === event.pointerId) resize.current = null;
  }

  const body = presentation.preview === 'image' ? <img className="file-preview-image" src={imageUrl} alt={item.name} /> : error ? <p className="file-preview-error">{error}</p> : !content ? <p className="file-preview-loading">正在读取文件…</p> : presentation.preview === 'code' ? <CodePreview source={content.content} extension={presentation.extension} /> : presentation.preview === 'table' ? <TablePreview file={presentation} content={content} /> : <ReportPreview source={content.content} />;

  return createPortal(<section className="file-preview-card" role="dialog" aria-modal="false" aria-label={`预览 ${item.name}`} style={{ width: size.width, height: size.height, zIndex: 80 + stackIndex, transform: `translate(calc(-50% + ${position.x}px), calc(-50% + ${position.y}px))` }} onPointerDownCapture={onActivate}>
    <header className="file-preview-header" onPointerDown={startDrag} onPointerMove={dragPreview} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
      <span className={`file-preview-type is-${presentation.kind}`}><Icon name={presentation.icon} />{presentation.label}</span>
      <strong title={item.path}>{item.name}</strong>
      <button className="icon-button" type="button" aria-label="关闭文件预览" onPointerDown={(event) => event.stopPropagation()} onClick={onClose}><Icon name="close" /></button>
    </header>
    <div className={`file-preview-body is-${presentation.kind}`}>{body}</div>
    {(['nw', 'ne', 'se', 'sw'] as PreviewCorner[]).map((corner) => <span key={corner} className={`file-preview-resize is-${corner}`} aria-hidden="true" onPointerDown={(event) => startResize(corner, event)} onPointerMove={resizePreview} onPointerUp={stopResize} onPointerCancel={stopResize} />)}
  </section>, document.body);
}
