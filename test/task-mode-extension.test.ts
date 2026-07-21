const { test } = require('node:test');
const assert = require('node:assert/strict');

type RegisteredTool = {
  name: string;
  executionMode?: string;
  execute(
    toolCallId: string,
    params: Record<string, any>,
    signal: AbortSignal | undefined,
    onUpdate: ((result: Record<string, any>) => void) | undefined,
    ctx: Record<string, any>,
  ): Promise<any>;
};

type RegisteredCommand = {
  handler(args: string, ctx: Record<string, any>): Promise<void>;
};

async function loadExtension() {
  const modulePath = '../extensions/pi-task-mode/index.ts';
  const extension = (await import(modulePath)).default;
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<string, Function>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  extension({
    registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: RegisteredCommand) { commands.set(name, command); },
    on(name: string, handler: Function) { handlers.set(name, handler); },
    appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
  });
  return { tools, commands, handlers, entries };
}

function makeContext(branch: unknown[] = [], ui: Record<string, Function> = {}) {
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    cwd: process.cwd(),
    mode: 'rpc',
    hasUI: true,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify(message: string, type?: string) { notifications.push({ message, type }); },
      confirm: async () => true,
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      ...ui,
    },
    notifications,
  };
}

test('task mode extension registers tools, lifecycle handlers, and command', async () => {
  const { tools, commands, handlers } = await loadExtension();
  assert.deepEqual(Array.from(tools.keys()).sort(), ['tau_ask_user', 'tau_task']);
  assert.equal(tools.get('tau_ask_user')?.executionMode, 'sequential');
  assert.equal(typeof commands.get('task')?.handler, 'function');
  assert.equal(typeof handlers.get('session_start'), 'function');
  assert.equal(typeof handlers.get('session_tree'), 'function');
  assert.equal(typeof handlers.get('before_agent_start'), 'function');
  assert.equal(typeof handlers.get('agent_end'), 'function');
});

test('/task command persists mode and injects task instructions only when enabled', async () => {
  const { commands, handlers, entries } = await loadExtension();
  const ctx = makeContext();
  const command = commands.get('task')!;
  const beforeAgentStart = handlers.get('before_agent_start')!;

  await command.handler('on', ctx);
  assert.deepEqual(entries.at(-1), { customType: 'pi-task-mode', data: { schemaVersion: 1, revision: 1, enabled: true } });
  assert.match(ctx.notifications.at(-1)?.message || '', /已开启/);

  const enabled = await beforeAgentStart({ systemPrompt: 'base prompt' }, ctx);
  assert.match(enabled.systemPrompt, /base prompt/);
  assert.match(enabled.systemPrompt, /凡涉及分析的请求，必须先调用 tau_task/);
  assert.match(enabled.systemPrompt, /tau_task/);
  assert.match(enabled.systemPrompt, /tau_ask_user/);

  await command.handler('off', ctx);
  assert.deepEqual(entries.at(-1), { customType: 'pi-task-mode', data: { schemaVersion: 1, revision: 2, enabled: false } });
  assert.equal(await beforeAgentStart({ systemPrompt: 'base prompt' }, ctx), undefined);
});

test('tau_task creates, advances, and finishes a revisioned task snapshot', async () => {
  const { tools } = await loadExtension();
  const task = tools.get('tau_task')!;
  const ctx = makeContext();
  const signal = new AbortController().signal;

  const started = await task.execute('call_start', {
    action: 'start',
    taskId: 'traffic_report',
    title: '生成交通运行报告',
    steps: [
      { id: 'collect', title: '收集数据' },
      { id: 'report', title: '生成报告' },
    ],
  }, signal, undefined, ctx);
  assert.equal(started.details.kind, 'tau-task');
  assert.equal(started.details.task.revision, 1);
  assert.equal(started.details.task.status, 'planning');
  assert.deepEqual(started.details.task.steps.map((step: any) => step.status), ['pending', 'pending']);

  const running = await task.execute('call_running', {
    action: 'update_step', taskId: 'traffic_report', stepId: 'collect', status: 'running',
  }, signal, undefined, ctx);
  assert.equal(running.details.task.revision, 2);
  assert.equal(running.details.task.status, 'running');
  assert.equal(running.details.task.activeStepId, 'collect');

  const collected = await task.execute('call_complete_collect', {
    action: 'update_step', taskId: 'traffic_report', stepId: 'collect', status: 'completed', summary: '已获取数据',
  }, signal, undefined, ctx);
  assert.equal(collected.details.task.revision, 3);
  assert.equal(collected.details.task.steps[0].summary, '已获取数据');

  await task.execute('call_running_report', {
    action: 'update_step', taskId: 'traffic_report', stepId: 'report', status: 'running',
  }, signal, undefined, ctx);
  await task.execute('call_complete_report', {
    action: 'update_step', taskId: 'traffic_report', stepId: 'report', status: 'completed',
  }, signal, undefined, ctx);
  const finished = await task.execute('call_finish', {
    action: 'finish', taskId: 'traffic_report', summary: '报告已生成',
  }, signal, undefined, ctx);
  assert.equal(finished.details.task.revision, 6);
  assert.equal(finished.details.task.status, 'completed');
  assert.equal(finished.details.task.summary, '报告已生成');
});

