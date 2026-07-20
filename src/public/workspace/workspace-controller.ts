import { FileBrowser } from '../file-browser.js';
import type { WorkspaceView } from './workspace-types.js';

type SessionResourceSkill = { name?: string; description?: string; path?: string; scope?: string };
type SessionResourceTool = { name?: string; label?: string; description?: string; usedCount?: number; lastPreview?: string };

type WorkspaceElements = {
  sidebar: HTMLElement;
  toggle: HTMLElement;
  close: HTMLElement;
  up: HTMLElement;
  tabs: HTMLElement;
  fileList: HTMLElement;
  resourceList: HTMLElement;
  path: HTMLElement;
  finder: HTMLElement;
  fileActions: HTMLElement[];
};

type WorkspaceOptions = {
  elements: WorkspaceElements;
  messageInput: HTMLElement;
  onFileSelected(filePath: string): void;
  getSessionId(): string | null;
};

const BUILTIN_VIEWS = new Set(['files', 'skills', 'tools']);

export class WorkspaceController {
  private views = new Map<string, WorkspaceView>();
  private activeView = localStorage.getItem('tau-resource-sidebar-view') || 'files';
  private fileBrowser: FileBrowser;
  private started = false;

  constructor(private options: WorkspaceOptions) {
    const { elements } = options;
    this.fileBrowser = new FileBrowser(
      elements.fileList,
      elements.path,
      options.messageInput,
      options.onFileSelected,
      options.getSessionId,
    );
    elements.tabs.querySelectorAll<HTMLButtonElement>('.file-sidebar-tab').forEach((button) => {
      button.addEventListener('click', () => this.setView(button.dataset.resourceView || 'files'));
    });
    elements.toggle.addEventListener('click', () => {
      const collapsed = elements.sidebar.classList.toggle('collapsed');
      if (!collapsed) this.loadCurrentView();
      localStorage.setItem('tau-file-sidebar', collapsed ? 'closed' : 'open');
    });
    elements.close.addEventListener('click', () => this.close());
    elements.up.addEventListener('click', () => {
      const parent = this.fileBrowser.getParentPath();
      if (parent) this.fileBrowser.load(parent);
    });
    elements.finder.addEventListener('click', () => this.openCurrentPath());
    this.loadPlatformFinderName();
  }

  registerView(view: WorkspaceView) {
    if (this.started) throw new Error('Workspace views must be registered before start()');
    if (BUILTIN_VIEWS.has(view.id) || this.views.has(view.id)) throw new Error(`Duplicate workspace view: ${view.id}`);
    this.views.set(view.id, view);
  }

  start() {
    this.started = true;
    if (localStorage.getItem('tau-file-sidebar') === 'open') {
      this.options.elements.sidebar.classList.remove('collapsed');
    }
    this.setView(this.activeView);
  }

  setView(viewId: string) {
    const next = BUILTIN_VIEWS.has(viewId) || this.views.has(viewId) ? viewId : 'files';
    this.activeView = next;
    localStorage.setItem('tau-resource-sidebar-view', next);
    const { elements } = this.options;
    elements.tabs.querySelectorAll<HTMLButtonElement>('.file-sidebar-tab').forEach((button) => {
      button.classList.toggle('active', button.dataset.resourceView === next);
    });
    const showingFiles = next === 'files';
    const showingResources = next === 'skills' || next === 'tools';
    elements.fileList.classList.toggle('hidden', !showingFiles);
    elements.resourceList.classList.toggle('hidden', !showingResources);
    elements.path.classList.toggle('hidden', !showingFiles);
    elements.fileActions.forEach((element) => element.classList.toggle('hidden', !showingFiles));
    for (const view of this.views.values()) {
      const active = view.id === next;
      view.panel.classList.toggle('hidden', !active);
      if (view.sidebarClass) elements.sidebar.classList.toggle(view.sidebarClass, active);
    }
    if (!elements.sidebar.classList.contains('collapsed')) this.loadCurrentView();
  }

  openView(viewId: string) {
    if (!this.views.has(viewId) && !BUILTIN_VIEWS.has(viewId)) return;
    const wasCollapsed = this.options.elements.sidebar.classList.contains('collapsed');
    this.setView(viewId);
    this.options.elements.sidebar.classList.remove('collapsed');
    localStorage.setItem('tau-file-sidebar', 'open');
    if (wasCollapsed) this.loadCurrentView();
    const view = this.views.get(viewId);
    if (view?.resize) requestAnimationFrame(() => view.resize?.());
  }

  close() {
    this.options.elements.sidebar.classList.add('collapsed');
    localStorage.setItem('tau-file-sidebar', 'closed');
  }

  refreshResourceViewIfVisible(view?: 'skills' | 'tools') {
    if (this.options.elements.sidebar.classList.contains('collapsed')) return;
    if (view && this.activeView !== view) return;
    if (this.activeView === 'skills' || this.activeView === 'tools') void this.loadSessionResources(this.activeView);
  }

