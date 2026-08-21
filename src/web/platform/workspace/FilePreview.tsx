import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import 'katex/dist/katex.min.css';
import { renderMarkdown } from '../../../public/markdown.js';
import { compileCitations } from '../../../contracts/citation-compiler.js';
import type { CitationEnvelope } from '../../../contracts/citation.js';
import type { WorkspaceFile, WorkspaceFileContent } from '../../../public/kernel/commands.js';
import { appKernel } from '../../app/composition-root';
import { Icon } from '../../components/icons';
import type { MessageCitationProjection } from '../../features/citation/citation-projection';
import i18n from '../../i18n';

type FileIcon = 'workspace' | 'file' | 'report' | 'code' | 'image' | 'table';
type PreviewKind = 'code' | 'table' | 'report' | 'image' | 'pdf' | 'document' | null;

export type FilePresentation = { kind: string; icon: FileIcon; label: string; preview: PreviewKind; extension: string };
export type ExternalPreviewSource = {
  url: string;
  kind: 'pdf' | 'document' | 'image' | 'report';
  mimeType: string;
  page?: number;
};

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico']);
const PDF_EXTENSIONS = new Set(['pdf']);
const TABLE_EXTENSIONS = new Set(['csv', 'tsv', 'xlsx', 'xls', 'ods']);
const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'sh', 'bash', 'zsh', 'css', 'scss', 'html', 'sql', 'json', 'yaml', 'yml', 'xml', 'java', 'c', 'h', 'cpp', 'hpp', 'go', 'rs']);

export function filePresentation(item: WorkspaceFile): FilePresentation {
  if (item.isDirectory) return { kind: 'directory', icon: 'workspace', label: i18n.t('workspace.type.directory'), preview: null, extension: '' };
  const pathName = item.path.replaceAll('\\', '/').split('/').pop() || item.name;
  const extension = pathName.split('.').pop()?.toLowerCase() || '';
  if (extension === 'md' || extension === 'mdx') return { kind: 'report', icon: 'report', label: i18n.t('workspace.type.report'), preview: 'report', extension };
  if (IMAGE_EXTENSIONS.has(extension)) return { kind: 'image', icon: 'image', label: i18n.t('workspace.type.image'), preview: 'image', extension };
  if (PDF_EXTENSIONS.has(extension)) return { kind: 'pdf', icon: 'file', label: i18n.t('workspace.type.pdf'), preview: 'pdf', extension };
  if (TABLE_EXTENSIONS.has(extension)) return { kind: 'table', icon: 'table', label: i18n.t('workspace.type.table'), preview: 'table', extension };
  if (CODE_EXTENSIONS.has(extension)) return { kind: 'code', icon: 'code', label: i18n.t('workspace.type.code'), preview: 'code', extension };
  return { kind: 'document', icon: 'file', label: i18n.t('workspace.type.document'), preview: null, extension };
}

function externalPresentation(source: ExternalPreviewSource): FilePresentation {
  if (source.kind === 'pdf') return { kind: 'pdf', icon: 'file', label: i18n.t('workspace.type.originalPdf'), preview: 'pdf', extension: 'pdf' };
  if (source.kind === 'image') return { kind: 'image', icon: 'image', label: i18n.t('workspace.type.originalImage'), preview: 'image', extension: '' };
  if (source.kind === 'report') return { kind: 'report', icon: 'report', label: i18n.t('workspace.type.report'), preview: 'report', extension: 'md' };
  return { kind: 'document', icon: 'file', label: i18n.t('workspace.type.source'), preview: 'document', extension: '' };
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
  const { t } = useTranslation();
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
    }).catch((cause) => { if (active) setError((cause as Error).message || t('workspace.tableParseFailed')); });
    return () => { active = false; };
  }, [content, file.extension, t]);
  if (error) return <p className="file-preview-error">{error}</p>;
  if (!rows.length) return <p className="file-preview-empty">{t('workspace.tableEmpty')}</p>;
  const header = rows[0];
  return <div className="file-preview-table-wrap">{sheetName ? <p className="file-preview-sheet">{t('workspace.sheet', { name: sheetName })}</p> : null}<table className="file-preview-table"><thead><tr>{header.map((cell, index) => <th key={`${cell}-${index}`}>{cell}</th>)}</tr></thead><tbody>{rows.slice(1).map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, cellIndex) => <td key={cellIndex}>{row[cellIndex] || ''}</td>)}</tr>)}</tbody></table></div>;
}