test('tau_task rejects duplicate steps, concurrent running steps, and premature finish', async () => {
  const { tools } = await loadExtension();
  const task = tools.get('tau_task')!;
  const ctx = makeContext();

  await assert.rejects(() => task.execute('bad_start', {
    action: 'start', title: 'Bad',
    steps: [{ id: 'same', title: 'A' }, { id: 'same', title: 'B' }],
  }, undefined, undefined, ctx), /step id/i);

  await task.execute('start', {
    action: 'start', taskId: 'valid', title: 'Valid',
    steps: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
  }, undefined, undefined, ctx);
  await task.execute('run_a', {
    action: 'update_step', taskId: 'valid', stepId: 'a', status: 'running',
  }, undefined, undefined, ctx);
  await assert.rejects(() => task.execute('run_b', {
    action: 'update_step', taskId: 'valid', stepId: 'b', status: 'running',
  }, undefined, undefined, ctx), /already running/i);
  await assert.rejects(() => task.execute('finish', {
    action: 'finish', taskId: 'valid',
  }, undefined, undefined, ctx), /unfinished/i);
});

test('tau_task can explicitly fail or cancel unfinished tasks', async () => {
  const failedExtension = await loadExtension();
  const failedTask = failedExtension.tools.get('tau_task')!;
  await failedTask.execute('start_failed', {
    action: 'start', taskId: 'failed', title: 'Failed task',
    steps: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
  }, undefined, undefined, makeContext());
  const failed = await failedTask.execute('fail', {
    action: 'fail', taskId: 'failed', summary: '地图工具不可用',
  }, undefined, undefined, makeContext());
  assert.equal(failed.details.task.status, 'failed');
  assert.equal(failed.details.task.summary, '地图工具不可用');

  const cancelledExtension = await loadExtension();
  const cancelledTask = cancelledExtension.tools.get('tau_task')!;
  await cancelledTask.execute('start_cancelled', {
    action: 'start', taskId: 'cancelled', title: 'Cancelled task',
    steps: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
  }, undefined, undefined, makeContext());
  const cancelled = await cancelledTask.execute('cancel', {
    action: 'cancel', taskId: 'cancelled', summary: '用户取消',
  }, undefined, undefined, makeContext());
  assert.equal(cancelled.details.task.status, 'cancelled');
  assert.equal(cancelled.details.task.summary, '用户取消');
});

test('tau_task revise preserves completed steps and rejects removing them', async () => {
  const { tools } = await loadExtension();
  const task = tools.get('tau_task')!;
  const ctx = makeContext();

  await task.execute('start', {
    action: 'start', taskId: 'revise', title: 'Original',
    steps: [{ id: 'done', title: 'Done' }, { id: 'next', title: 'Next' }],
  }, undefined, undefined, ctx);
  await task.execute('run', {
    action: 'update_step', taskId: 'revise', stepId: 'done', status: 'running',
  }, undefined, undefined, ctx);
  await task.execute('done', {
    action: 'update_step', taskId: 'revise', stepId: 'done', status: 'completed', summary: 'kept',
  }, undefined, undefined, ctx);

  const revised = await task.execute('revise', {
    action: 'revise', taskId: 'revise', title: 'Revised',
    steps: [{ id: 'done', title: 'Done renamed' }, { id: 'new', title: 'New' }],
  }, undefined, undefined, ctx);
  assert.equal(revised.details.task.title, 'Revised');
  assert.equal(revised.details.task.steps[0].status, 'completed');
  assert.equal(revised.details.task.steps[0].summary, 'kept');
  assert.equal(revised.details.task.steps[1].status, 'pending');

  await assert.rejects(() => task.execute('bad_revise', {
    action: 'revise', taskId: 'revise',
    steps: [{ id: 'new', title: 'New' }, { id: 'other', title: 'Other' }],
  }, undefined, undefined, ctx), /completed step/i);
});

