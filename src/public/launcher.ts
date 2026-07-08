/**
 * Launcher — project directory picker with visual bubbles
 */

type LauncherProject = {
  name: string;
  path: string;
  sessionCount?: number;
  lastActive?: number | null;
  active?: boolean;
};

export class Launcher {
  container: HTMLElement;
  onLaunch: (projectPath: string) => void | Promise<void>;
  projects: LauncherProject[];

  constructor(container: HTMLElement, onLaunch: (projectPath: string) => void | Promise<void>) {
    this.container = container;
    this.onLaunch = onLaunch;
    this.projects = [];
  }

  async load() {
    this.container.innerHTML = '<div class="launcher-loading">正在加载项目...</div>';
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      this.projects = data.projects || [];
      this.render();
    } catch (e) {
      this.container.innerHTML = '<div class="launcher-loading">项目加载失败</div>';
    }
  }

  render() {
    if (!this.projects.length) {
      this.container.innerHTML = `
        <div class="launcher-empty">
          <p>尚未配置项目目录。</p>
          <p class="hint">请在 <code>~/.pi/agent/settings.json</code> 中添加 <code>"tau": { "projectsDir": "~/Projects" }</code></p>
        </div>`;
      return;
    }

    // Find max session count for relative sizing
    const maxSessions = Math.max(1, ...this.projects.map(p => p.sessionCount || 0));
    const now = Date.now();

    // Sort: active first, then by recency
    const sorted = [...this.projects].sort((a, b) => {
      if (a.active && !b.active) return -1;
      if (!a.active && b.active) return 1;
      return (b.lastActive || 0) - (a.lastActive || 0);
    });

    const bubbles = sorted.map(p => {
      // Size: scale between 0.7 and 1.3 based on session count
      const sizeRatio = 0.7 + ((p.sessionCount || 0) / maxSessions) * 0.6;

      // Recency: how fresh is this project (0 = ancient, 1 = today)
      let freshness = 0;
      if (p.lastActive) {
        const ageMs = now - p.lastActive;
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        freshness = Math.max(0, 1 - (ageDays / 30)); // fades over 30 days
      }

      return `
        <button class="launcher-bubble${p.active ? ' active' : ''}"
                data-path="${this.escAttr(p.path)}"
                style="--size: ${sizeRatio}; --freshness: ${freshness.toFixed(2)}"
                title="${this.escAttr(p.path)}${p.active ? '（运行中）' : ''}${p.sessionCount ? ` • ${p.sessionCount} 个会话` : ''}">
          <span class="launcher-bubble-name">${this.escHtml(p.name)}</span>
          ${p.active ? '<span class="launcher-bubble-dot"></span>' : ''}
        </button>`;
    }).join('');

    this.container.innerHTML = `
      <div class="launcher-content">
        <div class="launcher-title">项目</div>
        <div class="launcher-grid">${bubbles}</div>
      </div>`;

    // Bind click handlers
    this.container.querySelectorAll('.launcher-bubble').forEach(btn => {
      btn.addEventListener('click', () => {
        const projectPath = btn.dataset.path;
        if (projectPath) this.onLaunch(projectPath);
      });
    });
  }

  escHtml(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  escAttr(s: string) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }
}
