import { useTranslation } from 'react-i18next';
import type { LiveSession } from '../../../public/app-types.js';
import { formatContextWindow } from '../../lib/formatting';

function numeric(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function contextUsage(session: LiveSession | undefined) {
  const usage = session?.contextUsage;
  const used = numeric(usage?.tokens);
  const limit = numeric(usage?.contextWindow)
    ?? numeric(typeof session?.model === 'object' ? session.model?.contextWindow ?? session.model?.context : null);
  const reportedPercent = numeric(usage?.percent);
  const percent = reportedPercent ?? (used !== null && limit && limit > 0 ? used / limit * 100 : null);
  return { used, limit, percent };
}

export function ComposerContextUsage({ session }: { session: LiveSession | undefined }) {
  const { t } = useTranslation();
  const usage = contextUsage(session);
  const percent = usage.percent === null ? 0 : usage.percent;
  const ringPercent = Math.min(100, percent);
  const availability = usage.percent === null ? ' is-unavailable' : '';
  const level = percent >= 90 ? ' is-critical' : percent >= 70 ? ' is-warning' : '';
  const detail = usage.used !== null && usage.limit !== null
    ? t('conversation.contextUsage', { used: formatContextWindow(usage.used), limit: formatContextWindow(usage.limit), percent: `${percent.toFixed(1)}%` })
    : t('conversation.contextUsageUnavailable');
  return <span className={`composer-context-usage${availability}${level}`} tabIndex={0} role="img" aria-label={detail}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle className="context-usage-track" cx="12" cy="12" r="8" pathLength="100" /><circle className="context-usage-value" cx="12" cy="12" r="8" pathLength="100" strokeDasharray={`${ringPercent} 100`} /></svg>
    <span className="composer-context-usage-hint">{detail}</span>
  </span>;
}
