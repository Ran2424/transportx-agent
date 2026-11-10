const fs = require('node:fs');
const path = require('node:path');

// Add application-owned font data only in the process that renders the PDF.
export async function embedReportFonts(html: string, fontDirectory: string) {
  let css = await fs.promises.readFile(path.join(fontDirectory, 'fonts.css'), 'utf8') as string;
  for (const [url, filename] of css.matchAll(/url\("\.\/([^"\n]+)"\)/g)) {
    const font = await fs.promises.readFile(path.join(fontDirectory, filename));
    css = css.replace(url, `url("data:font/woff2;base64,${font.toString('base64')}")`);
  }
  return html.replace('<head>', `<head><style>${css}</style>`);
}
