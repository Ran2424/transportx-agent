import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnnotationMode, getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import type { DocumentPosition } from './document-state';

GlobalWorkerOptions.workerSrc = workerUrl;

type Props = {
  url: string;
  title: string;
  page?: number;
  navigationId?: number;
  position?: DocumentPosition;
  onPosition?: (position: DocumentPosition) => void;
};

export default function PdfDocument(props: Props) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const viewer = useRef<PDFViewer | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [page, setPage] = useState(1);
  const [count, setCount] = useState(0);
  const [scale, setScale] = useState(1);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    let pendingScale: string | null = null;
    const lifecycle = new AbortController();
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2, externalLinkRel: 'noopener noreferrer' });
    // PDF.js 6.4 supports abortSignal but omits it from its options declaration.
    const viewerOptions = { container: container.current!, viewer: pages.current!, eventBus, linkService, annotationMode: AnnotationMode.ENABLE, removePageBorders: true, abortSignal: lifecycle.signal };
    const reader = new PDFViewer(viewerOptions);
    viewer.current = reader;
    linkService.setViewer(reader);
    setCount(0); setError(false);
    const remember = () => {
      if (!active || !reader.pagesCount) return;
      setPage(reader.currentPageNumber); setScale(reader.currentScale);
      latest.current.onPosition?.({ scrollTop: container.current!.scrollTop, navigationId: latest.current.navigationId ?? 0, pdfPage: reader.currentPageNumber, pdfScale: pendingScale || reader.currentScaleValue });
    };
    eventBus.on('pagechanging', remember);
    eventBus.on('scalechanging', remember);
    eventBus.on('pagesinit', () => {
      if (!active) return;
      const { position, page: target = 1, navigationId } = latest.current;
      const saved = position?.navigationId === navigationId ? position : undefined;
      pendingScale = saved?.pdfScale || 'page-width';
      reader.currentScaleValue = container.current!.clientWidth ? pendingScale : '1';
      if (container.current!.clientWidth) pendingScale = null;
      reader.currentPageNumber = Math.max(1, Math.min(reader.pagesCount, saved?.pdfPage || target));
      setCount(reader.pagesCount); remember();
    });
    eventBus.on('pagerendered', ({ error: renderError }: { error?: Error }) => { if (active && renderError) setError(true); });
    const task = getDocument({ url: props.url, withCredentials: true, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/', iccUrl: '/pdfjs/iccs/' });
    void task.promise.then((document) => {
      if (!active) return;
      linkService.setDocument(document);
      reader.setDocument(document);
    }).catch((cause) => { if (active) { console.warn('PDF preview failed:', cause); setError(true); } });
    const resize = new ResizeObserver(() => {
      if (!reader.pagesCount || !container.current!.clientWidth) return;
      const deferred = pendingScale;
      if (deferred || reader.currentScaleValue === 'page-width') {
        const pageNumber = reader.currentPageNumber;
        reader.currentScaleValue = deferred || 'page-width';
        pendingScale = null;
        if (deferred) reader.scrollPageIntoView({ pageNumber });
      }
    });
    resize.observe(container.current!);
    return () => {
      active = false; resize.disconnect(); viewer.current = null;
      reader.setDocument(null); linkService.setDocument(null); lifecycle.abort();
      void task.destroy();
    };
  }, [props.url]);

  useEffect(() => {
    const reader = viewer.current;
    if (reader?.pagesCount) reader.currentPageNumber = Math.max(1, Math.min(reader.pagesCount, props.page || 1));
  }, [props.navigationId, props.page]);

  function goTo(value: number) {
    if (viewer.current && Number.isFinite(value)) viewer.current.currentPageNumber = Math.max(1, Math.min(count, Math.trunc(value)));
  }
  function zoom(factor: number) {
    if (viewer.current) viewer.current.currentScaleValue = String(Math.max(0.25, Math.min(4, scale * factor)));
  }

  return <section className="document-pdf" aria-label={props.title}>
    <div className="document-pdf-toolbar" role="toolbar" aria-label={t('document.pdfControls')}>
      <button type="button" disabled={!count || page <= 1} onClick={() => goTo(page - 1)} aria-label={t('document.pdfPrevious')}>‹</button>
      <label><span className="sr-only">{t('document.pdfPage')}</span><input aria-label={t('document.pdfPage')} type="number" min={1} max={count || 1} value={page} disabled={!count} onChange={(event) => goTo(Number(event.target.value))} /> / {count || '—'}</label>
      <button type="button" disabled={!count || page >= count} onClick={() => goTo(page + 1)} aria-label={t('document.pdfNext')}>›</button>
      <span className="document-pdf-toolbar-separator" />
      <button type="button" disabled={!count || scale <= 0.25} onClick={() => zoom(1 / 1.2)} aria-label={t('document.pdfZoomOut')}>−</button>
      <output>{Math.round(scale * 100)}%</output>
      <button type="button" disabled={!count || scale >= 4} onClick={() => zoom(1.2)} aria-label={t('document.pdfZoomIn')}>+</button>
      <button type="button" disabled={!count} onClick={() => { if (viewer.current) viewer.current.currentScaleValue = 'page-width'; }}>{t('document.pdfFitWidth')}</button>
    </div>
    {error && <p className="document-notice is-error" role="alert">{t('document.pdfUnavailable')}</p>}
    {!count && !error && <p className="document-notice">{t('workspace.reading')}</p>}
    <div className="document-pdf-body"><div className="document-pdf-scroll" ref={container}><div className="pdfViewer" ref={pages} /></div></div>
  </section>;
}
