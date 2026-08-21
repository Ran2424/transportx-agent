import { renderMarkdown } from '../../../public/markdown.js';
import i18n from '../../i18n';

const ALLOWED_TAGS = new Set(['A', 'BLOCKQUOTE', 'BR', 'BUTTON', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'IMG', 'INPUT', 'LI', 'OL', 'P', 'PRE', 'SPAN', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL']);
const ALLOWED_ATTRIBUTES = new Set(['aria-label', 'class', 'checked', 'data-citation-id', 'disabled', 'href', 'rel', 'src', 'style', 'target', 'type']);

export function renderConversationMarkdown(markdown: string, citationNumbers: Record<string, number> = {}) {
  const template = document.createElement('template');
  template.innerHTML = renderMarkdown(markdown, citationNumbers, undefined, i18n.language);
  template.content.querySelectorAll('*').forEach((node) => {
    if (!ALLOWED_TAGS.has(node.tagName)) { node.replaceWith(document.createTextNode(node.textContent || '')); return; }
    [...node.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      const safeUrl = name === 'href' ? /^(https?:|mailto:)/i.test(value) : name === 'src' ? /^(https?:|data:image\/)/i.test(value) : true;
      const validCitationId = name !== 'data-citation-id' || /^[A-Za-z0-9_.:-]{1,180}$/.test(value);
      if (name.startsWith('on') || !ALLOWED_ATTRIBUTES.has(name) || !safeUrl || !validCitationId) node.removeAttribute(attribute.name);
    });
  });
  return { __html: template.innerHTML };
}
