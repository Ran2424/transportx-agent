const { test } = require('node:test');
const assert = require('node:assert/strict');

test('task extension persists mode, restores an unfinished task, and interrupts it at agent end', async () => {
  const taskModeExtension = require('../extensions/pi-task-mode/index.ts').default;
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const entries: any[] = [];
  const pi = { on: (name: string, handler: Function) => handlers.set(name, handler), registerCommand: (name: string, command: any) => commands.set(name, command), registerTool: (tool: any) => tools.set(tool.name, tool), appendEntry: (customType: string, data: any) => entries.push({ type: 'custom', customType, data }) };
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
