import { renderMarkdown } from '../../../public/markdown.js';
import { compileCitations } from '../../../contracts/citation-compiler.js';
import type { CitationEnvelope } from '../../../contracts/citation.js';
import { documentHeadings, documentPath, type DocumentView } from './document-state';
import { citationResourceUrl } from '../conversation/citation-resource';
import i18n from '../../i18n';

function reportImageUrl(url: string, view: DocumentView, citations: CitationEnvelope | null) {
  const value = url.trim().replace(/^<(.+)>$/, '$1');
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return value;
  const separator = view.path.replaceAll('\\', '/').lastIndexOf('/');
  const directory = separator >= 0 ? view.path.slice(0, separator) : '.';
  const path = documentPath(value, directory);
  const resource = citations?.resources.find((item) => item.kind === 'image' && item.scope === view.resource?.scope && documentPath(item.relativePath, '') === documentPath(path, ''));
  if (resource) return `${window.location.origin}${citationResourceUrl(view.sessionId, resource.resourceId)}?sha256=${resource.sha256}`;
  // Knowledge assets are outside the session root; never reinterpret them as session files.
  if (view.resource?.scope === 'knowledge') return '';
  return `${window.location.origin}/api/file/preview?${new URLSearchParams({ sessionId: view.sessionId, path })}`;
}

export async function renderReport(source: string, view: DocumentView, citations: CitationEnvelope | null) {
  const compiled = citations ? compileCitations(source, citations, 'gbt7714-numeric') : undefined;
  const prefix = `REPORT${crypto.randomUUID().replaceAll('-', '')}TOKEN`;
  const replacements: Array<{ token: string; value: string; kind: 'mermaid' | 'html' }> = [];
  const token = (value: string, kind: 'mermaid' | 'html') => {
    const key = `${prefix}${replacements.length}`;
    replacements.push({ token: key, value, kind });
    return key;
  };
  // Protect code before parsing math; Mermaid source is never treated as trusted HTML.
  let markdown = (compiled?.markdown ?? source).replace(/```([^\n]*)\n([\s\S]*?)```/g, (block, language, body) => token(language.trim().toLowerCase() === 'mermaid' ? body.trim() : renderMarkdown(block), language.trim().toLowerCase() === 'mermaid' ? 'mermaid' : 'html'));
  const { renderToString } = await import('katex');
  const math = (expression: string, displayMode: boolean) => token(renderToString(expression.trim(), { displayMode, throwOnError: false, trust: false }), 'html');
  markdown = markdown.replace(/\$\$([\s\S]+?)\$\$/g, (_, expression) => math(expression, true));
  markdown = markdown.replace(/(^|[^\\])\$([^$\n]+)\$/g, (_, before, expression) => `${before}${math(expression, false)}`);
  let html = renderMarkdown(markdown, compiled?.numbers, (url) => reportImageUrl(url, view, citations), i18n.language);
  for (const replacement of replacements) {
    let value = replacement.value;
    if (replacement.kind === 'mermaid') {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', suppressErrorRendering: true });
        value = `<div class="file-preview-mermaid">${(await mermaid.render(`chart-${replacement.token}`, value)).svg}</div>`;
      } catch {
        const pre = document.createElement('pre');
        pre.className = 'file-preview-plain-code';
        pre.textContent = value;
        value = pre.outerHTML;
      }
    }
    html = html.replaceAll(`<p>${replacement.token}</p>`, replacement.token).split(replacement.token).join(value);
  }
  const template = document.createElement('template');
  template.innerHTML = html;
  const elements = [...template.content.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')];
  const headings = documentHeadings(elements.map((node) => ({ text: node.textContent || '', level: Number(node.tagName[1]) })));
  elements.forEach((node, index) => { node.dataset.documentHeading = headings[index].id; });
  return { html: template.innerHTML, headings };
}
