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
  source?: { media_type?: string; data?: string };
  media_type?: string;
  [key: string]: unknown;
};

export type ToolResult = {
  content?: ToolResultBlock[];
  details?: unknown;
  [key: string]: unknown;
};

type ToolCardOptions = {
  getSessionId?: () => string | null;
};

const IMAGE_PATH_RE = /((?:~|\/)[^\n\r"'<>`]*?\.(?:png|jpe?g|gif|webp|svg|ico))(?:[?#][^\s"'<>`]*)?/gi;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|ico)$/i;
const MAX_IMAGE_PREVIEWS = 3;
const MAX_TOOL_OUTPUT_CHARS = 6000;
const MAX_TOOL_FIELD_CHARS = 1200;
const ENCODED_IMAGE_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;
const BASE64ISH_RE = /^[A-Za-z0-9+/=\s]+$/;

export function formatToolResultText(result: unknown) {
  if (!result) return '';

  const r = result as ToolResult;
  if (r.content && Array.isArray(r.content)) {
    return limitToolOutput(r.content.map(formatToolResultBlock).join('\n'));
  }

  return limitToolOutput(safeToolStringify(result));
}

function formatToolResultBlock(block: ToolResultBlock) {
  if (!block) return '';
  if (block.type === 'text') return sanitizeToolText(block.text || '');
  if (block.type === 'image') {
    const mediaType = block.source?.media_type || block.media_type || 'image';
    return `[图片内容已省略：${mediaType}]`;
  }
  return safeToolStringify(block);
}

function sanitizeToolText(text: string) {
  const raw = String(text || '');
  if (isEncodedImagePayload(raw)) return `[图片/二进制内容已省略：${raw.length.toLocaleString()} 字符]`;
  if (raw.length <= MAX_TOOL_FIELD_CHARS) return raw;
  return `${raw.slice(0, MAX_TOOL_FIELD_CHARS)}\n\n[输出过长，已截断 ${raw.length.toLocaleString()} 字符，避免页面卡顿]`;
}

function isEncodedImagePayload(value: string) {
  const text = String(value || '').trim();
  if (text.length < 2048) return false;
  if (ENCODED_IMAGE_RE.test(text)) return true;
  const compact = text.replace(/\s+/g, '');
  return compact.length > 2048 && BASE64ISH_RE.test(compact);
}

function safeToolStringify(value: unknown) {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'string') return sanitizeToolText(val);
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    }, 2);
  } catch {
    return sanitizeToolText(String(value));
  }
}

function limitToolOutput(text: string) {
  const raw = String(text || '');
  if (raw.length <= MAX_TOOL_OUTPUT_CHARS) return raw;
  return `${raw.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[工具输出过长，已截断 ${raw.length.toLocaleString()} 字符]`;
}

export class ToolCardRenderer {
  container: HTMLElement;
  toolCards: Map<string, HTMLElement>;
  getSessionId: () => string | null;

  constructor(container: HTMLElement, options: ToolCardOptions = {}) {
    this.container = container;
    this.toolCards = new Map(); // toolCallId -> element
    this.getSessionId = options.getSessionId || (() => null);
  }

