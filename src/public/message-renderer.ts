/**
 * Message Renderer - Renders chat messages with markdown support
 */

import { renderMarkdown, renderUserMarkdown } from './markdown.js';

type RenderedImage = {
  data: string;
  mimeType?: string;
};

type MessageContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  durationMs?: number;
};

type RenderMessage = {
  id?: string;
  content?: string | MessageContentBlock[];
  images?: RenderedImage[];
  usage?: {
    cost?: { total?: number };
    [key: string]: unknown;
  };
};

const COLLAPSIBLE_CODE_BLOCK_HEIGHT = 50;

export class MessageRenderer {
  container: HTMLElement;
  isNearBottom: boolean;

  constructor(container: HTMLElement) {
    this.container = container;
    this.isNearBottom = true;

    // Track scroll position for smart auto-scroll
    this.container.addEventListener('scroll', () => {
      const threshold = 100;
      this.isNearBottom =
        this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < threshold;
    });
  }

  clear() {
    this.container.innerHTML = '';
  }

  renderWelcome() {
    this.container.innerHTML = `
      <div class="welcome">
        <div class="welcome-icon"><img src="icons/tau-192.png" alt="τ" class="tau-icon-welcome"></div>
        <p>欢迎使用交通工作台</p>
        <p class="hint">新建一个交通任务，或从侧栏查看历史会话。</p>
        <div class="shortcuts-hint">
          <span>/ 聚焦输入框</span>
          <span>Esc 中止</span>
        </div>
      </div>
    `;
  }

  renderUserMessage(message: RenderMessage, isHistory = false) {
    // Remove welcome message if present
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message user${isHistory ? ' history' : ''}`;

    let imagesHtml = '';
    if (message.images && message.images.length > 0) {
      imagesHtml = '<div class="message-images">' +
        message.images.map(img => {
          const src = img.data.startsWith('data:') ? img.data : `data:${img.mimeType || 'image/png'};base64,${img.data}`;
          return `<img class="message-image" src="${src}" alt="附加图片" />`;
        }).join('') +
        '</div>';
    }

    div.innerHTML = `
      <div class="message-content">${imagesHtml}${renderUserMarkdown(message.content as string)}</div>
      <button class="message-copy-btn" aria-label="复制消息"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
    `;
    this._setupCopyBtn(div);
    this.container.appendChild(div);
    if (!isHistory) this.scrollToBottom();
  }

  renderAssistantMessage(message: RenderMessage, isStreaming = false, isHistory = false) {
    // Remove welcome message if present
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message assistant${isHistory ? ' history' : ''}`;
    div.dataset.messageId = message.id || 'streaming';

    let contentHtml = '';
    let usageHtml = '';
    let hasRenderableText = false;
    let hasThinkingBlock = false;

    if (typeof message.content === 'string') {
      contentHtml = isStreaming ? this.escapeHtml(message.content) : renderMarkdown(message.content);
      hasRenderableText = !!String(message.content || '').trim();
    } else if (Array.isArray(message.content)) {
      const thinkingTexts = message.content
        .filter((block) => block.type === 'thinking')
        .map((block) => block.thinking || '');
      for (const block of message.content) {
        if (block.type === 'text') {
          if (this._isThinkingEcho(block.text || '', thinkingTexts)) continue;
          contentHtml += isStreaming ? this.escapeHtml(block.text) : renderMarkdown(block.text || '');
          if (String(block.text || '').trim()) hasRenderableText = true;
        } else if (block.type === 'thinking') {
          hasThinkingBlock = true;
          contentHtml += this.renderThinkingBlock(block.thinking, block.durationMs, !isHistory);
        }
      }
    }

    // Usage/cost info
    if (message.usage && message.usage.cost) {
      const cost = message.usage.cost.total;
      if (cost && cost > 0) {
        usageHtml = `<span class="message-usage">$${cost.toFixed(4)}</span>`;
      }
    }

    const streamingClass = isStreaming ? ' streaming' : '';

    div.innerHTML = `
      <div class="message-content${streamingClass}">${contentHtml}</div>
      ${usageHtml}
      ${!isStreaming && (hasRenderableText || !hasThinkingBlock) ? '<button class="message-copy-btn" aria-label="复制消息"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' : ''}
    `;

    if (!isStreaming) {
      this._setupCopyBtn(div);
    }
    this.container.appendChild(div);
    this._setupThinkingCopyBtns(div);
    if (!isStreaming) this._setupCodeBlockCollapse(div);
    if (!isHistory) this.scrollToBottom();

    return div;
  }

