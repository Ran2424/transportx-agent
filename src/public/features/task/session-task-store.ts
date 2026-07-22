import type { TaskSnapshot } from '../../../contracts/task.ts';

export class SessionTaskStore {
  private sessions = new Map<string, Map<string, TaskSnapshot>>();

  reset(sessionKey: string) {
    this.sessions.set(sessionKey, new Map());
  }

  accept(sessionKey: string, task: TaskSnapshot) {
    let tasks = this.sessions.get(sessionKey);
    if (!tasks) {
      tasks = new Map();
      this.sessions.set(sessionKey, tasks);
    }
    const current = tasks.get(task.taskId);
    if (current && current.revision >= task.revision) return false;
    tasks.set(task.taskId, task);
    return true;
  }

  list(sessionKey: string) {
    return Array.from(this.sessions.get(sessionKey)?.values() || [])
      .sort((a, b) => a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId));
  }

  latest(sessionKey: string) {
    return this.list(sessionKey).at(-1);
  }
}
