import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../components/icons';
import { durationSeconds, useElapsedMilliseconds } from './conversation-duration';
import { Thinking } from './message-cards';
import { ToolCard } from './tool-card';
import { executionTiming, type ExecutionActivity } from './execution-parts';

export function ExecutionGroup({ activities, sessionId, running, showThinking, expandThinking }: { activities: ExecutionActivity[]; sessionId: string; running: boolean; showThinking: boolean; expandThinking: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [showThinking]);
  const timing = executionTiming(activities, running);
  const elapsed = useElapsedMilliseconds(timing.active ? timing.startedAt : null, timing.durationMs);
  const duration = elapsed === null ? '—' : t('conversation.thinkingDuration', { count: durationSeconds(elapsed) });
  return <section className="execution-group">
    {!showThinking ? <button type="button" className={`thinking-toggle working-toggle${timing.active ? ' is-active' : ''}`} aria-expanded={open} aria-label={`${t('conversation.executionDetails')} · Working · ${duration}`} title={t('conversation.workingTimeHelp')} onClick={() => setOpen((value) => !value)}><Icon name="chevron" /><span className="working-label">Working{timing.active ? <span aria-hidden="true"> · · ·</span> : null}</span><span> · {duration}</span></button> : null}
    {showThinking || open ? activities.map((activity) => activity.tool ? <ToolCard key={activity.id} tool={activity.tool} sessionId={sessionId} /> : activity.thinking ? <Thinking key={activity.id} {...activity.thinking} visible defaultExpanded={expandThinking} /> : null) : null}
  </section>;
}
