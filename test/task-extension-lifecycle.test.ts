const { test } = require('node:test');
const assert = require('node:assert/strict');

test('task extension persists mode, restores an unfinished task, and interrupts it at agent end', async () => {
  const taskModeExtension = require('../extensions/pi-task-mode/index.ts').default;
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const entries: any[] = [];
  let activeTools = ['read'];
  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => { tools.set(tool.name, tool); activeTools.push(tool.name); },
    appendEntry: (customType: string, data: any) => entries.push({ type: 'custom', customType, data }),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools = [...names]; },
  };
  const ctx = { ui: { notify: () => {} }, sessionManager: { getBranch: () => entries } };
  taskModeExtension(pi as any);
  await commands.get('task')!.handler('on', ctx);
  const started = await tools.get('tau_task').execute('call-1', { action: 'start', title: '分析早高峰', steps: [{ id: 'collect', title: '收集数据' }, { id: 'report', title: '生成报告' }] });
  assert.equal(started.details.task.status, 'planning');
  await handlers.get('agent_end')!();
  assert.equal(entries.at(-1).data.task.status, 'interrupted');
  await handlers.get('session_start')!({}, ctx);
  assert.equal(entries.at(-1).data.enabled, true);
});

test('task extension exposes task prompt content only while task mode is enabled', async () => {
  const taskModeExtension = require('../extensions/pi-task-mode/index.ts').default;
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const entries: any[] = [];
  const notifications: string[] = [];
  let activeTools = ['read'];
  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => { tools.set(tool.name, tool); activeTools.push(tool.name); },
    appendEntry: (customType: string, data: any) => entries.push({ type: 'custom', customType, data }),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools = [...names]; },
  };
  const ctx = { ui: { notify: (message: string) => notifications.push(message) }, sessionManager: { getBranch: () => entries } };

  taskModeExtension(pi as any);
  await handlers.get('session_start')!({}, ctx);
  assert.equal(activeTools.includes('tau_task'), false);
  assert.equal(activeTools.includes('tau_ask_user'), true);
  assert.equal(await handlers.get('before_agent_start')!({ systemPrompt: 'BASE' }), undefined);
  await assert.rejects(
    tools.get('tau_task').execute('call-disabled', { action: 'start', title: '不应创建', steps: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] }),
    /disabled/i,
  );

  await commands.get('task')!.handler('on --silent', ctx);
  assert.equal(activeTools.includes('tau_task'), true);
  assert.deepEqual(notifications, []);
  const enabledPrompt = await handlers.get('before_agent_start')!({ systemPrompt: 'BASE' });
  assert.match(enabledPrompt.systemPrompt, /当前会话处于任务模式/);

  await commands.get('task')!.handler('off --silent', ctx);
  assert.equal(activeTools.includes('tau_task'), false);
  assert.deepEqual(notifications, []);
  assert.equal(await handlers.get('before_agent_start')!({ systemPrompt: 'BASE' }), undefined);

  await commands.get('task')!.handler('on', ctx);
  assert.deepEqual(notifications, ['任务模式已开启']);
});
