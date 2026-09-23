import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import 'katex/dist/katex.min.css';
import type { CitationEnvelope } from '../../../contracts/citation';
import { citationOccurrenceIndex } from '../../../contracts/citation-compiler';
import { appKernel } from '../../app/composition-root';
import { citationResourceUrl } from '../conversation/citation-resource';
import { parseDelimited } from '../workspace/delimited-table';
import { sessionFileUrl, withDownload } from '../workspace/file-urls';
import { useOpenDocument } from './document-context';
import { documentFormat, documentTarget, type DocumentPosition, type DocumentView } from './document-state';
import { renderReport } from './report-renderer';
import { downloadDocument, exportReportPdf } from './report-export';

export function DocumentWorkspace({ view, active, positions }: { view: DocumentView; active: boolean; positions: Map<string, DocumentPosition> }) {
  const { t, i18n } = useTranslation();
  const openDocument = useOpenDocument();
  const [refresh, setRefresh] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [report, setReport] = useState<Awaited<ReturnType<typeof renderReport>> | null>(null);
  const [rows, setRows] = useState<string[][]>([]);
  const [citations, setCitations] = useState<CitationEnvelope | null>(null);
  const [action, setAction] = useState<'download' | 'export' | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const root = useRef<HTMLElement>(null);
  const resourceUrl = view.resource
    ? `${citationResourceUrl(view.sessionId, view.resource.resourceId)}?sha256=${view.resource.sha256}`
    : sessionFileUrl(view.sessionId, view.path);
  const pdfPage = view.locator?.page || 1;

  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    setReady(false); setError(''); setNotice(''); setReport(null); setRows([]); setCitations(null);
    async function load() {
      if (view.format === 'pdf') {
        // Check HTTP errors before embedding; iframe load does not prove a PDF rendered.
        const response = await fetch(resourceUrl, { signal: controller.signal, cache: 'no-store' });
        await response.body?.cancel();
        if (!response.ok) throw new Error(response.status === 409 ? t('document.versionChanged') : t('document.loadFailed', { status: response.status }));
      } else {
        const [content, envelope] = await Promise.all([
          view.resource ? appKernel.commands.report.loadSource(view.sessionId, resourceUrl) : appKernel.commands.session.readFileContent(view.sessionId, view.path),
          appKernel.commands.citation.list(view.sessionId).catch(() => null),
        ]);
        if (!current) return;
        if (view.format === 'csv') setRows(parseDelimited(content.content, ','));
        else {
          const rendered = await renderReport(content.content, view, envelope);
          if (!current) return;
          setReport(rendered);
        }
        setCitations(envelope);
      }
      if (current) setReady(true);
    }
    void load().catch((cause) => { if (current) setError((cause as Error).message || t('workspace.previewLoadFailed')); });
    return () => { current = false; controller.abort(); };
  }, [view.id, view.format, refresh, i18n.language, resourceUrl]);

  useEffect(() => {
    if (active && document.activeElement?.getAttribute('role') !== 'tab') root.current?.focus({ preventScroll: true });
  }, [active, view.navigationId]);

  function headingNode(id: string) {
    return [...(article.current?.querySelectorAll<HTMLElement>('[data-document-heading]') ?? [])].find((node) => node.dataset.documentHeading === id);
  }

  function scrollToHeading(id: string) {
    const node = headingNode(id);
    const container = viewport.current;
    if (!node || !container) return;
    container.scrollTop += node.getBoundingClientRect().top - container.getBoundingClientRect().top - 16;
  }

  useLayoutEffect(() => {
    if (!ready || !active) return;
    const saved = positions.get(view.id);
    const navigate = view.locator && saved?.navigationId !== view.navigationId;
    if ((view.format === 'markdown' || view.format === 'csv') && viewport.current) {
      viewport.current.scrollTop = saved?.scrollTop ?? 0;
      if (navigate && view.format === 'markdown') {
        const target = documentTarget(report?.headings ?? [], view.locator!);
        if (target) { scrollToHeading(target); setNotice(''); }
        else setNotice(t('document.locationUnavailable'));
      } else if (navigate) setNotice(t('document.locationUnavailable'));
      positions.set(view.id, { scrollTop: viewport.current.scrollTop, navigationId: view.navigationId });
    } else if (navigate && !view.locator?.page) setNotice(t('document.locationUnavailable'));
  }, [ready, active, report, view.navigationId, positions, t]);

  async function runAction(kind: 'download' | 'export') {
    if (action) return;
    setAction(kind); setNotice('');
    try {
      if (kind === 'download') await downloadDocument(withDownload(resourceUrl));
      else if (article.current) await exportReportPdf(article.current, view.title);
    } catch (cause) { setNotice((cause as Error).message || t('workspace.downloadFailed')); }
    finally { setAction(null); }
  }

  return <section ref={root} className="document-workspace" tabIndex={-1} aria-label={t('document.reader', { title: view.title })} data-testid="document-workspace">
    <header className="document-toolbar">
      <span className="document-source" title={view.resource ? `${view.path} · ${view.resource.sha256}` : view.path}>{t(view.resource ? 'document.citationVersion' : 'document.currentFile')} {view.resource?.sha256.slice(0, 8)} · {view.path}</span>
      {view.format === 'markdown' ? <button type="button" aria-expanded={outlineOpen} disabled={!report?.headings.length} onClick={() => setOutlineOpen((value) => !value)}>{t('document.outline')}</button> : null}
      <button type="button" onClick={() => setRefresh((value) => value + 1)}>{t('document.refresh')}</button>
      <button type="button" disabled={!!action} onClick={() => void runAction('download')}>{action === 'download' ? t('workspace.downloading') : t('workspace.downloadOriginal')}</button>
      {view.format === 'markdown' ? <button type="button" disabled={!ready || !!action} onClick={() => void runAction('export')}>{action === 'export' ? t('workspace.generating') : t('workspace.downloadPdf')}</button> : null}
    </header>
    {notice ? <p className="document-notice" role="status">{notice}</p> : null}
    {error ? <p className="document-notice is-error" role="alert">{error}</p> : !ready ? <p className="document-notice" role="status">{t('workspace.reading')}</p> : view.format === 'pdf' ? <>
      <iframe key={`${view.navigationId}:${refresh}`} className="document-pdf" src={`${resourceUrl}#page=${pdfPage}&view=FitH`} title={t('workspace.originalPdfTitle', { name: view.title })} onError={() => setError(t('document.pdfUnavailable'))} />
      <p className="document-pdf-help">{t('document.pdfHelp')}</p>
    </> : view.format === 'csv' ? <div className="document-reading-layout">
      <div ref={viewport} className="document-scroll" onScroll={(event) => { if (active && ready) positions.set(view.id, { scrollTop: event.currentTarget.scrollTop, navigationId: view.navigationId }); }}>
        {!rows.length ? <p className="file-preview-empty">{t('workspace.tableEmpty')}</p> : <div className="file-preview-table-wrap document-csv-table"><table className="file-preview-table"><thead><tr>{rows[0].map((cell, index) => <th key={`${cell}-${index}`}>{cell}</th>)}</tr></thead><tbody>{rows.slice(1).map((row, rowIndex) => <tr key={rowIndex}>{rows[0].map((_, cellIndex) => <td key={cellIndex}>{row[cellIndex] || ''}</td>)}</tr>)}</tbody></table></div>}
      </div>
    </div> : <div className="document-reading-layout">
      {outlineOpen ? <nav className="document-outline" aria-label={t('document.outline')}>{report?.headings.map((heading) => <button type="button" key={heading.id} style={{ paddingInlineStart: 10 + (heading.level - 1) * 10 }} onClick={() => scrollToHeading(heading.id)}>{heading.text}</button>)}</nav> : null}
      <div ref={viewport} className="document-scroll" onScroll={(event) => { if (active && ready) positions.set(view.id, { scrollTop: event.currentTarget.scrollTop, navigationId: view.navigationId }); }}>
        <article ref={article} className="file-preview-report" onClick={(event) => {
          const marker = (event.target as HTMLElement).closest<HTMLElement>('[data-citation-id]');
          if (!marker) return;
          const citation = citations && citationOccurrenceIndex(citations).get(marker.dataset.citationId || '');
          if (!citation || !documentFormat(citation.resource.relativePath, citation.resource.mimeType)) { setNotice(t('document.locationUnavailable')); return; }
          openDocument({ sessionId: view.sessionId, title: citation.work.title, path: citation.resource.relativePath, resource: citation.resource, locator: citation.locator });
        }} dangerouslySetInnerHTML={{ __html: report?.html || '' }} />
      </div>
    </div>}
  </section>;
}
