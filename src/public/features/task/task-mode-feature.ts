import type { WebFeature, FeatureSessionContext, FeatureToolResultContext } from '../feature-registry.js';
import { SessionTaskStore } from './session-task-store.js';
import { TaskCardRenderer } from './task-card-renderer.js';
import { parseTaskStateEntry, parseTaskToolResult } from './task-protocol.js';

type TaskModeFeatureOptions = {
  container: HTMLElement;
  toggle: HTMLButtonElement;
  panel: HTMLElement;
  panelToggle: HTMLButtonElement;
  panelClose: HTMLButtonElement;
  dragHandle: HTMLElement;
  onModeChange(enabled: boolean): Promise<boolean>;
};

const PANEL_POSITION_KEY = 'tau-task-board-position';

export class TaskModeFeature implements WebFeature {
  readonly id = 'task-mode';
  private store = new SessionTaskStore();
  private renderer: TaskCardRenderer;
  private toggle: HTMLButtonElement;
  private onModeChange: TaskModeFeatureOptions['onModeChange'];
  private canControl = false;
  private enabled = false;
  private busy = false;
  private sessionKey: string | null = null;

  constructor(options: TaskModeFeatureOptions) {
    this.renderer = new TaskCardRenderer(options.container);
    this.renderer.clear();
    this.toggle = options.toggle;
    this.onModeChange = options.onModeChange;
    this.toggle.addEventListener('click', () => void this.changeMode());
    options.panelToggle.addEventListener('click', () => {
      this.setPanelOpen(options, options.panel.classList.contains('collapsed'));
    });
    options.panelClose.addEventListener('click', () => this.setPanelOpen(options, false));
    this.enablePanelDragging(options);
    this.setPanelOpen(options, localStorage.getItem('tau-task-board') === 'open', false);
    this.updateToggle();
  }

  setSession(context: FeatureSessionContext, reset: boolean) {
    this.sessionKey = context.sessionKey;
    this.canControl = !!context.resourceSessionId;
    if (reset && context.sessionKey) this.store.reset(context.sessionKey);
    if (reset || !context.sessionKey) this.enabled = false;
    this.renderCurrentTask();
    this.updateToggle();
  }

  handleToolResult(context: FeatureToolResultContext) {
    if (context.toolName !== 'tau_task' && context.toolName !== 'tau_ask_user') return null;
    const task = parseTaskToolResult(context.result);
    if (!task || !this.store.accept(context.sessionKey, task)) return null;
    if (context.sessionKey === this.sessionKey) this.renderer.render(task);
    return {
      kind: 'task' as const,
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      revision: task.revision,
    };
  }

  restoreModeFromEntries(entries: unknown[]) {
    this.enabled = false;
    for (const entry of entries) {
      const state = parseTaskStateEntry(entry);
      if (!state) continue;
      this.enabled = state.enabled;
      if (state.task && this.sessionKey) this.store.accept(this.sessionKey, state.task);
    }
    this.renderCurrentTask();
    this.updateToggle();
  }

  handleEntry(entry: unknown) {
    const state = parseTaskStateEntry(entry);
    if (!state) return false;
    this.enabled = state.enabled;
    if (state.task && this.sessionKey && this.store.accept(this.sessionKey, state.task)) this.renderer.render(state.task);
    this.updateToggle();
    return true;
  }

  private async changeMode() {
    if (!this.canControl || this.busy) return;
    const next = !this.enabled;
    this.busy = true;
    this.updateToggle();
    try {
      if (await this.onModeChange(next)) this.enabled = next;
    } finally {
      this.busy = false;
      this.updateToggle();
    }
  }

  private renderCurrentTask() {
    const task = this.sessionKey ? this.store.latest(this.sessionKey) : undefined;
    if (task) this.renderer.render(task);
    else this.renderer.clear();
  }

  private setPanelOpen(options: TaskModeFeatureOptions, open: boolean, persist = true) {
    options.panel.classList.toggle('collapsed', !open);
    options.panelToggle.classList.toggle('active', open);
    options.panelToggle.setAttribute('aria-expanded', String(open));
    options.panelToggle.setAttribute('aria-label', open ? '关闭任务面板' : '打开任务面板');
    options.panelToggle.title = open ? '关闭任务面板' : '打开任务面板';
    if (persist) localStorage.setItem('tau-task-board', open ? 'open' : 'closed');
    if (open) requestAnimationFrame(() => this.restorePanelPosition(options.panel));
  }

