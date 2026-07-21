const { test } = require('node:test');
const assert = require('node:assert/strict');

function task(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    taskId: 'task-1',
    title: '分析道路拥堵',
    status: 'running',
    revision: 2,
    steps: [
      { id: 'collect', title: '收集数据', status: 'completed', completedAt: 10 },
      { id: 'analyze', title: '分析结果', status: 'running', startedAt: 11 },
    ],
    activeStepId: 'analyze',
    createdAt: 1,
    updatedAt: 11,
    ...overrides,
  };
}

test('task Web protocol parses versioned tool details and rejects inconsistent snapshots', async () => {
  const modulePath = '../src/public/features/task/task-protocol.ts';
  const { parseTaskSnapshot, parseTaskToolResult } = await import(modulePath);
  assert.deepEqual(parseTaskToolResult({ details: { kind: 'tau-task', task: task() } })?.activeStepId, 'analyze');
  assert.deepEqual(parseTaskToolResult({ details: { kind: 'tau-interaction', task: task({ status: 'waiting_user', revision: 3 }) } })?.status, 'waiting_user');
  assert.equal(parseTaskToolResult({ details: { kind: 'other', task: task() } }), null);
  assert.equal(parseTaskSnapshot(task({ activeStepId: 'missing' })), null);
  assert.equal(parseTaskSnapshot(task({ activeStepId: undefined })), null);
  assert.equal(parseTaskSnapshot(task({ steps: [
    { id: 'a', title: 'A', status: 'running' },
    { id: 'b', title: 'B', status: 'running' },
  ], activeStepId: 'a' })), null);
});

test('task Web protocol recognizes mode and persisted task state entries', async () => {
  const modulePath = '../src/public/features/task/task-protocol.ts';
  const { parseTaskModeEntry, parseTaskStateEntry } = await import(modulePath);
  assert.equal(parseTaskModeEntry({ type: 'custom', customType: 'pi-task-mode', data: { enabled: true } }), true);
  assert.equal(parseTaskModeEntry({ type: 'custom', customType: 'pi-task-mode', data: { enabled: false } }), false);
  assert.equal(parseTaskModeEntry({ type: 'custom', customType: 'other', data: { enabled: true } }), null);
  const interrupted = task({
    status: 'interrupted', revision: 3, activeStepId: undefined,
    steps: [
      { id: 'collect', title: '收集数据', status: 'completed', completedAt: 10 },
      { id: 'analyze', title: '分析结果', status: 'blocked', startedAt: 11 },
    ],
  });
  assert.equal(parseTaskStateEntry({
    type: 'custom', customType: 'pi-task-mode', data: { enabled: true, task: interrupted },
  })?.task?.status, 'interrupted');
});

test('session task store keeps the latest revision of each task', async () => {
  const modulePath = '../src/public/features/task/session-task-store.ts';
  const { SessionTaskStore } = await import(modulePath);
  const store = new SessionTaskStore();
  store.reset('session-1');
  assert.equal(store.accept('session-1', task({ revision: 2 })), true);
  assert.equal(store.accept('session-1', task({ revision: 1 })), false);
  assert.equal(store.accept('session-1', task({ revision: 3, status: 'completed', activeStepId: undefined, steps: [
    { id: 'collect', title: '收集数据', status: 'completed' },
    { id: 'analyze', title: '分析结果', status: 'completed' },
  ] })), true);
  assert.equal(store.list('session-1')[0].revision, 3);
  assert.equal(store.latest('session-1').revision, 3);
});

test('Web dialog adapter separates tau_ask_user titles and option descriptions', async () => {
  const modulePath = '../src/public/dialogs.ts';
  const { DialogHandler } = await import(modulePath);
  const handler = Object.create(DialogHandler.prototype) as InstanceType<typeof DialogHandler>;
  assert.deepEqual(handler.splitDialogHeading('选择范围 — 请选择分析半径', '请选择'), {
    title: '选择范围', message: '请选择分析半径',
  });
  assert.deepEqual(handler.splitOption('核心范围 — 场馆周边 1 公里'), {
    label: '核心范围', description: '场馆周边 1 公里',
  });
});
