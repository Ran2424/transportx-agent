import { useMemo, useState } from 'react';
import type { LiveSession } from '../../../public/app-types.js';
import { useTranslation } from 'react-i18next';
import { useAppServices } from '../../app/AppProviders';
import { useConversationState, useToolExecutionState } from '../../app/store-hooks';
import { projectTaskState } from './task-projection';

export function TaskBoard({ session }: { session: LiveSession | null }) {
  const { t } = useTranslation();
  const { kernel } = useAppServices();
  const conversation = useConversationState();
  const tools = useToolExecutionState();
  const [collapsed, setCollapsed] = useState(false);
  const state = useMemo(() => session ? projectTaskState(
    conversation.bySession[session.id]?.snapshotEntries ?? [],
    Object.values(tools.bySession[session.id] ?? {}),
  ) : { enabled: false, task: null }, [conversation, session, tools]);
  const task = state.task;
  const completed = task?.steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length ?? 0;
  const taskLabels = { planning: t('task.status.planning'), running: t('task.status.running'), waiting_user: t('task.status.waiting'), completed: t('task.status.completed'), failed: t('task.status.failed'), interrupted: t('task.status.interrupted'), cancelled: t('task.status.cancelled') } as const;
  const stepLabels = { pending: t('task.step.pending'), running: t('task.step.running'), completed: t('task.step.completed'), blocked: t('task.step.blocked'), failed: t('task.step.failed'), skipped: t('task.step.skipped') } as const;

  async function toggleMode() {
    if (!session || kernel.stores.session.isStreaming(session.id)) return;
    await kernel.commands.agent.setTaskMode({ sessionId: session.id, enabled: !state.enabled });
  }

  if (!session) return <FeatureEmpty mark="✓" title={t('task.waitingContext')} description={t('task.waitingDescription')} />;
  if (!task) return <section className="feature-empty"><span>✓</span><strong>{t('task.noPlan')}</strong><p>{t('task.noPlanDescription')}</p><button className="ui-button ui-button-quiet" type="button" disabled={kernel.stores.session.isStreaming(session.id)} onClick={() => void toggleMode()}>{state.enabled ? t('task.mode.disable') : t('task.mode.enable')}</button></section>;
  return <section className={`task-board-card task-board--${task.status}`}>
    <header><button type="button" className="task-board-heading" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}><strong>{task.title}</strong><b>{completed}/{task.steps.length} {taskLabels[task.status]}</b></button></header>
    {!collapsed && <div className="task-board-body"><div className="task-progress" role="progressbar" aria-valuemin={0} aria-valuemax={task.steps.length} aria-valuenow={completed}><span style={{ width: `${Math.round(completed / task.steps.length * 100)}%` }} /></div><ol>{task.steps.map((step, index) => <li key={step.id} className={`task-step task-step--${step.status}`}><i>{step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : step.status === 'blocked' ? '×' : index + 1}</i><span><strong>{step.title}</strong>{step.summary ? <small>{step.summary}</small> : null}</span><em>{stepLabels[step.status]}</em></li>)}</ol>{task.summary ? <p className="task-summary">{task.summary}</p> : null}</div>}
  </section>;
}

export function FeatureEmpty({ mark, title, description }: { mark: string; title: string; description: string }) { return <section className="feature-empty"><span>{mark}</span><strong>{title}</strong><p>{description}</p></section>; }
