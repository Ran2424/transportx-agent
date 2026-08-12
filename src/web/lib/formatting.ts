import type { LiveSession, ModelRecord } from '../../public/app-types.js';
import i18n from '../i18n';

export function basename(value = ''): string {
  return value.split(/[/\\]/).filter(Boolean).pop() || value || i18n.t('sessions.task');
}

export function sessionTitle(session: LiveSession): string {
  return session.sessionName || basename(session.cwd || '') || i18n.t('sessions.newTaskFallback');
}

export function modelReference(model: ModelRecord | string | null | undefined): string {
  if (!model) return '';
  if (typeof model === 'string') return model;
  const provider = model.provider || '';
  const id = model.id || model.model || model.name || '';
  return provider && id ? `${provider}/${id}` : id;
}

export function compactModelLabel(session: LiveSession): string {
  const raw = session.modelLabel || session.modelSpec || modelReference(session.model) || i18n.t('common.default');
  return String(raw).replace(/^.*\//, '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

export function relativeTime(value?: string): string {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return '';
  const elapsed = Math.max(0, Date.now() - date.getTime());
  const minutes = Math.floor(elapsed / 60_000);
  const hours = Math.floor(elapsed / 3_600_000);
  const days = Math.floor(elapsed / 86_400_000);
  const locale = i18n.resolvedLanguage || i18n.language || 'zh-CN';
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (minutes < 1) return relative.format(0, 'second');
  if (minutes < 60) return relative.format(-minutes, 'minute');
  if (hours < 24) return relative.format(-hours, 'hour');
  if (days === 1) return relative.format(-1, 'day');
  if (days < 7) return date.toLocaleDateString(locale, { weekday: 'long' });
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}
