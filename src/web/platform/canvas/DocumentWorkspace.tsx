import { exportCitationMarkdown } from '../../../contracts/citation-compiler';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import 'katex/dist/katex.min.css';
import { isCitationResourceErrorCode, type CitationEnvelope, type CitationResourceErrorCode } from '../../../contracts/citation';
import { CitationCurrentFile } from '../conversation/CitationCurrentFile';
import { useCitationDetail } from '../conversation/citation-detail';
import { appKernel } from '../../app/composition-root';
import { citationResourceUrl, citationResponseError } from '../conversation/citation-resource';
import { parseDelimited } from '../workspace/delimited-table';
import { sessionFileUrl, withDownload } from '../workspace/file-urls';
import { documentFormat, documentTarget, type DocumentPosition, type DocumentView } from './document-state';
import { renderReport } from './report-renderer';
import { downloadDocument, exportReportPdf } from './report-export';

export function DocumentWorkspace({ view, active, positions }: { view: DocumentView; active: boolean; positions: Map<string, DocumentPosition> }) {
  const { t, i18n } = useTranslation();
  const openDetail = useCitationDetail();
  const [refresh, setRefresh] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [resourceError, setResourceError] = useState<CitationResourceErrorCode | null>(null);
  const [notice, setNotice] = useState('');
  const [stale, setStale] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [report, setReport] = useState<Awaited<ReturnType<typeof renderReport>> | null>(null);
  const [rows, setRows] = useState<string[][]>([]);
  const [citations, setCitations] = useState<CitationEnvelope | null>(null);
  const [action, setAction] = useState<'download' | 'export' | 'markdown' | null>(null);
  const [sourceText, setSourceText] = useState('');
  const viewport = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const root = useRef<HTMLElement>(null);
  const resourceUrl = view.source
    ? `${citationResourceUrl(view.sessionId, view.source.sourceVersionId)}?sha256=${view.source.content.sha256}`
    : sessionFileUrl(view.sessionId, view.path);
  const pdfPage = view.locator?.kind === 'document' ? view.locator.page || 1 : 1;

  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    setReady(false); setError(''); setResourceError(null); setNotice(''); setStale(false); setReport(null); setRows([]); setCitations(null);
    async function readCitations() {
      const all: CitationEnvelope = { protocol: 'pi-citation', version: '3.0', sources: [], evidence: [] };
      let offset: number | undefined = 0;
      do {
        const page = await appKernel.commands.citation.list(view.sessionId, { offset, signal: controller.signal });
        for (const source of page.sources) if (!all.sources.some((item) => item.sourceVersionId === source.sourceVersionId)) all.sources.push(source);
        all.evidence.push(...page.evidence); offset = page.nextOffset;
      } while (offset !== undefined);
      return all;
    }
    async function load() {
      if (view.format === 'pdf') {
        // Check HTTP errors before embedding; iframe load does not prove a PDF rendered.
        const response = await fetch(resourceUrl, { signal: controller.signal, cache: 'no-store' });
        await response.body?.cancel();
        if (!response.ok) throw Object.assign(new Error(t('document.loadFailed', { status: response.status })), view.source ? { code: citationResponseError(response) } : {});
      } else {
        const [content, envelope] = await Promise.all([
          view.source ? appKernel.commands.report.loadSource(view.sessionId, resourceUrl) : appKernel.commands.session.readFileContent(view.sessionId, view.path),
          readCitations().catch(() => null),
        ]);
        if (!current) return;
        setSourceText(content.content);
        setStale(content.stale === true);
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
    void load().catch((cause) => {
      if (!current) return;
      const code = isCitationResourceErrorCode(cause?.code) ? cause.code : null;
      setResourceError(code);
      setError(code ? t(`citation.error.${code}`) : (cause as Error).message || t('workspace.previewLoadFailed'));
    });
    return () => { current = false; controller.abort(); };
  }, [view.id, view.format, view.revision, refresh, i18n.language, resourceUrl]);

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
      } else if (navigate && view.locator?.kind === 'table' && view.locator.rowStart && view.format === 'csv') {
        const node = viewport.current.querySelector<HTMLElement>(`[data-document-row="${view.locator.rowStart}"]`);
        if (node) { node.scrollIntoView({ block: 'center' }); setNotice(view.locator.columns?.length ? `相关字段：${view.locator.columns.join('、')}` : ''); }
        else setNotice(t('document.locationUnavailable'));
      } else if (navigate) setNotice(t('document.locationUnavailable'));
      positions.set(view.id, { scrollTop: viewport.current.scrollTop, navigationId: view.navigationId });
    } else if (navigate && !(view.locator?.kind === 'document' && view.locator.page)) setNotice(t('document.locationUnavailable'));
  }, [ready, active, report, view.navigationId, positions, t]);

  async function runAction(kind: 'download' | 'export' | 'markdown') {
    if (action) return;
    setAction(kind); setNotice('');
    try {
      if (kind === 'download') await downloadDocument(withDownload(resourceUrl));
      else if (kind === 'markdown') {
        const value = citations ? exportCitationMarkdown(sourceText, citations) : sourceText;
        const url = URL.createObjectURL(new Blob([value], { type: 'text/markdown;charset=utf-8' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${view.title.replace(/\.md$/i, '')}.md`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      else if (article.current) await exportReportPdf(article.current, view.title);
    } catch (cause) { setNotice((cause as Error).message || t('workspace.downloadFailed')); }
    finally { setAction(null); }
  }

  return <section ref={root} className="document-workspace" tabIndex={-1} aria-label={t('document.reader', { title: view.title })} data-testid="document-workspace">
    <header className="document-toolbar">
      <span className="document-source" title={view.source ? `${view.path} · ${view.source.content.sha256}` : view.path}>{t(view.source ? 'document.citationVersion' : 'document.currentFile')} {view.source?.content.sha256.slice(0, 8)} · {view.path}</span>
      {view.format === 'markdown' ? <button type="button" aria-expanded={outlineOpen} disabled={!report?.headings.length} onClick={() => setOutlineOpen((value) => !value)}>{t('document.outline')}</button> : null}
      <button type="button" disabled={resourceError === 'content-changed'} onClick={() => setRefresh((value) => value + 1)}>{t('document.refresh')}</button>
      <button type="button" disabled={!!action || !!resourceError} onClick={() => void runAction('download')}>{action === 'download' ? t('workspace.downloading') : t('workspace.downloadOriginal')}</button>
      {resourceError === 'content-changed' && view.source ? <CitationCurrentFile sessionId={view.sessionId} source={view.source} /> : null}
      {view.format === 'markdown' ? <button type="button" disabled={!ready || !!action} onClick={() => void runAction('markdown')}>导出 Markdown</button> : null}
      {view.format === 'markdown' ? <button type="button" disabled={!ready || !!action} onClick={() => void runAction('export')}>{action === 'export' ? t('workspace.generating') : t('workspace.downloadPdf')}</button> : null}
    </header>
    {stale ? <p className="document-notice" role="status">{t('document.sourceUpdated')}</p> : null}
    {notice ? <p className="document-notice" role="status">{notice}</p> : null}
    {error ? <p className="document-notice is-error" role="alert">{error}</p> : !ready ? <p className="document-notice" role="status">{t('workspace.reading')}</p> : view.format === 'pdf' ? <>
      <iframe key={`${view.navigationId}:${view.revision}:${refresh}`} className="document-pdf" src={`${resourceUrl}#page=${pdfPage}&view=FitH`} title={t('workspace.originalPdfTitle', { name: view.title })} onError={() => setError(t('document.pdfUnavailable'))} />
      <p className="document-pdf-help">{t('document.pdfHelp')}</p>
    </> : view.format === 'csv' ? <div className="document-reading-layout">
      <div ref={viewport} className="document-scroll" onScroll={(event) => { if (active && ready) positions.set(view.id, { scrollTop: event.currentTarget.scrollTop, navigationId: view.navigationId }); }}>
        {!rows.length ? <p className="file-preview-empty">{t('workspace.tableEmpty')}</p> : <div className="file-preview-table-wrap document-csv-table"><table className="file-preview-table"><thead><tr>{rows[0].map((cell, index) => <th key={`${cell}-${index}`}>{cell}</th>)}</tr></thead><tbody>{rows.slice(1).map((row, rowIndex) => <tr key={rowIndex} data-document-row={rowIndex + 1} className={view.locator?.kind === 'table' && rowIndex + 1 >= (view.locator.rowStart || 1) && rowIndex + 1 <= (view.locator.rowEnd || view.locator.rowStart || 0) ? 'is-cited' : ''}>{rows[0].map((_, cellIndex) => <td key={cellIndex}>{row[cellIndex] || ''}</td>)}</tr>)}</tbody></table></div>}
      </div>
    </div> : <div className="document-reading-layout">
      {outlineOpen ? <nav className="document-outline" aria-label={t('document.outline')}>{report?.headings.map((heading) => <button type="button" key={heading.id} style={{ paddingInlineStart: 10 + (heading.level - 1) * 10 }} onClick={() => scrollToHeading(heading.id)}>{heading.text}</button>)}</nav> : null}
      <div ref={viewport} className="document-scroll" onScroll={(event) => { if (active && ready) positions.set(view.id, { scrollTop: event.currentTarget.scrollTop, navigationId: view.navigationId }); }}>
        <article ref={article} className="file-preview-report" onClick={(event) => {
          const marker = (event.target as HTMLElement).closest<HTMLElement>('[data-citation-id]');
          if (!marker) return;
          const id = marker.dataset.citationId;
          if (id) openDetail(view.sessionId, marker.dataset.citationIds?.split(',') || [id]);
        }} dangerouslySetInnerHTML={{ __html: report?.html || '' }} />
      </div>
    </div>}
  </section>;
}
