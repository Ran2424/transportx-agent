import crypto from 'node:crypto';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  cancelTask,
  createTask,
  failTask,
  finishTask,
  interruptTask,
  isTerminalTask,
  parseTaskSnapshot,
  reviseTask,
  setTaskWaiting,
  updateTaskStep,
  type TaskSnapshot,
  type TaskStatus,
} from '../../../../../src/contracts/task.ts';

const STATE_ENTRY = 'pi-task-mode';
const STATE_SCHEMA_VERSION = 1 as const;
const TASK_INSTRUCTIONS = `当前会话处于任务模式。

任务模式开启时，凡涉及分析的请求，必须先调用 tau_task 并使用 action="start" 创建 2–8 个简短步骤。
开始和完成步骤时调用 tau_task，使用 action="update_step" 更新状态。
计划发生实质变化时使用 action="revise"。
缺少必要信息时调用 tau_ask_user，不得擅自猜测。
全部完成后调用 tau_task，使用 action="finish"。
工具或系统错误导致任务无法继续时使用 action="fail"；用户取消任务时使用 action="cancel"，不要遗留进行中的任务。
简单问答无需创建任务。`;

const StepInputSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 80 }),
  title: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });

const TauTaskSchema = Type.Object({
  action: Type.Union([
    Type.Literal('start'), Type.Literal('revise'), Type.Literal('update_step'), Type.Literal('finish'),
    Type.Literal('fail'), Type.Literal('cancel'),
  ]),
  taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  steps: Type.Optional(Type.Array(StepInputSchema, { minItems: 2, maxItems: 8 })),
  stepId: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
  status: Type.Optional(Type.Union([
    Type.Literal('running'), Type.Literal('completed'), Type.Literal('blocked'), Type.Literal('failed'), Type.Literal('skipped'),
  ])),
  summary: Type.Optional(Type.String({ maxLength: 2000 })),
}, { additionalProperties: false });

const AskOptionSchema = Type.Object({
  value: Type.String({ minLength: 1, maxLength: 200 }),
  label: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
}, { additionalProperties: false });