export function sessionReportImageUrl(url: string, reportPath: string, sessionId: string, origin: string) {
  const value = url.trim().replace(/^<(.+)>$/, '$1');
  if (/^(https?:|data:image\/)/i.test(value) || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return value;
  const separator = Math.max(reportPath.lastIndexOf('/'), reportPath.lastIndexOf('\\'));
  const directory = separator >= 0 ? reportPath.slice(0, separator) : '';
  const imagePath = value.startsWith('/') || !directory ? value : `${directory}/${value}`;
  return `${origin}/api/file/preview?${new URLSearchParams({ sessionId, path: imagePath })}`;
}

async function renderReport(source: string, reportPath: string, sessionId: string, citations: CitationEnvelope | null, _citationProjection?: MessageCitationProjection) {
  let compiled: ReturnType<typeof compileCitations> | undefined;
  if (citations) compiled = compileCitations(source, citations, 'gbt7714-numeric');
  const replacements: Array<{ token: string; value: string }> = [];
  let index = 0;
  const token = () => `FILE_PREVIEW_RENDER_${index++}`;
  let markdown = (compiled?.markdown || source).replace(/```mermaid\s*\n([\s\S]*?)```/gi, (_, chart) => {
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
  let html = renderMarkdown(
    markdown,
    compiled?.numbers,
    (url) => sessionReportImageUrl(url, reportPath, sessionId, window.location.origin),
    i18n.language,
  );
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

function ReportPreview({ source, reportPath, sessionId, citationProjection }: { source: string; reportPath: string; sessionId: string; citationProjection?: MessageCitationProjection }) {
  const { t } = useTranslation();
  const kernel = appKernel;
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setHtml(''); setError('');
    void kernel.commands.citation.list(sessionId).catch(() => null).then((citations) => renderReport(source, reportPath, sessionId, citations, citationProjection)).then((next) => { if (active) setHtml(next); }).catch((cause) => { if (active) setError((cause as Error).message || t('workspace.reportRenderFailed')); });
    return () => { active = false; };
  }, [citationProjection, kernel, reportPath, sessionId, source, t]);
  if (error) return <p className="file-preview-error">{error}</p>;
  return html ? <article className="file-preview-report" dangerouslySetInnerHTML={{ __html: html }} /> : <p className="file-preview-loading">{t('workspace.renderingReport')}</p>;
}

type PreviewCorner = 'nw' | 'ne' | 'se' | 'sw';

const MIN_PREVIEW_WIDTH = 420;
const MIN_PREVIEW_HEIGHT = 300;

function previewSize() {
  return { width: Math.min(720, window.innerWidth - 44), height: Math.min(540, window.innerHeight - 44) };
}

async function imageDataUrl(image: HTMLImageElement, fallbackError: Error) {
  if (image.complete && image.naturalWidth && image.naturalHeight) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable');
      context.drawImage(image, 0, 0);
      return canvas.toDataURL();
    } catch { /* Fetch below when the image cannot be copied from the preview. */ }
  }
  const response = await fetch(image.src);
  if (!response.ok) throw fallbackError;
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(i18n.t('workspace.imageConvertFailed')));
    reader.readAsDataURL(blob);
  });
}