test('tau_ask_user returns structured selections and emits waiting task snapshots', async () => {
  const { tools } = await loadExtension();
  const task = tools.get('tau_task')!;
  const ask = tools.get('tau_ask_user')!;
  const updates: any[] = [];
  const seenOptions: string[][] = [];
  const ctx = makeContext([], {
    select: async (_title: string, options: string[]) => {
      seenOptions.push(options);
      return options[1];
    },
  });

  await task.execute('start', {
    action: 'start', taskId: 'ask', title: 'Ask',
    steps: [{ id: 'prepare', title: 'Prepare' }, { id: 'apply', title: 'Apply' }],
  }, undefined, undefined, ctx);
  await task.execute('run', {
    action: 'update_step', taskId: 'ask', stepId: 'prepare', status: 'running',
  }, undefined, undefined, ctx);

  const result = await ask.execute('ask_1', {
    kind: 'select', title: '选择范围', message: '请选择分析范围', required: true,
    options: [
      { value: 'city', label: '全市' },
      { value: 'district', label: '行政区', description: '仅分析一个行政区' },
    ],
  }, new AbortController().signal, update => updates.push(update), ctx);

  assert.deepEqual(seenOptions, [['全市', '行政区 — 仅分析一个行政区']]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].details.task.status, 'waiting_user');
  assert.equal(result.details.kind, 'tau-interaction');
  assert.equal(result.details.status, 'answered');
  assert.equal(result.details.value, 'district');
  assert.equal(result.details.task.status, 'running');
  assert.ok(result.details.task.revision > updates[0].details.task.revision);
});

test('tau_ask_user treats cancelled text input as cancelled and never auto-approves confirm false', async () => {
  const { tools } = await loadExtension();
  const ask = tools.get('tau_ask_user')!;
  const inputCtx = makeContext([], { input: async () => undefined });
  const cancelled = await ask.execute('input', {
    kind: 'input', title: '补充信息', message: '请输入区域', required: true,
  }, undefined, undefined, inputCtx);
  assert.equal(cancelled.details.status, 'cancelled');
  assert.match(cancelled.content[0].text, /取消/);

  const confirmCtx = makeContext([], { confirm: async () => false });
  const rejected = await ask.execute('confirm', {
    kind: 'confirm', title: '确认执行', message: '是否继续？', required: true,
  }, undefined, undefined, confirmCtx);
  assert.equal(rejected.details.status, 'answered');
  assert.equal(rejected.details.value, false);
  assert.doesNotMatch(rejected.content[0].text, /已批准/);
});

test('session restore persists an interrupted snapshot for Web recovery', async () => {
  const { tools, handlers, entries } = await loadExtension();
  const task = tools.get('tau_task')!;
  const initialCtx = makeContext();
  const result = await task.execute('start', {
    action: 'start', taskId: 'restore', title: 'Restore',
    steps: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
  }, undefined, undefined, initialCtx);
  const branch = [
    { type: 'custom', customType: 'pi-task-mode', data: { enabled: true } },
    { type: 'message', message: { role: 'toolResult', toolName: 'tau_task', details: result.details } },
  ];
  const restoredCtx = makeContext(branch);
  await handlers.get('session_start')!({}, restoredCtx);

  const persisted = entries.at(-1)?.data as { enabled?: boolean; task?: { status?: string } };
  assert.equal(persisted.enabled, true);
  assert.equal(persisted.task?.status, 'interrupted');

  const before = await handlers.get('before_agent_start')!({ systemPrompt: 'base' }, restoredCtx);
  assert.match(before.systemPrompt, /tau_task/);
  await assert.rejects(() => task.execute('resume_old', {
    action: 'update_step', taskId: 'restore', stepId: 'a', status: 'running',
  }, undefined, undefined, restoredCtx), /terminal: interrupted/i);
});

test('agent_end persists an interrupted snapshot when the agent omits task completion', async () => {
  const { tools, handlers, entries } = await loadExtension();
  await tools.get('tau_task')!.execute('start', {
    action: 'start', taskId: 'unfinished', title: 'Unfinished',
    steps: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
  }, undefined, undefined, makeContext());

  await handlers.get('agent_end')!({}, makeContext());
  const persisted = entries.at(-1)?.data as { task?: { taskId?: string; status?: string } };
  assert.equal(persisted.task?.taskId, 'unfinished');
  assert.equal(persisted.task?.status, 'interrupted');
});

test('session restore chooses the latest task even when its revision is lower', async () => {
  const { tools, handlers } = await loadExtension();
  const branch = [
    {
      type: 'message',
      message: {
        role: 'toolResult', toolName: 'tau_task',
        details: {
          task: {
            schemaVersion: 1, taskId: 'old', title: 'Old', status: 'completed', revision: 10,
            steps: [{ id: 'a', title: 'A', status: 'completed' }, { id: 'b', title: 'B', status: 'completed' }],
            createdAt: 1, updatedAt: 10,
          },
        },
      },
    },
    {
      type: 'message',
      message: {
        role: 'toolResult', toolName: 'tau_task',
        details: {
          task: {
            schemaVersion: 1, taskId: 'new', title: 'New', status: 'planning', revision: 1,
            steps: [{ id: 'x', title: 'X', status: 'pending' }, { id: 'y', title: 'Y', status: 'pending' }],
            createdAt: 20, updatedAt: 20,
          },
        },
      },
    },
  ];
  const ctx = makeContext(branch);
  await handlers.get('session_start')!({}, ctx);
  await assert.rejects(() => tools.get('tau_task')!.execute('update', {
    action: 'update_step', taskId: 'new', stepId: 'x', status: 'running',
  }, undefined, undefined, ctx), /Task new is terminal: interrupted/);
});
