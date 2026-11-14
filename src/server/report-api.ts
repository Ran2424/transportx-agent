import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ApiRouteServices } from './api-services.js';
import type { ServerRouter } from './router.js';

export const REPORT_PDF_MAX_HTML_BYTES = 50 * 1024 * 1024;

export function registerReportApi(router: ServerRouter<ApiRouteServices>) {
  const pdfDownloads = new Map<string, { pdf: Buffer; filename: string; expiresAt: number; timer: ReturnType<typeof setTimeout> }>();
  let renderingPdfs = 0;
  const removePdf = (id: string) => {
    const entry = pdfDownloads.get(id);
    if (entry) clearTimeout(entry.timer);
    pdfDownloads.delete(id);
  };
  const createPdf = async (req: IncomingMessage, deps: ApiRouteServices) => {
    if (renderingPdfs >= 2) { req.resume(); throw Object.assign(new Error('PDF render capacity reached'), { status: 503 }); }
    renderingPdfs++;
    try {
      const body = await deps.readBody(req);
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 300) : '';
      const html = typeof body.html === 'string' ? body.html : '';
      if (!title || !html) {
        const error = new Error('title and html required') as Error & { status?: number };
        error.status = 400;
        throw error;
      }
      if (Buffer.byteLength(html, 'utf8') > REPORT_PDF_MAX_HTML_BYTES) {
        const error = new Error('Rendered report is too large') as Error & { status?: number };
        error.status = 413;
        throw error;
      }
      const pdf = await deps.renderReportPdf(title, html);
      if (pdf.length > 32 * 1024 * 1024) throw Object.assign(new Error('Rendered PDF exceeds 32 MB'), { status: 413 });
      return { pdf, filename: `${title.replace(/\.mdx?$/i, '') || 'report'}.pdf` };
    } finally { renderingPdfs--; }
  };
  router
    .post('/api/reports/pdf', async ({ req, res, deps }) => {
      try {
        const { pdf, filename } = await createPdf(req, deps);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': String(pdf.length),
          'Content-Disposition': `attachment; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'Cache-Control': 'no-store',
        });
        res.end(pdf);
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/reports/pdf/download', async ({ req, res, deps }) => {
      try {
        const { pdf, filename } = await createPdf(req, deps);
        const now = Date.now();
        for (const [id, entry] of pdfDownloads) if (entry.expiresAt <= now) removePdf(id);
        const cachedBytes = () => [...pdfDownloads.values()].reduce((total, entry) => total + entry.pdf.length, 0);
        while (pdfDownloads.size >= 8 || cachedBytes() + pdf.length > 64 * 1024 * 1024) removePdf(pdfDownloads.keys().next().value!);
        const id = crypto.randomUUID();
        const timer = setTimeout(() => removePdf(id), 5 * 60 * 1000);
        timer.unref();
        pdfDownloads.set(id, { pdf, filename, expiresAt: now + 5 * 60 * 1000, timer });
        deps.json(res, 200, { url: `/api/reports/pdf/download/${id}` });
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .get(/^\/api\/reports\/pdf\/download\/([a-f0-9-]+)$/, ({ res, params }) => {
      const entry = pdfDownloads.get(params[0]);
      if (!entry || entry.expiresAt <= Date.now()) { res.writeHead(404); res.end(); return; }
      removePdf(params[0]);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(entry.pdf.length),
        'Content-Disposition': `attachment; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent(entry.filename)}`,
        'Cache-Control': 'no-store',
      });
      res.end(entry.pdf);
    });
}
