import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { appKernel } from '../../app/composition-root';
import { downloadDocument } from '../../platform/canvas/report-export';
import type { DocumentView } from '../../platform/canvas/document-state';
import { citationResourceUrl } from '../../platform/conversation/citation-resource';
import { sessionFileUrl, withDownload } from '../../platform/workspace/file-urls';
import { loadOfficeResource, OfficeResourceError } from './office-resource';
import { createOfficeViewer, type OfficePosition, type OfficeViewerController } from './office-viewer';

function parserErrorKey(error: unknown) {
  const code = (error as { code?: string }).code;
  if (code === 'encrypted' || code === 'invalid-password' || code === 'unsupported-encryption') return 'office.error.encrypted' as const;
  if (code === 'not-ooxml' || code === 'legacy-binary-format') return 'office.error.invalid' as const;
  return null;
}

export function OfficeWorkspace({ view, active, onContextChange }: { view: DocumentView; active: boolean; onContextChange?(target: unknown): void }) {
  const { t, i18n } = useTranslation();
  const [mount, setMount] = useState<HTMLDivElement | null>(null);
  const [sized, setSized] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [position, setPosition] = useState<OfficePosition>({ current: 0, total: 0 });
  const [notes, setNotes] = useState('');
  const [notesOpen, setNotesOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const controller = useRef<OfficeViewerController | null>(null);
  const root = useRef<HTMLElement>(null);
  const resourceUrl = view.resource
    ? `${citationResourceUrl(view.sessionId, view.resource.resourceId)}?sha256=${view.resource.sha256}`
    : sessionFileUrl(view.sessionId, view.path);

  useEffect(() => {
    if (!mount) return;
    const update = () => setSized((current) => current || (mount.clientWidth > 0 && mount.clientHeight > 0));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(mount);
    return () => observer.disconnect();
  }, [mount]);

  useEffect(() => {
    if (!mount || !sized) return;
    let current = true;
    let created: OfficeViewerController | null = null;
    const request = new AbortController();
    controller.current?.destroy();
    controller.current = null;
    mount.replaceChildren();
    setReady(false); setError(''); setNotice(''); setMatchCount(null); setPosition({ current: 0, total: 0 }); setNotes('');
    const fail = (cause: unknown) => {
      if (!current || request.signal.aborted) return;
      if (cause instanceof OfficeResourceError) setError(t(`office.error.${cause.code}`, { status: cause.status, size: 32 }));
      else setError(t(parserErrorKey(cause) || 'office.error.load', { message: (cause as Error).message || '' }));
    };
    void loadOfficeResource(resourceUrl, request.signal).then((bytes) => {
      if (!current) return null;
      return createOfficeViewer(view.format as 'docx' | 'xlsx' | 'pptx', mount, bytes, {
        onError: fail,
        onPosition: (next) => { if (current) setPosition(next); },
        onNotes: (next) => { if (current) setNotes(next); },
      });
    }).then((next) => {
      if (!next) return;
      if (!current) { next.destroy(); return; }
      created = next; controller.current = next; setReady(true);
    }).catch(fail);
    return () => {
      current = false;
      request.abort();
      if (controller.current === created) controller.current = null;
      created?.destroy();
    };
  }, [mount, sized, view.id, view.format, refresh, resourceUrl, i18n.language, t]);

  useEffect(() => {
    if (active && document.activeElement?.getAttribute('role') !== 'tab') root.current?.focus({ preventScroll: true });
  }, [active, view.navigationId]);

  const runViewerAction = useCallback((action: (current: OfficeViewerController) => void | Promise<void>) => {
    const current = controller.current;
    if (!current) return;
    void Promise.resolve(action(current)).catch((cause) => setNotice((cause as Error).message || t('office.error.action')));
  }, [t]);

  useEffect(() => {
    const target = view.canvasTarget;
    const current = controller.current;
    if (!active || !ready || !target || !current) return;
    let action: Promise<void> | null = null;
    if (target.kind === 'page' && current.goToPage) action = Promise.resolve(current.goToPage(target.number));
    else if (target.kind === 'slide' && current.goToSlide) action = Promise.resolve(current.goToSlide(target.number));
    else if (target.kind === 'sheet' && current.goToSheet) action = current.goToSheet(target.name);
    else if (target.kind === 'sheet-cell' && current.goToSheet && current.scrollToCell) action = current.goToSheet(target.sheet).then(() => current.scrollToCell!(target.cell));
    else if (target.kind === 'search') {
      setQuery(target.query);
      action = current.findText(target.query).then((count) => { setMatchCount(count); });
    } else if (target.kind === 'locator' && target.page && current.goToPage) action = Promise.resolve(current.goToPage(target.page));
    if (!action) { setNotice(t('document.locationUnavailable')); return; }
    setNotice('');
    void action.catch((cause) => setNotice((cause as Error).message || t('document.locationUnavailable')));
  }, [active, ready, view.navigationId, view.canvasTarget, t]);

  function runSearch(event: FormEvent) {
    event.preventDefault();
    const current = controller.current;
    const value = query.trim();
    if (!current) return;
    if (!value) { current.clearFind(); setMatchCount(null); return; }
    void current.findText(value).then(setMatchCount).catch((cause) => setNotice((cause as Error).message || t('office.error.action')));
  }

  async function download() {
    setDownloading(true); setNotice('');
    try { await downloadDocument(withDownload(resourceUrl)); }
    catch (cause) { setNotice((cause as Error).message || t('workspace.downloadFailed')); }
    finally { setDownloading(false); }
  }

  async function copySelection() {
    try {
      const result = await controller.current?.copySelection?.();
      if (result) setNotice(t(`office.copy.${result.status}`));
    } catch (cause) {
      setNotice((cause as Error).message || t('office.error.action'));
    }
  }

  const positionText = position.total
    ? t(view.format === 'xlsx' ? 'office.sheetPosition' : view.format === 'pptx' ? 'office.slidePosition' : 'office.pagePosition', position)
    : t('office.positionPending');

  useEffect(() => {
    if (!position.current) return;
    if (view.format === 'pptx') onContextChange?.({ kind: 'slide', number: position.current });
    else if (view.format === 'docx') onContextChange?.({ kind: 'page', number: position.current });
    else if (view.format === 'xlsx' && position.label) onContextChange?.({ kind: 'sheet', name: position.label });
  }, [position.current, position.label, view.format]);

  return <section ref={root} className="office-workspace" tabIndex={-1} aria-label={t('office.reader', { title: view.title })} data-testid="office-workspace" data-format={view.format}>
    <header className="office-toolbar">
      <span className="office-source" title={view.resource ? `${view.path} · ${view.resource.sha256}` : view.path}>
        <b>{view.title}</b><span>{view.resource ? t('document.citationVersion') : t('office.readOnly')}</span><span>{positionText}</span>
      </span>
      <form className="office-search" role="search" onSubmit={runSearch}>
        <input value={query} onChange={(event) => { setQuery(event.target.value); if (!event.target.value) { controller.current?.clearFind(); setMatchCount(null); } }} placeholder={t('office.searchPlaceholder')} aria-label={t('office.search')} />
        <button type="submit" disabled={!ready}>{t('office.search')}</button>
        <span aria-live="polite">{matchCount === null ? '' : t('office.matches', { count: matchCount })}</span>
        <button type="button" disabled={!ready || !matchCount} aria-label={t('office.previousMatch')} onClick={() => runViewerAction((item) => item.findPrev())}>↑</button>
        <button type="button" disabled={!ready || !matchCount} aria-label={t('office.nextMatch')} onClick={() => runViewerAction((item) => item.findNext())}>↓</button>
      </form>
      <div className="office-actions">
        <button type="button" disabled={!ready} aria-label={t('office.zoomOut')} onClick={() => runViewerAction((item) => item.zoomOut())}>−</button>
        <button type="button" disabled={!ready} aria-label={t('office.zoomIn')} onClick={() => runViewerAction((item) => item.zoomIn())}>＋</button>
        <button type="button" disabled={!ready} onClick={() => runViewerAction((item) => item.fitWidth())}>{t('office.fitWidth')}</button>
        <button type="button" disabled={!ready} onClick={() => runViewerAction((item) => item.fitPage())}>{t('office.fitPage')}</button>
        {view.format === 'xlsx' ? <button type="button" disabled={!ready} onClick={() => void copySelection()}>{t('office.copySelection')}</button> : null}
        {view.format === 'pptx' ? <button type="button" aria-expanded={notesOpen} disabled={!ready} onClick={() => setNotesOpen((value) => !value)}>{t('office.notes')}</button> : null}
        <button type="button" onClick={() => setRefresh((value) => value + 1)}>{t('document.refresh')}</button>
        <button type="button" disabled={downloading} onClick={() => void download()}>{downloading ? t('workspace.downloading') : t('workspace.downloadOriginal')}</button>
        {!view.resource ? <button type="button" onClick={() => void appKernel.commands.session.openInSystem(view.sessionId, view.path).catch((cause) => setNotice((cause as Error).message || t('workspace.loadFailed')))}>{t('office.openSystem')}</button> : null}
      </div>
    </header>
    {notice ? <p className="office-status" role="status">{notice}</p> : null}
    {error ? <div className="office-empty" role="alert"><strong>{t('office.loadFailed')}</strong><span>{error}</span><div><button type="button" onClick={() => setRefresh((value) => value + 1)}>{t('common.retry')}</button><button type="button" onClick={() => void download()}>{t('workspace.downloadOriginal')}</button></div></div> : null}
    {!ready && !error ? <p className="office-loading" role="status">{t('office.loading')}</p> : null}
    <div className="office-reading-layout" hidden={!!error}>
      <div ref={setMount} className="office-viewer" />
      {view.format === 'pptx' && notesOpen ? <aside className="office-notes" aria-label={t('office.notes')}><strong>{t('office.notesFor', { current: position.current || 1 })}</strong><p>{notes || t('office.noNotes')}</p></aside> : null}
    </div>
  </section>;
}