  createToolCard(toolExecution: ToolExecution) {
    const { toolCallId, toolName, args, status } = toolExecution;

    const card = document.createElement('div');
    const isExpanded = (status === 'streaming' || status === 'pending');
    card.className = `tool-card${isExpanded ? ' expanded' : ''}`;
    card.dataset.toolCallId = String(toolCallId || '');
    card.dataset.toolName = String(toolName || '');
    this.storeArgs(card, args);
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
      this.renderImagePreviews(card, toolExecution.output);
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
      this.renderImagePreviews(card, output);
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

  setVisualizationSummary(toolCallId: string, summary: { id: string; title: string; revision: number; layers: number; sources: number }) {
    const card = this.toolCards.get(toolCallId);
    if (!card) return;
    const body = card.querySelector<HTMLElement>('.tool-card-body');
    if (!body) return;
    card.classList.add('has-visualization');
    card.querySelector('.tool-visualization-summary')?.remove();
    const panel = document.createElement('div');
    panel.className = 'tool-visualization-summary';
    const text = document.createElement('span');
    text.textContent = `${summary.title} · ${summary.layers} 个图层 · ${summary.sources} 个数据源 · revision ${summary.revision}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '打开地图';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      document.dispatchEvent(new CustomEvent('tau:open-visualization', { detail: { visualizationId: summary.id } }));
    });
    panel.append(text, button);
    body.prepend(panel);
  }

  /**
   * Create a pre-collapsed card for session history using DOM methods (no innerHTML)
   */
  createHistoryCard(toolExecution: ToolExecution) {
    const { toolCallId, toolName, args } = toolExecution;

    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.toolCallId = String(toolCallId || '');
    card.dataset.toolName = String(toolName || '');
    this.storeArgs(card, args);
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
      const output = this.formatResult(result);
      outputElement.textContent = output;
      this.renderImagePreviews(card, output);
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
    if (args.title) return this.previewText(String(args.title), 64);
    if (args.action) return this.previewText(String(args.action), 64);

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
      tau_task: '任务状态',
      tau_ask_user: '用户交互',
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
    return formatToolResultText(result);
  }

  renderImagePreviews(card: HTMLElement, output: string) {
    const wrapper = card.querySelector('.tool-output-wrapper') || card.querySelector('.tool-card-body');
    if (!wrapper) return;

    wrapper.querySelector('.tool-image-previews')?.remove();

    const sessionId = this.getSessionId();
    if (!sessionId) return;

    const args = this.readStoredArgs(card);
    const paths = this.collectImagePaths(output, args);
    if (paths.length === 0) return;

    const list = document.createElement('div');
    list.className = 'tool-image-previews';

    for (const imagePath of paths.slice(0, MAX_IMAGE_PREVIEWS)) {
      const params = new URLSearchParams({ sessionId, path: imagePath });
      const url = `/api/file/preview?${params.toString()}`;
      const link = document.createElement('a');
      link.className = 'tool-image-preview';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = imagePath;

      const img = document.createElement('img');
      img.src = url;
      img.loading = 'lazy';
      img.alt = `工具图片预览：${this.basename(imagePath)}`;
      img.onerror = () => {
        link.remove();
        if (!list.children.length) list.remove();
      };

      const caption = document.createElement('span');
      caption.className = 'tool-image-caption';
      caption.textContent = this.basename(imagePath);

      link.appendChild(img);
      link.appendChild(caption);
      list.appendChild(link);
    }

    wrapper.appendChild(list);
  }

  collectImagePaths(output: string, args?: ToolArgs) {
    const paths: string[] = [];
    const seen = new Set<string>();
    const visitText = (text: string) => {
      IMAGE_PATH_RE.lastIndex = 0;
      for (const match of text.matchAll(IMAGE_PATH_RE)) {
        this.addImagePath(paths, seen, match[1]);
      }
    };

    visitText(output || '');
    for (const value of this.argStrings(args)) visitText(value);

    return paths;
  }

  addImagePath(paths: string[], seen: Set<string>, rawPath: string) {
    const imagePath = this.cleanImagePath(rawPath);
    if (!imagePath || !IMAGE_EXT_RE.test(imagePath) || seen.has(imagePath)) return;
    seen.add(imagePath);
    paths.push(imagePath);
  }

  cleanImagePath(rawPath: string) {
    return String(rawPath || '')
      .trim()
      .replace(/^[`'"\[(（]+/, '')
      .replace(/[`'",，。；;:)）\]]+$/, '');
  }

  argStrings(value: unknown): string[] {
    if (!value) return [];
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap((item) => this.argStrings(item));
    if (typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap((item) => this.argStrings(item));
    return [];
  }

  storeArgs(card: HTMLElement, args?: ToolArgs) {
    if (!args) return;
    try {
      card.dataset.toolArgs = JSON.stringify(args);
    } catch {
      delete card.dataset.toolArgs;
    }
  }

  readStoredArgs(card: HTMLElement): ToolArgs | undefined {
    if (!card.dataset.toolArgs) return undefined;
    try {
      return JSON.parse(card.dataset.toolArgs) as ToolArgs;
    } catch {
      return undefined;
    }
  }

  basename(filePath: string) {
    return this.cleanImagePath(filePath).split('/').pop() || filePath;
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
