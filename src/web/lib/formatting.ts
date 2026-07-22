import type { LiveSession, ModelRecord } from '../../public/app-types.js';

export function basename(value = ''): string {
  return value.split(/[/\\]/).filter(Boolean).pop() || value || '任务';
}

export function sessionTitle(session: LiveSession): string {
  return session.sessionName || basename(session.cwd || '') || '新任务';
}

export function modelReference(model: ModelRecord | string | null | undefined): string {
  if (!model) return '';
  if (typeof model === 'string') return model;
  const provider = model.provider || '';
  const id = model.id || model.model || model.name || '';
  return provider && id ? `${provider}/${id}` : id;
}

export function compactModelLabel(session: LiveSession): string {
  const raw = session.modelLabel || session.modelSpec || modelReference(session.model) || '默认';
  return String(raw).replace(/^.*\//, '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

export function relativeTime(value?: string): string {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return '';
  const elapsed = Math.max(0, Date.now() - date.getTime());
  const minutes = Math.floor(elapsed / 60_000);
  const hours = Math.floor(elapsed / 3_600_000);
  const days = Math.floor(elapsed / 86_400_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days === 1) return '昨天';
  if (days < 7) return date.toLocaleDateString('zh-CN', { weekday: 'long' });
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