  renderThinkingBlock(thinking?: string, durationMs?: number, expanded = true) {
    const id = 'thinking-' + Math.random().toString(36).slice(2, 8);
    const expandedClass = expanded ? ' expanded' : '';
    return `<div class="thinking-block${expandedClass}">
<div class="thinking-toggle${expandedClass}" onclick="var p=this.parentElement,c=document.getElementById('${id}');c.classList.toggle('expanded');this.classList.toggle('expanded');p.classList.toggle('expanded')">
	<span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
		<span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> 思考</span>
		<span class="thinking-header-right">
		  <button class="thinking-copy-btn" type="button" title="复制思考" aria-label="复制思考"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
		  <span class="thinking-duration">${this.durationLabel(durationMs)}</span>
		  <span class="thinking-status complete" aria-label="思考完成"></span>
		</span>
	</div>
	<div class="thinking-content${expandedClass}" id="${id}">${this.escapeHtml(thinking)}</div>
	</div>`;
  }

  updateStreamingThinking(messageElement: HTMLElement, thinking: string, durationMs?: number) {
    let thinkingDiv = messageElement.querySelector('.streaming-thinking');
    if (!thinkingDiv) {
      const contentDiv = messageElement.querySelector('.message-content');
      if (!contentDiv) return;
      thinkingDiv = document.createElement('div');
      thinkingDiv.className = 'thinking-block streaming-thinking expanded';
      thinkingDiv.innerHTML = `
        <div class="thinking-toggle expanded" onclick="var p=this.parentElement,c=this.nextElementSibling;c.classList.toggle('expanded');this.classList.toggle('expanded');p.classList.toggle('expanded')">
          <span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
          <span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> 思考</span>
          <span class="thinking-header-right">
            <span class="thinking-duration"></span>
          </span>
        </div>
        <div class="thinking-content expanded"></div>`;
      contentDiv.prepend(thinkingDiv);
    }
    const contentEl = thinkingDiv.querySelector('.thinking-content');
    if (contentEl) {
      contentEl.textContent = thinking;
      this.scrollToBottom();
    }
    const durationEl = thinkingDiv.querySelector<HTMLElement>('.thinking-duration');
    if (durationEl) durationEl.textContent = this.durationLabel(durationMs);
  }

  updateStreamingMessage(messageElement: HTMLElement, content: string) {
    const contentDiv = messageElement.querySelector<HTMLElement>('.message-content');
    if (!contentDiv) return;

    // Render markdown incrementally so headings, lists, inline formatting,
    // and other block elements appear live — not just after streaming ends.
    const rendered = renderMarkdown(content);
    const thinkingBlock = contentDiv.querySelector('.streaming-thinking');

    if (thinkingBlock) {
      // Keep the thinking block; update only the text portion
      let textNode = contentDiv.querySelector('.streaming-text');
      if (!textNode) {
        // First time text arrives after thinking started:
        // remove any stale text nodes that were placed directly in contentDiv
        // before the thinking block existed.
        let node = thinkingBlock.nextSibling;
        while (node) {
          const next = node.nextSibling;
          node.remove();
          node = next;
        }
        textNode = document.createElement('div');
        textNode.className = 'streaming-text';
        contentDiv.appendChild(textNode);
      }
      textNode.innerHTML = rendered;
      // Stash the raw markdown so finalizeStreamingMessage can do a clean
      // re-render without scraping textContent from already-rendered HTML.
      textNode.dataset.rawText = content;
    } else {
      contentDiv.innerHTML = rendered;
      contentDiv.dataset.rawText = content;
    }
    this.scrollToBottom();
  }

  finalizeStreamingMessage(messageElement: HTMLElement, usage: RenderMessage['usage'] | null = null, thinking = '', thinkingDurationMs?: number) {
    const contentDiv = messageElement.querySelector<HTMLElement>('.message-content');
    if (contentDiv) {
      contentDiv.classList.remove('streaming');

      // Recover the raw markdown text we stashed during streaming updates.
      // Falls back to textContent (which loses formatting markers) only if
      // the dataset is somehow missing.
      const streamingText = contentDiv.querySelector('.streaming-text');
      const rawText =
        (streamingText && streamingText.dataset.rawText) ||
        contentDiv.dataset.rawText ||
        this._extractRenderableText(contentDiv) ||
        '';
      const safeRawText = this._isThinkingEcho(rawText, [thinking]) ? '' : rawText;

      // Final render — catches edge cases like code blocks whose closing
      // fence arrived on the very last delta.
      let html = '';
      if (thinking) {
        html += this.renderThinkingBlock(thinking, thinkingDurationMs);
      }
      html += renderMarkdown(safeRawText);
      contentDiv.innerHTML = html;
    }
    this._setupThinkingCopyBtns(messageElement);

    // Add copy button after streaming finishes
    const renderableText = this._extractRenderableText(messageElement.querySelector<HTMLElement>('.message-content') || messageElement).trim();
    if (renderableText && !messageElement.querySelector('.message-copy-btn')) {
      const btn = document.createElement('button');
      btn.className = 'message-copy-btn';
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      messageElement.appendChild(btn);
      this._setupCopyBtn(messageElement);
    }
    this._setupCodeBlockCollapse(messageElement);

    // Add usage info if available
    if (usage && usage.cost) {
      const total = usage.cost.total;
      if (total && total > 0) {
        if (!messageElement.querySelector('.message-usage')) {
          const span = document.createElement('span');
          span.className = 'message-usage';
          span.textContent = `$${total.toFixed(4)}`;
          messageElement.appendChild(span);
        }
      }
    }
  }

