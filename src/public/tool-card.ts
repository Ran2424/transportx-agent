/**
 * Tool Card - Renders and updates tool execution cards (collapsible)
 */

export type ToolArgs = Record<string, unknown>;

export type ToolExecution = {
  toolCallId?: string;
  toolName?: string;
  args?: ToolArgs;
  status?: string;
  output?: string;
  isError?: boolean;
  startedAt?: number;
  durationMs?: number;
};

type ToolResultBlock = {
  type?: string;
  text?: string;
  [key: string]: unknown;
};

export type ToolResult = {
  content?: ToolResultBlock[];
  [key: string]: unknown;
};

export class ToolCardRenderer {
  container: HTMLElement;
  toolCards: Map<string, HTMLElement>;

  constructor(container: HTMLElement) {
    this.container = container;
    this.toolCards = new Map(); // toolCallId -> element
  }

  createToolCard(toolExecution: ToolExecution) {
    const { toolCallId, toolName, args, status } = toolExecution;

    const card = document.createElement('div');
    const isExpanded = (status === 'streaming' || status === 'pending');
    card.className = `tool-card${isExpanded ? ' expanded' : ''}`;
    card.dataset.toolCallId = String(toolCallId || '');
    if (toolExecution.startedAt) card.dataset.startedAt = String(toolExecution.startedAt);

    const argsPreview = this.getArgsPreviewInfo(String(toolName || ''), args);
    const argsJson = this.formatJson(args);
    const isEdit = (toolName === 'edit' || toolName === 'Edit') && args && (args.oldText || args.old_text) && (args.newText || args.new_text);

    card.innerHTML = `
      <div class="tool-card-header" onclick="this.parentElement.classList.toggle('expanded'); this.parentElement.querySelector('.tool-card-body').classList.toggle('expanded'); this.querySelector('.tool-card-chevron').classList.toggle('expanded')">
        <div class="tool-header-left">
          <span class="tool-card-chevron${isExpanded ? ' expanded' : ''}"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
          <span class="tool-name">${this.escapeHtml(this.displayToolName(toolName))}</span>
          ${argsPreview ? `<span class="tool-args-preview" title="${this.escapeHtml(argsPreview.title)}">${this.escapeHtml(argsPreview.text)}</span>` : ''}
        </div>
        <div class="tool-header-right">
          <button class="tool-action-btn copy-output-btn" title="复制输出" onclick="event.stopPropagation(); var t=this.closest('.tool-card').querySelector('.tool-output'); if(!t||!t.textContent.trim())return; var s=t.textContent,b=this; (navigator.clipboard?navigator.clipboard.writeText(s):new Promise(function(r){var a=document.createElement('textarea');a.value=s;a.style.cssText='position:fixed;left:-9999px';document.body.appendChild(a);a.select();document.execCommand('copy');document.body.removeChild(a);r()})).then(function(){b.classList.add('copied');setTimeout(function(){b.classList.remove('copied')},1500)})"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
          <div class="tool-duration">${this.durationLabel(toolExecution.durationMs)}</div>
          <div class="tool-status ${status}">${this.statusLabel(status)}</div>
        </div>
      </div>
      <div class="tool-card-body${isExpanded ? ' expanded' : ''}">
        ${!isEdit && argsJson ? `<div class="tool-args">${this.escapeHtml(argsJson)}</div>` : ''}
        <div class="tool-output-wrapper">
          <div class="tool-output"></div>
        </div>
      </div>
    `;

    // Insert diff view for Edit tools
    if (isEdit) {
      const diffEl = this.renderDiff(String(args.oldText || args.old_text || ''), String(args.newText || args.new_text || ''));
      const body = card.querySelector('.tool-card-body');
      if (body) body.insertBefore(diffEl, body.firstChild);
    }

    this.container.appendChild(card);
    this.toolCards.set(String(toolCallId || ''), card);
    this.scrollToBottom();

    return card;
  }

  updateToolCard(toolExecution: ToolExecution) {
    let card = this.toolCards.get(String(toolExecution.toolCallId || ''));

    if (!card) {
      card = this.createToolCard(toolExecution);
    }

    // Update status
    const statusElement = card.querySelector('.tool-status');
    if (statusElement) {
      statusElement.className = `tool-status ${toolExecution.status}`;
      statusElement.textContent = this.statusLabel(toolExecution.status);
    }
    this.updateDuration(card, toolExecution.durationMs);

    // Auto-expand when streaming
    if (toolExecution.status === 'streaming') {
      const body = card.querySelector('.tool-card-body');
      const chevron = card.querySelector('.tool-card-chevron');
      card.classList.add('expanded');
      if (body) body.classList.add('expanded');
      if (chevron) chevron.classList.add('expanded');
    }

    // Update output
    const outputElement = card.querySelector('.tool-output');
    if (outputElement && toolExecution.output) {
      outputElement.textContent = toolExecution.output;
      this.scrollToBottom();
    }
  }

