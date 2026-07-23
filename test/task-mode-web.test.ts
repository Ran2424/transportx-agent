const { test } = require('node:test');
const assert = require('node:assert/strict');

function task(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, taskId: 'task-1', title: '分析道路拥堵', status: 'running', revision: 2, steps: [{ id: 'collect', title: '收集数据', status: 'completed', completedAt: 10 }, { id: 'analyze', title: '分析结果', status: 'running', startedAt: 11 }], activeStepId: 'analyze', createdAt: 1, updatedAt: 11, ...overrides };
}

test('task contract parses versioned tool details and rejects inconsistent snapshots', async () => {
  const { parseTaskSnapshot, parseTaskToolResult } = await import('../src/contracts/task.ts');
  assert.equal(parseTaskToolResult({ details: { kind: 'tau-task', task: task() } })?.activeStepId, 'analyze');
  assert.equal(parseTaskToolResult({ details: { kind: 'tau-interaction', task: task({ status: 'waiting_user', revision: 3 }) } })?.status, 'waiting_user');
  assert.equal(parseTaskToolResult({ details: { kind: 'other', task: task() } }), null);
  assert.equal(parseTaskSnapshot(task({ activeStepId: 'missing' })), null);
  assert.equal(parseTaskSnapshot(task({ steps: [{ id: 'a', title: 'A', status: 'running' }, { id: 'b', title: 'B', status: 'running' }], activeStepId: 'a' })), null);
});

test('task contract recognizes mode and persisted task state entries', async () => {
  const { parseTaskModeEntry, parseTaskStateEntry } = await import('../src/contracts/task.ts');
  assert.equal(parseTaskModeEntry({ type: 'custom', customType: 'pi-task-mode', data: { enabled: true } }), true);
  assert.equal(parseTaskModeEntry({ type: 'custom', customType: 'pi-task-mode', data: { enabled: false } }), false);
  assert.equal(parseTaskModeEntry({ type: 'custom', customType: 'other', data: { enabled: true } }), null);
  assert.equal(parseTaskStateEntry({ type: 'custom', customType: 'pi-task-mode', data: { enabled: true, task: task({ status: 'interrupted', revision: 3, activeStepId: undefined, steps: [{ id: 'collect', title: '收集数据', status: 'completed' }, { id: 'analyze', title: '分析结果', status: 'blocked' }] }) } })?.task?.status, 'interrupted');
});

test('task revision guard accepts a later task when its revision restarts at one', async () => {
  const { acceptTaskSnapshotRevision } = await import('../src/contracts/task.ts');
  const first = task({
    taskId: 'task-1',
    title: '第一项任务',
    status: 'completed',
    revision: 6,
    activeStepId: undefined,
    steps: [{ id: 'collect', title: '收集数据', status: 'completed' }, { id: 'analyze', title: '分析结果', status: 'completed' }],
    createdAt: 1,
    updatedAt: 6,
  });
  const second = task({
    taskId: 'task-2',
    title: '第二项任务',
    status: 'planning',
    revision: 1,
    activeStepId: undefined,
    steps: [{ id: 'prepare', title: '准备数据', status: 'pending' }, { id: 'report', title: '输出报告', status: 'pending' }],
    createdAt: 7,
    updatedAt: 7,
  });
  assert.equal(acceptTaskSnapshotRevision(first as any, second as any).accepted, true);
  assert.equal(acceptTaskSnapshotRevision(first as any, task({ revision: 5 }) as any).accepted, false);
});