  refreshForSessionChange() {
    if (this.options.elements.sidebar.classList.contains('collapsed')) return;
    this.fileBrowser.currentPath = null;
    this.loadCurrentView();
  }

  private loadCurrentView() {
    if (this.activeView === 'files') this.fileBrowser.load();
    else if (this.activeView === 'skills' || this.activeView === 'tools') void this.loadSessionResources(this.activeView);
    else void this.views.get(this.activeView)?.activate();
  }

  private async loadSessionResources(view: 'skills' | 'tools') {
    const { resourceList } = this.options.elements;
    const sessionId = this.options.getSessionId();
    resourceList.innerHTML = '<div class="resource-loading">正在加载...</div>';
    if (!sessionId) {
      resourceList.innerHTML = '<div class="resource-loading">请选择一个交通任务</div>';
      return;
    }
    try {
      const response = await fetch(`/api/session-resources?sessionId=${encodeURIComponent(sessionId)}`);
      const data = await response.json();
      if (view !== this.activeView) return;
      if (!response.ok || data.error) {
        resourceList.innerHTML = `<div class="resource-loading">${escapeHtml(data.error || '加载失败')}</div>`;
        return;
      }
      if (view === 'skills') this.renderSkills(data.skills || [], data.commandsError || '');
      else this.renderTools(data.tools || []);
    } catch {
      resourceList.innerHTML = '<div class="resource-loading">加载失败</div>';
    }
  }

  private renderSkills(skills: SessionResourceSkill[], commandsError = '') {
    const { resourceList } = this.options.elements;
    if (!skills.length) {
      resourceList.innerHTML = `<div class="resource-loading">${commandsError ? '技能加载失败' : '当前会话没有可见技能'}</div>`;
      return;
    }
    resourceList.innerHTML = skills.map((skill) => {
      const name = String(skill.name || '');
      const path = String(skill.path || '');
      const scope = scopeLabel(skill.scope);
      return `
        <div class="resource-item" title="${escapeHtml(path || name)}">
          <span class="resource-icon skill">技</span>
          <span class="resource-main">
            <span class="resource-title">/${escapeHtml(name)}</span>
            ${skill.description ? `<span class="resource-desc">${escapeHtml(skill.description)}</span>` : ''}
            ${path ? `<span class="resource-path">${escapeHtml(path)}</span>` : ''}
          </span>
          ${scope ? `<span class="resource-badge">${escapeHtml(scope)}</span>` : ''}
        </div>`;
    }).join('');
  }

  private renderTools(tools: SessionResourceTool[]) {
    const { resourceList } = this.options.elements;
    if (!tools.length) {
      resourceList.innerHTML = '<div class="resource-loading">当前会话没有可见工具</div>';
      return;
    }
    resourceList.innerHTML = tools.map((tool) => {
      const name = String(tool.name || '');
      const label = String(tool.label || name);
      const usedCount = Number(tool.usedCount || 0);
      const preview = String(tool.lastPreview || '');
      return `
        <div class="resource-item" title="${escapeHtml(preview || tool.description || name)}">
          <span class="resource-icon tool">工</span>
          <span class="resource-main">
            <span class="resource-title">${escapeHtml(label)}<span class="resource-code">${escapeHtml(name)}</span></span>
            ${tool.description ? `<span class="resource-desc">${escapeHtml(tool.description)}</span>` : ''}
            ${preview ? `<span class="resource-path">${escapeHtml(truncateMiddle(preview, 48))}</span>` : ''}
          </span>
          <span class="resource-badge">${usedCount > 0 ? `${usedCount} 次` : '内置'}</span>
        </div>`;
    }).join('');
  }

  private async openCurrentPath() {
    const sessionId = this.options.getSessionId();
    if (!this.fileBrowser.currentPath || !sessionId) return;
    await fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: this.fileBrowser.currentPath, sessionId }),
    });
  }

  private loadPlatformFinderName() {
    fetch('/api/health').then((response) => response.json()).then((data) => {
      const names: Record<string, string> = { win32: 'Explorer', darwin: 'Finder', linux: '文件管理器' };
      this.options.elements.finder.title = `在 ${names[data.platform] || '文件管理器'} 中打开`;
    }).catch(() => {});
  }
}

function scopeLabel(scope?: string) {
  const labels: Record<string, string> = { user: '用户', project: '项目', temporary: '临时' };
  return labels[String(scope || '')] || String(scope || '');
}

function truncateMiddle(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  const start = Math.max(10, Math.floor(maxLength * 0.4));
  const end = Math.max(14, maxLength - start - 1);
  return `${text.slice(0, start)}…${text.slice(text.length - end)}`;
}

function escapeHtml(text: string) {
  const element = document.createElement('div');
  element.textContent = text;
  return element.innerHTML;
}