  finalizeToolCard(toolCallId: string, result: ToolResult, isError: boolean, durationMs?: number) {
    const card = this.toolCards.get(toolCallId);
    if (!card) return;

    // Update status
    const statusElement = card.querySelector('.tool-status');
    if (statusElement) {
      const status = isError ? 'error' : 'complete';
      statusElement.className = `tool-status ${status}`;
      statusElement.textContent = this.statusLabel(status);
    }
    const startedAt = Number(card.dataset.startedAt || 0);
    this.updateDuration(card, durationMs ?? (startedAt > 0 ? Date.now() - startedAt : undefined));

    // Update output with final result
    const outputElement = card.querySelector('.tool-output');
    if (outputElement && result) {
      const output = this.formatResult(result);
      outputElement.textContent = output;
    }

    // Collapse completed cards (less noise)
    if (!isError) {
      const body = card.querySelector('.tool-card-body');
      const chevron = card.querySelector('.tool-card-chevron');
      card.classList.remove('expanded');
      if (body) body.classList.remove('expanded');
      if (chevron) chevron.classList.remove('expanded');
    }
  }

  /**
   * Create a pre-collapsed card for session history using DOM methods (no innerHTML)
   */
  createHistoryCard(toolExecution: ToolExecution) {
    const { toolCallId, toolName, args } = toolExecution;

    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.toolCallId = String(toolCallId || '');
    if (toolExecution.startedAt) card.dataset.startedAt = String(toolExecution.startedAt);

    // Header
    const header = document.createElement('div');
    header.className = 'tool-card-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'tool-header-left';

    const chevron = document.createElement('span');
    chevron.className = 'tool-card-chevron';
    chevron.innerHTML = '<svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg>';
    headerLeft.appendChild(chevron);

    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = this.displayToolName(toolName);
    headerLeft.appendChild(name);

    const preview = this.getArgsPreviewInfo(String(toolName || ''), args);
    if (preview) {
      const previewEl = document.createElement('span');
      previewEl.className = 'tool-args-preview';
      previewEl.textContent = preview.text;
      previewEl.title = preview.title;
      headerLeft.appendChild(previewEl);
    }

    header.appendChild(headerLeft);

    // Right side: copy button + status
    const headerRight = document.createElement('div');
    headerRight.className = 'tool-header-right';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'tool-action-btn copy-output-btn';
    copyBtn.title = '复制输出';
    copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const output = card.querySelector('.tool-output');
      if (!output || !output.textContent.trim()) return;
      const text = output.textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(text) : new Promise<void>((r) => {
        const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); r();
      })).then(() => {
        copyBtn.classList.add('copied');
        setTimeout(() => copyBtn.classList.remove('copied'), 1500);
      });
    });
    headerRight.appendChild(copyBtn);

    const duration = document.createElement('div');
    duration.className = 'tool-duration';
    duration.textContent = this.durationLabel(toolExecution.durationMs);
    headerRight.appendChild(duration);

    const status = document.createElement('div');
    status.className = 'tool-status complete';
    status.textContent = this.statusLabel('complete');
    headerRight.appendChild(status);

    header.appendChild(headerRight);

    // Toggle expand on click
    header.addEventListener('click', () => {
      card.classList.toggle('expanded');
      body.classList.toggle('expanded');
      chevron.classList.toggle('expanded');
    });

    card.appendChild(header);

    // Body (collapsed by default)
    const body = document.createElement('div');
    body.className = 'tool-card-body';

    const isEdit = (toolName === 'edit' || toolName === 'Edit') && args && (args.oldText || args.old_text) && (args.newText || args.new_text);

    if (isEdit) {
      body.appendChild(this.renderDiff(String(args.oldText || args.old_text || ''), String(args.newText || args.new_text || '')));
    } else {
      const argsJson = this.formatJson(args);
      if (argsJson) {
        const argsEl = document.createElement('div');
        argsEl.className = 'tool-args';
        argsEl.textContent = argsJson;
        body.appendChild(argsEl);
      }
    }

    const outputEl = document.createElement('div');
    outputEl.className = 'tool-output';
    body.appendChild(outputEl);

    card.appendChild(body);

    this.container.appendChild(card);
    this.toolCards.set(String(toolCallId || ''), card);

    return card;
  }

  updateDuration(card: HTMLElement, durationMs?: number) {
    const el = card.querySelector<HTMLElement>('.tool-duration');
    if (!el) return;
    el.textContent = this.durationLabel(durationMs);
    el.classList.toggle('empty', durationMs === undefined || durationMs < 0);
  }

  /**
   * Add result to a history card (stays collapsed)
   */
  addHistoryResult(toolCallId: string, result: ToolResult, isError: boolean) {
    const card = this.toolCards.get(toolCallId);
    if (!card) return;

    if (isError) {
      const statusEl = card.querySelector('.tool-status');
      if (statusEl) {
        statusEl.className = 'tool-status error';
        statusEl.textContent = this.statusLabel('error');
      }
    }

    const outputElement = card.querySelector('.tool-output');
    if (outputElement && result) {
      outputElement.textContent = this.formatResult(result);
    }
  }

  /** Compact preview for the header line */
  getArgsPreviewInfo(toolName: string, args?: ToolArgs) {
    if (!args || Object.keys(args).length === 0) return null;

    // Show the most relevant arg inline
    if (args.path) return this.previewText(String(args.path), 72);
    if (args.command) return this.previewText(String(args.command), 82);
    if (args.query) return this.previewText(String(args.query), 64);
    if (args.url) return this.previewText(String(args.url), 72);

    // Fallback: first string value
    for (const val of Object.values(args)) {
      if (typeof val === 'string' && val.length > 0) {
        return this.previewText(val, 64);
      }
    }
    return null;
  }

  previewText(text: string, maxLength: number) {
    return {
      text: this.middleTruncate(text, maxLength),
      title: text,
    };
  }

  middleTruncate(text: string, maxLength: number) {
    if (text.length <= maxLength) return text;
    const keepStart = Math.max(12, Math.floor(maxLength * 0.34));
    const keepEnd = Math.max(18, maxLength - keepStart - 1);
    return `${text.slice(0, keepStart)}…${text.slice(text.length - keepEnd)}`;
  }

  durationLabel(durationMs?: number) {
    if (durationMs === undefined || durationMs < 0) return '';
    if (durationMs < 1000) return `${Math.max(1, Math.round(durationMs))}ms`;
    if (durationMs < 10000) return `${(durationMs / 1000).toFixed(1)}s`;
    return `${Math.round(durationMs / 1000)}s`;
  }

  formatJson(obj?: ToolArgs) {
    if (!obj) return '';
    try {
      if (Object.keys(obj).length === 0) return '';
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(obj);
    }
  }

  statusLabel(status?: string) {
    const labels: Record<string, string> = {
      pending: '等待中',
      streaming: '执行中',
      complete: '已完成',
      error: '出错',
    };
    return labels[String(status || '')] || String(status || '');
  }

  displayToolName(toolName?: string) {
    const labels: Record<string, string> = {
      read: '读取',
      bash: '命令',
      edit: '编辑',
      write: '创建',
    };
    const key = String(toolName || '').toLowerCase();
    return labels[key] || String(toolName || '');
  }

  /** Render a simple inline diff for Edit tool */
  renderDiff(oldText: string, newText: string) {
    const container = document.createElement('div');
    container.className = 'tool-diff';

    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    // Removed lines
    for (const line of oldLines) {
      const el = document.createElement('div');
      el.className = 'diff-line diff-removed';
      el.textContent = '- ' + line;
      container.appendChild(el);
    }

    // Added lines
    for (const line of newLines) {
      const el = document.createElement('div');
      el.className = 'diff-line diff-added';
      el.textContent = '+ ' + line;
      container.appendChild(el);
    }

    return container;
  }

  formatResult(result: ToolResult) {
    if (!result) return '';

    if (result.content && Array.isArray(result.content)) {
      return result.content
        .map((block) => {
          if (block.type === 'text') return block.text;
          return JSON.stringify(block);
        })
        .join('\n');
    }

    return JSON.stringify(result, null, 2);
  }

  escapeHtml(text: unknown) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
  }

  scrollToBottom() {
    if (this.container) {
      const threshold = 100;
      const isNear =
        this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < threshold;
      if (isNear) {
        requestAnimationFrame(() => {
          this.container.scrollTop = this.container.scrollHeight;
        });
      }
    }
  }

  expandAll() {
    this.toolCards.forEach(card => {
      card.classList.add('expanded');
      card.querySelector('.tool-card-body')?.classList.add('expanded');
      card.querySelector('.tool-card-chevron')?.classList.add('expanded');
    });
  }

  collapseAll() {
    this.toolCards.forEach(card => {
      card.classList.remove('expanded');
      card.querySelector('.tool-card-body')?.classList.remove('expanded');
      card.querySelector('.tool-card-chevron')?.classList.remove('expanded');
    });
  }

  clear() {
    this.toolCards.forEach((card) => card.remove());
    this.toolCards.clear();
  }
}