const TauAskUserSchema = Type.Object({
  kind: Type.Union([Type.Literal('confirm'), Type.Literal('select'), Type.Literal('input'), Type.Literal('editor')]),
  title: Type.String({ minLength: 1, maxLength: 300 }),
  message: Type.String({ minLength: 1, maxLength: 2000 }),
  options: Type.Optional(Type.Array(AskOptionSchema, { minItems: 2, maxItems: 20 })),
  required: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

type InteractionKind = 'confirm' | 'select' | 'input' | 'editor';
type AskOption = { value: string; label: string; description?: string };

function generatedId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function requiredText(value: unknown, field: string) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function taskResult(task: TaskSnapshot, text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: { kind: 'tau-task' as const, task },
  };
}

function dialogTitle(title: string, message: string) {
  return `${title} — ${message}`;
}

function validateOptions(value: unknown): Array<AskOption & { display: string }> {
  if (!Array.isArray(value) || value.length < 2 || value.length > 20) throw new Error('select requires 2 to 20 options');
  const values = new Set<string>();
  const displays = new Set<string>();
  return value.map((candidate, index) => {
    const option = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
    const item: AskOption = {
      value: requiredText(option.value, `options[${index}].value`),
      label: requiredText(option.label, `options[${index}].label`),
      ...(typeof option.description === 'string' && option.description.trim() ? { description: option.description.trim() } : {}),
    };
    const display = item.description ? `${item.label} — ${item.description}` : item.label;
    if (values.has(item.value)) throw new Error(`Duplicate option value: ${item.value}`);
    if (displays.has(display)) throw new Error(`Duplicate option label: ${display}`);
    values.add(item.value);
    displays.add(display);
    return { ...item, display };
  });
}

export default function taskModeExtension(pi: ExtensionAPI) {
  let modeEnabled = false;
  let currentTask: TaskSnapshot | null = null;
  let interactionPending = false;
  let stateRevision = 0;

  const syncTaskTool = () => {
    const active = pi.getActiveTools();
    const hasTaskTool = active.includes('tau_task');
    if (modeEnabled === hasTaskTool) return;
    pi.setActiveTools(modeEnabled ? [...active, 'tau_task'] : active.filter((name) => name !== 'tau_task'));
  };

  const persistState = () => {
    stateRevision += 1;
    pi.appendEntry(STATE_ENTRY, {
      schemaVersion: STATE_SCHEMA_VERSION,
      revision: stateRevision,
      enabled: modeEnabled,
      ...(currentTask ? { task: currentTask } : {}),
    });
  };

  const restore = (ctx: ExtensionContext) => {
    modeEnabled = false;
    currentTask = null;
    stateRevision = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === STATE_ENTRY) {
        const data = entry.data as { schemaVersion?: unknown; revision?: unknown; enabled?: unknown; task?: unknown } | undefined;
        if (data?.schemaVersion === STATE_SCHEMA_VERSION && Number.isInteger(data.revision) && Number(data.revision) > stateRevision) {
          stateRevision = Number(data.revision);
        }
        if (typeof data?.enabled === 'boolean') modeEnabled = data.enabled;
        const task = parseTaskSnapshot(data?.task);
        if (task) currentTask = task;
        continue;
      }
      if (entry.type !== 'message' || entry.message.role !== 'toolResult') continue;
      if (entry.message.toolName !== 'tau_task' && entry.message.toolName !== 'tau_ask_user') continue;
      const details = entry.message.details as { task?: unknown } | undefined;
      const task = parseTaskSnapshot(details?.task);
      if (task) currentTask = task;
    }
    syncTaskTool();
    if (currentTask && !isTerminalTask(currentTask)) {
      currentTask = interruptTask(currentTask);
      persistState();
    }
    interactionPending = false;
  };

  pi.on('session_start', async (_event, ctx) => restore(ctx));
  pi.on('session_tree', async (_event, ctx) => restore(ctx));
  pi.on('agent_end', async () => {
    if (!currentTask || isTerminalTask(currentTask)) return;
    currentTask = interruptTask(currentTask);
    persistState();
  });
  pi.on('before_agent_start', async (event) => {
    if (!modeEnabled) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${TASK_INSTRUCTIONS}` };
  });

  pi.registerCommand('task', {
    description: '开启、关闭或查看 Pi 任务模式：/task on|off|status',
    handler: async (args, ctx) => {
      const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const silent = tokens.at(-1) === '--silent';
      if (silent) tokens.pop();
      const action = tokens.join(' ') || 'status';
      if (action === 'status') {
        ctx.ui.notify(`任务模式：${modeEnabled ? '已开启' : '已关闭'}`, 'info');
        return;
      }
      if (action !== 'on' && action !== 'off') {
        ctx.ui.notify('用法：/task on、/task off 或 /task status', 'warning');
        return;
      }
      modeEnabled = action === 'on';
      syncTaskTool();
      persistState();
      if (!silent) ctx.ui.notify(`任务模式已${modeEnabled ? '开启' : '关闭'}`, 'info');
    },
  });

  pi.registerTool({
    name: 'tau_task',
    label: 'Task Progress',
    description: 'Create and update the structured task plan shown by Pi Traffic Workspace. Use this only for multi-step work.',
    promptSnippet: 'Create and update structured progress for multi-step tasks',
    promptGuidelines: [
      'When task mode is enabled, use tau_task to create a concise plan before complex work and keep each step status accurate.',
      'Do not use tau_task for a simple question that can be answered directly.',
    ],
    executionMode: 'sequential',
    parameters: TauTaskSchema,
    async execute(_toolCallId, params) {
      if (!modeEnabled) throw new Error('Task mode is disabled. Enable it with /task on first.');
      if (params.action === 'start') {
        if (currentTask && !isTerminalTask(currentTask)) throw new Error(`Cannot start a new task while active task ${currentTask.taskId} exists`);
        const taskId = params.taskId?.trim() || generatedId('task');
        currentTask = createTask({ taskId, title: params.title, steps: params.steps });
        return taskResult(currentTask, `已创建任务“${currentTask.title}”，共 ${currentTask.steps.length} 个步骤。`);
      }
      if (!currentTask) throw new Error('No current task. Call tau_task with action="start" first.');
      if (params.taskId?.trim() && params.taskId.trim() !== currentTask.taskId) throw new Error(`Task not found: ${params.taskId}`);
      if (params.action === 'revise') {
        currentTask = reviseTask(currentTask, { taskId: params.taskId, title: params.title, steps: params.steps });
        return taskResult(currentTask, `已修订任务“${currentTask.title}”，当前 revision 为 ${currentTask.revision}。`);
      }
      if (params.action === 'update_step') {
        currentTask = updateTaskStep(currentTask, {
          taskId: params.taskId, stepId: params.stepId, status: params.status, summary: params.summary,
        });
        const step = currentTask.steps.find((candidate) => candidate.id === params.stepId)!;
        return taskResult(currentTask, `步骤“${step.title}”已更新为 ${step.status}。`);
      }
      if (params.action === 'fail') {
        currentTask = failTask(currentTask, params.summary);
        return taskResult(currentTask, `任务“${currentTask.title}”已标记为失败。`);
      }
      if (params.action === 'cancel') {
        currentTask = cancelTask(currentTask, params.summary);
        return taskResult(currentTask, `任务“${currentTask.title}”已取消。`);
      }
      currentTask = finishTask(currentTask, { taskId: params.taskId, summary: params.summary });
      return taskResult(currentTask, `任务“${currentTask.title}”已完成。`);
    },
  });

  pi.registerTool({
    name: 'tau_ask_user',
    label: 'Ask User',
    description: 'Pause and ask the user for a confirmation, one choice, short text, or long text. Use this instead of guessing required information.',
    promptSnippet: 'Ask the user a structured question and wait for the answer',
    promptGuidelines: [
      'Use tau_ask_user when required information or approval is missing; never infer an answer from silence or cancellation.',
      'Only the host Pi agent should call tau_ask_user. Subagents should report that input is needed to the host.',
    ],
    executionMode: 'sequential',
    parameters: TauAskUserSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!ctx.hasUI) throw new Error('tau_ask_user requires an interactive TUI or RPC client');
      if (interactionPending) throw new Error('Another user interaction is already pending');
      const kind = params.kind as InteractionKind;
      const title = requiredText(params.title, 'title');
      const message = requiredText(params.message, 'message');
      const interactionId = generatedId('interaction');
      const priorStatus: TaskStatus | undefined = currentTask?.status;
      interactionPending = true;
      try {
        if (currentTask && !isTerminalTask(currentTask)) {
          currentTask = setTaskWaiting(currentTask, true);
        }
        onUpdate?.({
          content: [{ type: 'text', text: `等待用户回答：${title}` }],
          details: {
            kind: 'tau-interaction', interactionId, interactionKind: kind, status: 'waiting',
            ...(currentTask ? { task: currentTask } : {}),
          },
        });

        let status: 'answered' | 'cancelled' = 'answered';
        let value: string | boolean | undefined;
        let answerText = '';
        if (signal?.aborted) {
          status = 'cancelled';
        } else if (kind === 'confirm') {
          value = await ctx.ui.confirm(title, message, { signal });
          answerText = value ? '用户选择：是。' : '用户选择：否。';
        } else if (kind === 'select') {
          const options = validateOptions(params.options);
          const selected = await ctx.ui.select(dialogTitle(title, message), options.map((option) => option.display), { signal });
          const option = options.find((candidate) => candidate.display === selected);
          if (option) {
            value = option.value;
            answerText = `用户选择：${option.label}（${option.value}）。`;
          } else if (selected?.trim()) {
            value = selected.trim();
            answerText = `用户回答：${value}`;
          } else {
            status = 'cancelled';
          }
        } else if (kind === 'input') {
          value = await ctx.ui.input(dialogTitle(title, message), undefined, { signal });
          if (value === undefined) status = 'cancelled';
          else answerText = `用户回答：${value}`;
        } else {
          value = await ctx.ui.editor(dialogTitle(title, message));
          if (value === undefined) status = 'cancelled';
          else answerText = `用户回答：${value}`;
        }
        if (signal?.aborted) status = 'cancelled';
        if (currentTask?.status === 'waiting_user') currentTask = setTaskWaiting(currentTask, false, priorStatus);
        if (status === 'cancelled') {
          answerText = params.required
            ? '用户取消了必需的输入；不要继续依赖该信息。'
            : '用户取消了本次输入。';
          value = undefined;
        }
        return {
          content: [{ type: 'text' as const, text: answerText }],
          details: {
            kind: 'tau-interaction' as const,
            interactionId,
            interactionKind: kind,
            status,
            ...(value !== undefined ? { value } : {}),
            ...(currentTask ? { task: currentTask } : {}),
          },
        };
      } finally {
        if (currentTask?.status === 'waiting_user') currentTask = setTaskWaiting(currentTask, false, priorStatus);
        interactionPending = false;
      }
    },
  });
}