  renderSystemMessage(text: string) {
    const div = document.createElement('div');
    div.className = 'system-message';
    div.textContent = String(text ?? '');
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  renderError(errorMessage: string) {
    const div = document.createElement('div');
    div.className = 'error-message';
    div.textContent = `⚠️ ${errorMessage}`;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  _setupCopyBtn(messageEl: HTMLElement) {
    const btn = messageEl.querySelector('.message-copy-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const content = messageEl.querySelector('.message-content');
      if (!content) return;
      const text = content.textContent;
      this._copyText(text || '').then(() => {
        btn.classList.add('copied');
        setTimeout(() => {
          btn.classList.remove('copied');
        }, 1500);
      });
    });
  }

  _setupThinkingCopyBtns(root: HTMLElement) {
    root.querySelectorAll<HTMLButtonElement>('.thinking-copy-btn').forEach((btn) => {
      if (btn.dataset.copyReady === 'true') return;
      btn.dataset.copyReady = 'true';
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        const block = btn.closest('.thinking-block');
        const content = block?.querySelector('.thinking-content');
        const text = content?.textContent || '';
        this._copyText(text).then(() => {
          btn.classList.add('copied');
          setTimeout(() => btn.classList.remove('copied'), 1500);
        });
      });
    });
  }

  _copyText(text: string) {
    if (navigator.clipboard) return navigator.clipboard.writeText(text);
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  _extractRenderableText(contentEl: HTMLElement) {
    const clone = contentEl.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.thinking-block').forEach((el) => el.remove());
    return clone.textContent || '';
  }

  _setupCodeBlockCollapse(messageEl: HTMLElement) {
    messageEl.querySelectorAll<HTMLElement>('.code-block-wrapper').forEach((wrapper) => {
      if (wrapper.dataset.collapseReady === 'true') return;
      const pre = wrapper.querySelector<HTMLElement>('pre');
      const header = wrapper.querySelector<HTMLElement>('.code-block-header');
      if (!pre || !header) return;

      requestAnimationFrame(() => {
        if (wrapper.dataset.collapseReady === 'true') return;
        if (pre.scrollHeight <= COLLAPSIBLE_CODE_BLOCK_HEIGHT) return;

        wrapper.dataset.collapseReady = 'true';
        wrapper.classList.add('collapsible', 'collapsed');
        pre.style.setProperty('--collapsed-code-height', `${COLLAPSIBLE_CODE_BLOCK_HEIGHT}px`);

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'code-collapse-btn';
        toggle.textContent = '展开';
        toggle.setAttribute('aria-expanded', 'false');
        toggle.addEventListener('click', () => {
          const collapsed = wrapper.classList.toggle('collapsed');
          toggle.textContent = collapsed ? '展开' : '收起';
          toggle.setAttribute('aria-expanded', String(!collapsed));
          if (!collapsed) this.scrollToBottom();
        });

        const copyBtn = header.querySelector('.copy-btn');
        header.insertBefore(toggle, copyBtn || null);
      });
    });
  }

  _isThinkingEcho(text: string, thinkingTexts: string[]) {
    const normalizedText = this._normalizeThinkingText(text);
    if (!normalizedText) return false;
    return thinkingTexts.some((thinking) => {
      const normalizedThinking = this._normalizeThinkingText(thinking);
      return !!normalizedThinking && normalizedText === normalizedThinking;
    });
  }

  _normalizeThinkingText(text: string) {
    return String(text || '')
      .replace(/^\s*思考\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  escapeHtml(text: unknown) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
  }

  durationLabel(durationMs?: number) {
    if (durationMs === undefined || durationMs < 0) return '';
    if (durationMs < 1000) return `${Math.max(1, Math.round(durationMs))}ms`;
    if (durationMs < 10000) return `${(durationMs / 1000).toFixed(1)}s`;
    return `${Math.round(durationMs / 1000)}s`;
  }

  scrollToBottom() {
    if (this.isNearBottom) {
      requestAnimationFrame(() => {
        this.container.scrollTop = this.container.scrollHeight;
      });
    }
  }
}