  private enablePanelDragging(options: TaskModeFeatureOptions) {
    const { panel, dragHandle } = options;
    dragHandle.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0 || (event.target as Element).closest('button')) return;
      const parent = panel.parentElement;
      if (!parent) return;
      event.preventDefault();
      const panelRect = panel.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      const offsetX = event.clientX - panelRect.left;
      const offsetY = event.clientY - panelRect.top;
      panel.style.left = `${panelRect.left - parentRect.left}px`;
      panel.style.right = 'auto';
      panel.classList.add('dragging');
      dragHandle.setPointerCapture(event.pointerId);

      const move = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;
        this.placePanel(panel, moveEvent.clientX - parentRect.left - offsetX, moveEvent.clientY - parentRect.top - offsetY);
      };
      const end = (endEvent: PointerEvent) => {
        if (endEvent.pointerId !== event.pointerId) return;
        dragHandle.removeEventListener('pointermove', move);
        dragHandle.removeEventListener('pointerup', end);
        dragHandle.removeEventListener('pointercancel', end);
        panel.classList.remove('dragging');
        if (dragHandle.hasPointerCapture(event.pointerId)) dragHandle.releasePointerCapture(event.pointerId);
        this.persistPanelPosition(panel);
      };
      dragHandle.addEventListener('pointermove', move);
      dragHandle.addEventListener('pointerup', end);
      dragHandle.addEventListener('pointercancel', end);
    });

    const parent = panel.parentElement;
    if (parent) {
      const observer = new ResizeObserver(() => this.clampCurrentPanelPosition(panel));
      observer.observe(parent);
      observer.observe(panel);
    }
  }

  private placePanel(panel: HTMLElement, left: number, top: number) {
    const parent = panel.parentElement;
    if (!parent) return;
    const inset = 12;
    const minTop = 96;
    const maxLeft = Math.max(inset, parent.clientWidth - panel.offsetWidth - inset);
    const maxTop = Math.max(minTop, parent.clientHeight - panel.offsetHeight - inset);
    panel.style.left = `${Math.min(maxLeft, Math.max(inset, left))}px`;
    panel.style.top = `${Math.min(maxTop, Math.max(minTop, top))}px`;
    panel.style.right = 'auto';
  }

  private clampCurrentPanelPosition(panel: HTMLElement) {
    if (!panel.style.left) return;
    this.placePanel(panel, Number.parseFloat(panel.style.left), Number.parseFloat(panel.style.top));
  }

  private persistPanelPosition(panel: HTMLElement) {
    if (!panel.style.left) return;
    localStorage.setItem(PANEL_POSITION_KEY, JSON.stringify({
      left: Number.parseFloat(panel.style.left),
      top: Number.parseFloat(panel.style.top),
    }));
  }

  private restorePanelPosition(panel: HTMLElement) {
    try {
      const saved = JSON.parse(localStorage.getItem(PANEL_POSITION_KEY) || '') as { left?: unknown; top?: unknown };
      if (typeof saved.left === 'number' && Number.isFinite(saved.left) && typeof saved.top === 'number' && Number.isFinite(saved.top)) {
        this.placePanel(panel, saved.left, saved.top);
      }
    } catch {}
  }

  private updateToggle() {
    this.toggle.disabled = !this.canControl || this.busy;
    this.toggle.classList.toggle('active', this.enabled);
    this.toggle.classList.toggle('busy', this.busy);
    this.toggle.setAttribute('aria-pressed', String(this.enabled));
    const label = this.toggle.querySelector<HTMLElement>('.task-mode-toggle-label');
    if (label) label.textContent = this.busy ? '切换中' : '任务';
    this.toggle.title = !this.canControl ? '历史会话中不能切换任务模式'
      : this.enabled ? '任务模式已开启，点击关闭' : '任务模式已关闭，点击开启';
  }
}
