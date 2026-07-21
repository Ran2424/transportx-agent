import type { TaskSnapshot, TaskStatus, TaskStepSnapshot, TaskStepStatus } from './task-protocol.js';

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  planning: '规划中',
  running: '执行中',
  waiting_user: '等待回答',
  completed: '已完成',
  failed: '执行失败',
  interrupted: '已中断',
  cancelled: '已取消',
};

const STEP_STATUS_LABELS: Record<TaskStepStatus, string> = {
  pending: '待执行',
  running: '进行中',
  completed: '已完成',
  blocked: '已阻塞',
  failed: '失败',
  skipped: '已跳过',
};

export class TaskCardRenderer {
  private container: HTMLElement;
  private cards = new Map<string, HTMLElement>();

  constructor(container: HTMLElement) {
    this.container = container;
  }

  clear() {
    this.cards.clear();
    this.container.replaceChildren(this.renderEmpty());
  }

  render(task: TaskSnapshot) {
    this.container.querySelector('.task-board-empty')?.remove();
    for (const [taskId, candidate] of this.cards) {
      if (taskId === task.taskId) continue;
      candidate.remove();
      this.cards.delete(taskId);
    }
    let card = this.cards.get(task.taskId);
    const wasCollapsed = card?.classList.contains('collapsed') ?? false;
    if (!card) {
      card = document.createElement('section');
      card.className = 'task-card';
      card.dataset.taskId = task.taskId;
      this.cards.set(task.taskId, card);
      this.container.appendChild(card);
    }
    card.dataset.revision = String(task.revision);
    card.dataset.status = task.status;
    card.className = `task-card task-card--${task.status}${wasCollapsed ? ' collapsed' : ''}`;
    card.replaceChildren(this.renderHeader(task), this.renderBody(task));
    this.container.appendChild(card);
    this.scrollIntoViewIfNeeded(card);
    return card;
  }

  private renderEmpty() {
    const empty = document.createElement('div');
    empty.className = 'task-board-empty';
    const mark = document.createElement('span');
    mark.className = 'task-board-empty-mark';
    mark.textContent = '✓';
    const title = document.createElement('strong');
    title.textContent = '暂无任务计划';
    const description = document.createElement('span');
    description.textContent = '开启任务模式并发起分析后，执行步骤会固定显示在这里。';
    empty.append(mark, title, description);
    return empty;
  }

  private renderHeader(task: TaskSnapshot) {
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'task-card-header';
    header.setAttribute('aria-expanded', 'true');
    header.addEventListener('click', () => {
      const card = header.closest<HTMLElement>('.task-card');
      const collapsed = card?.classList.toggle('collapsed') ?? false;
      header.setAttribute('aria-expanded', String(!collapsed));
    });

    const identity = document.createElement('span');
    identity.className = 'task-card-identity';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'task-card-eyebrow';
    eyebrow.textContent = 'PI TASK';
    const title = document.createElement('span');
    title.className = 'task-card-title';
    title.textContent = task.title;
    identity.append(eyebrow, title);

    const completed = task.steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length;
    const meta = document.createElement('span');
    meta.className = 'task-card-meta';
    const count = document.createElement('span');
    count.className = 'task-card-count';
    count.textContent = `${completed}/${task.steps.length}`;
    const status = document.createElement('span');
    status.className = `task-card-status task-card-status--${task.status}`;
    status.textContent = TASK_STATUS_LABELS[task.status];
    const chevron = document.createElement('span');
    chevron.className = 'task-card-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '⌄';
    meta.append(count, status, chevron);
    header.append(identity, meta);
    return header;
  }

  private renderBody(task: TaskSnapshot) {
    const body = document.createElement('div');
    body.className = 'task-card-body';
    const completed = task.steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length;
    const progress = document.createElement('div');
    progress.className = 'task-progress';
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', String(task.steps.length));
    progress.setAttribute('aria-valuenow', String(completed));
    const fill = document.createElement('span');
    fill.className = 'task-progress-fill';
    fill.style.width = `${Math.round((completed / task.steps.length) * 100)}%`;
    progress.appendChild(fill);

    const steps = document.createElement('ol');
    steps.className = 'task-steps';
    task.steps.forEach((step, index) => steps.appendChild(this.renderStep(step, index, task.activeStepId)));
    body.append(progress, steps);

    if (task.summary) {
      const summary = document.createElement('p');
      summary.className = 'task-card-summary';
      summary.textContent = task.summary;
      body.appendChild(summary);
    }
    return body;
  }

  private renderStep(step: TaskStepSnapshot, index: number, activeStepId?: string) {
    const item = document.createElement('li');
    item.className = `task-step task-step--${step.status}${step.id === activeStepId ? ' task-step--active' : ''}`;

    const marker = document.createElement('span');
    marker.className = 'task-step-marker';
    marker.setAttribute('aria-label', STEP_STATUS_LABELS[step.status]);
    marker.textContent = step.status === 'completed' ? '✓'
      : step.status === 'failed' ? '!'
      : step.status === 'blocked' ? '×'
      : step.status === 'skipped' ? '–'
      : String(index + 1);

    const content = document.createElement('span');
    content.className = 'task-step-content';
    const title = document.createElement('span');
    title.className = 'task-step-title';
    title.textContent = step.title;
    content.appendChild(title);
    if (step.summary) {
      const summary = document.createElement('span');
      summary.className = 'task-step-summary';
      summary.textContent = step.summary;
      content.appendChild(summary);
    }

    const label = document.createElement('span');
    label.className = 'task-step-status';
    label.textContent = STEP_STATUS_LABELS[step.status];
    item.append(marker, content, label);
    return item;
  }

  private scrollIntoViewIfNeeded(card: HTMLElement) {
    const distance = this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight;
    if (distance < 180) requestAnimationFrame(() => card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }
}
