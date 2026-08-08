const crypto = require('node:crypto');

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function documentHtml(title: string, reportHtml: string) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm 20mm; }
  * { box-sizing: border-box; }
  html { color: #242321; background: #fff; font-family: "Songti SC", "Noto Serif CJK SC", "Microsoft YaHei", sans-serif; }
  body { margin: 0; font-size: 10.5pt; line-height: 1.75; }
  article { max-width: none; margin: 0; }
  h1, h2, h3, h4 { break-after: avoid; margin: 1.45em 0 .55em; line-height: 1.3; color: #171614; }
  h1 { margin-top: 0; font-size: 22pt; } h2 { font-size: 16pt; } h3 { font-size: 13pt; } h4 { font-size: 11pt; }
  p, ul, ol, blockquote { margin: 0 0 .85em; }
  li { break-inside: avoid; }
  blockquote { padding: .55em 1em; border-left: 2px solid #bd6842; color: #5c5854; }
  code { padding: .12em .35em; border-radius: 3px; background: #f3f0eb; font: 8.5pt/1.45 ui-monospace, monospace; }
  pre { overflow: hidden; padding: 10px; border: 1px solid #ddd7cf; background: #f7f5f1; white-space: pre-wrap; }
  pre code { padding: 0; background: transparent; }
  .table-wrapper { margin: 1em 0; overflow: visible; }
  table { width: 100%; border-collapse: collapse; font-size: 8pt; break-inside: auto; }
  tr { break-inside: avoid; } th, td { padding: 5px 6px; border: 1px solid #d8d2ca; text-align: left; vertical-align: top; }
  th { background: #f3f0eb; font-weight: 650; }
  img, svg { display: block; max-width: 100%; height: auto; margin: .8em auto; break-inside: avoid; }
  .citation-marker { display: inline-flex; min-width: 1.5em; height: 1.5em; align-items: center; justify-content: center; padding: 0 .3em; border: 1px solid #d8c8bc; border-radius: 4px; color: #aa5735; font-size: 7.5pt; vertical-align: .2em; }
  .citation-unavailable { color: #a33; font-size: 8pt; }
  hr { margin: 1.5em 0; border: 0; border-top: 1px solid #d8d2ca; }
</style>
</head>
<body>${reportHtml}</body>
</html>`;
}

export async function renderReportPdf(title: string, reportHtml: string) {
  const html = documentHtml(title, reportHtml);
  if (process.env.TAU_DESKTOP === '1' && typeof process.send === 'function') {
    const id = crypto.randomUUID();
    return new Promise<Buffer>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Desktop PDF rendering timed out')), 30_000);
      const onMessage = (message: unknown) => {
        const response = message as { type?: string; id?: string; ok?: boolean; data?: string; error?: string };
        if (response?.type !== 'transportx-pdf-response' || response.id !== id) return;
        finish(response.ok && response.data ? undefined : new Error(response.error || 'Desktop PDF rendering failed'), response.data);
      };
      const finish = (error?: Error, data?: string) => {
        clearTimeout(timeout);
        process.off('message', onMessage);
        if (error) reject(error); else resolve(Buffer.from(data!, 'base64'));
      };
      process.on('message', onMessage);
      process.send!({ type: 'transportx-pdf-request', id, title, html });
    });
  }
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ channel: process.env.TAU_BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => {
      const url = route.request().url();
      return /^(?:about:|data:)/.test(url) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;padding:0 16mm;color:#999;font-size:7px;text-align:right"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margin: { top: '18mm', right: '16mm', bottom: '20mm', left: '16mm' },
    });
    await context.close();
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