export function FilePreview({ item, sessionId, stackIndex, initialOffset, externalSource, citationProjection, onActivate, onClose }: { item: WorkspaceFile; sessionId: string; stackIndex: number; initialOffset: number; externalSource?: ExternalPreviewSource; citationProjection?: MessageCitationProjection; onActivate(): void; onClose(): void }) {
  const { t } = useTranslation();
  const kernel = appKernel;
  const presentation = useMemo(() => externalSource ? externalPresentation(externalSource) : filePresentation(item), [externalSource, item]);
  const [content, setContent] = useState<WorkspaceFileContent | null>(null);
  const [error, setError] = useState('');
  const [pdfStatus, setPdfStatus] = useState<'idle' | 'loading' | 'saved' | 'error'>('idle');
  const [pdfError, setPdfError] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() => ({ x: initialOffset * 26, y: initialOffset * 22 }));
  const [size, setSize] = useState(previewSize);
  const drag = useRef<{ id: number; x: number; y: number; originX: number; originY: number } | null>(null);
  const resize = useRef<{ id: number; corner: PreviewCorner; x: number; y: number; originX: number; originY: number; width: number; height: number } | null>(null);
  const previewUrl = useMemo(() => externalSource?.url || `/api/file/preview?${new URLSearchParams({ sessionId, path: item.path })}`, [externalSource?.url, item.path, sessionId]);

  useEffect(() => {
    let active = true;
    setContent(null); setError('');
    if (externalSource) {
      if (presentation.preview !== 'report') return;
      void fetch(externalSource.url).then(async (response) => {
        if (!response.ok) throw new Error(t('workspace.reportLoadFailed'));
        const next = await response.text();
        if (active) setContent({ content: next, encoding: 'utf8', size: new Blob([next]).size });
      }).catch((cause) => { if (active) setError((cause as Error).message || t('workspace.reportLoadFailed')); });
      return () => { active = false; };
    }
    if (!presentation.preview || presentation.preview === 'image') return;
    void kernel.commands.session.readFileContent(sessionId, item.path).then((next) => { if (active) setContent(next); }).catch((cause) => { if (active) setError((cause as Error).message || t('workspace.previewLoadFailed')); });
    return () => { active = false; };
  }, [externalSource, item.path, kernel, presentation.preview, sessionId, t]);

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

  async function downloadPdf() {
    const report = bodyRef.current?.querySelector<HTMLElement>('.file-preview-report');
    if (!report || pdfStatus === 'loading') return;
    setPdfStatus('loading'); setPdfError('');
    try {
      const clone = report.cloneNode(true) as HTMLElement;
      const sourceImages = [...report.querySelectorAll<HTMLImageElement>('img')];
      const clonedImages = [...clone.querySelectorAll<HTMLImageElement>('img')];
      await Promise.all(sourceImages.map(async (image, index) => {
        if (!image.src || image.src.startsWith('data:')) return;
        const dataUrl = await imageDataUrl(image, new Error(t('workspace.imageLoadFailed', { name: image.alt || index + 1 })));
        clonedImages[index]?.setAttribute('src', dataUrl);
      }));
      const response = await fetch('/api/reports/pdf/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: item.name, html: clone.outerHTML }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(detail.error || t('workspace.pdfFailed'));
      }
      const detail = await response.json() as { url?: string };
      if (!detail.url) throw new Error(t('workspace.pdfFailed'));
      const desktop = window as Window & { transportxDesktop?: { download(url: string): Promise<string> } };
      if (desktop.transportxDesktop) await desktop.transportxDesktop.download(detail.url);
      else window.location.assign(detail.url);
      setPdfStatus('saved');
      window.setTimeout(() => setPdfStatus('idle'), 5_000);
    } catch (cause) {
      setPdfError((cause as Error).message || t('workspace.pdfFailed'));
      setPdfStatus('error');
    }
  }

  const body = presentation.preview === 'image'
    ? <img className="file-preview-image" src={previewUrl} alt={item.name} />
    : presentation.preview === 'pdf'
      ? <iframe className="file-preview-document" src={`${previewUrl}#page=${externalSource?.page || 1}&view=FitH`} title={t('workspace.originalPdfTitle', { name: item.name })} />
      : presentation.preview === 'document'
        ? <iframe className="file-preview-document" src={previewUrl} title={t('workspace.sourceTitle', { name: item.name })} />
        : error
          ? <p className="file-preview-error">{error}</p>
          : !content
            ? <p className="file-preview-loading">{t('workspace.reading')}</p>
            : presentation.preview === 'code'
              ? <CodePreview source={content.content} extension={presentation.extension} />
              : presentation.preview === 'table'
                ? <TablePreview file={presentation} content={content} />
                : <ReportPreview source={content.content} reportPath={item.path} sessionId={sessionId} citationProjection={citationProjection} />;

  return createPortal(<section className="file-preview-card" role="dialog" aria-modal="false" aria-label={t('workspace.preview', { name: item.name })} style={{ width: size.width, height: size.height, zIndex: 80 + stackIndex, transform: `translate(calc(-50% + ${position.x}px), calc(-50% + ${position.y}px))` }} onPointerDownCapture={onActivate}>
    <header className={`file-preview-header${presentation.preview === 'report' ? ' has-export' : ''}`} onPointerDown={startDrag} onPointerMove={dragPreview} onPointerUp={stopDrag} onPointerCancel={stopDrag}>
      <span className={`file-preview-type is-${presentation.kind}`}><Icon name={presentation.icon} />{presentation.label}</span>
      <strong title={item.path}>{item.name}</strong>
      {presentation.preview === 'report' ? <button className={`file-preview-export${pdfStatus === 'error' ? ' is-error' : ''}`} type="button" disabled={pdfStatus === 'loading'} title={pdfError || t('workspace.downloadPdf')} onPointerDown={(event) => event.stopPropagation()} onClick={() => void downloadPdf()}>{pdfStatus === 'loading' ? t('workspace.generating') : pdfStatus === 'saved' ? t('workspace.downloaded') : pdfStatus === 'error' ? t('workspace.retryPdf') : t('workspace.download')}</button> : null}
      <button className="icon-button" type="button" aria-label={t('workspace.previewClose')} onPointerDown={(event) => event.stopPropagation()} onClick={onClose}><Icon name="close" /></button>
    </header>
    <div ref={bodyRef} className={`file-preview-body is-${presentation.kind}`}>{body}</div>
    {(['nw', 'ne', 'se', 'sw'] as PreviewCorner[]).map((corner) => <span key={corner} className={`file-preview-resize is-${corner}`} aria-hidden="true" onPointerDown={(event) => startResize(corner, event)} onPointerMove={resizePreview} onPointerUp={stopResize} onPointerCancel={stopResize} />)}
  </section>, document.body);
}
