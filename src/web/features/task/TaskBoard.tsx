import { useMemo, useState } from 'react';
import type { LiveSession } from '../../../public/app-types.js';
import { useAppServices } from '../../app/AppProviders';
import { useConversationState, useToolExecutionState } from '../../app/store-hooks';
import { projectTaskState } from './task-projection';

const taskLabels = { planning: '规划中', running: '执行中', waiting_user: '等待回答', completed: '已完成', failed: '执行失败', interrupted: '已中断', cancelled: '已取消' } as const;
const stepLabels = { pending: '待执行', running: '进行中', completed: '已完成', blocked: '已阻塞', failed: '失败', skipped: '已跳过' } as const;

export function TaskBoard({ session }: { session: LiveSession | null }) {
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

  async function toggleMode() {
    if (!session || kernel.stores.session.isStreaming(session.id)) return;
    await kernel.commands.agent.sendPrompt({ sessionId: session.id, message: `/task ${state.enabled ? 'off' : 'on'}` });
  }

  if (!session) return <FeatureEmpty mark="✓" title="等待任务上下文" description="选择一个运行中的任务后，可在这里查看执行计划。" />;
  if (!task) return <section className="feature-empty"><span>✓</span><strong>暂无任务计划</strong><p>开启任务模式并发起分析后，执行步骤会显示在这里。</p><button className="ui-button ui-button-quiet" type="button" disabled={kernel.stores.session.isStreaming(session.id)} onClick={() => void toggleMode()}>{state.enabled ? '关闭任务模式' : '开启任务模式'}</button></section>;
  return <section className={`task-board-card task-board--${task.status}`}>
    <header><button type="button" className="task-board-heading" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}><span><small>PI TASK</small><strong>{task.title}</strong></span><b>{completed}/{task.steps.length} · {taskLabels[task.status]}</b></button></header>
    {!collapsed && <div className="task-board-body"><div className="task-progress" role="progressbar" aria-valuemin={0} aria-valuemax={task.steps.length} aria-valuenow={completed}><span style={{ width: `${Math.round(completed / task.steps.length * 100)}%` }} /></div><ol>{task.steps.map((step, index) => <li key={step.id} className={`task-step task-step--${step.status}`}><i>{step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : step.status === 'blocked' ? '×' : index + 1}</i><span><strong>{step.title}</strong>{step.summary ? <small>{step.summary}</small> : null}</span><em>{stepLabels[step.status]}</em></li>)}</ol>{task.summary ? <p className="task-summary">{task.summary}</p> : null}</div>}
  </section>;
}

export function FeatureEmpty({ mark, title, description }: { mark: string; title: string; description: string }) { return <section className="feature-empty"><span>{mark}</span><strong>{title}</strong><p>{description}</p></section>; }
