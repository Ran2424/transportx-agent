const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RUN_REAL_PI = process.env.TAU_RUN_PI_SMOKE === '1';

type RpcLine = {
  type?: string;
  id?: string;
  command?: string;
  success?: boolean;
  data?: Record<string, unknown>;
  entry?: { type?: string; customType?: string; data?: Record<string, unknown> };
};

test('real Pi RPC publishes commands, state, and appended extension entries', { skip: !RUN_REAL_PI, timeout: 20_000 }, async (t: import('node:test').TestContext) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-pi-rpc-smoke-'));
  const extensionPath = path.resolve('extensions/pi-task-mode/index.ts');
  const bridgeExtensionPath = path.resolve('extensions/pi-web-bridge/index.ts');
  const command = process.env.TAU_PI_COMMAND || 'pi';
  const child = spawn(command, [
    '--mode', 'rpc',
    '--offline',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--approve',
    '--extension', extensionPath,
    '--extension', bridgeExtensionPath,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TAU_DISABLED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGTERM');
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdoutBuffer = '';
  let stderr = '';
  const lines: RpcLine[] = [];
  const waiters = new Set<() => void>();
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    const complete = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = complete.pop() || '';
    for (const line of complete) {
      try { lines.push(JSON.parse(line)); } catch { /* Pi diagnostics stay out of RPC assertions. */ }
    }
    for (const notify of waiters) notify();
  });

  const waitFor = (predicate: (line: RpcLine) => boolean, timeoutMs = 10_000) => new Promise<RpcLine>((resolve, reject) => {
    const existing = lines.find(predicate);
    if (existing) return resolve(existing);
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(new Error(`Timed out waiting for Pi RPC output. stderr: ${stderr.trim() || '<empty>'}`));
    }, timeoutMs);
    const check = () => {
      const match = lines.find(predicate);
      if (!match) return;
      clearTimeout(timer);
      waiters.delete(check);
      resolve(match);
    };
    waiters.add(check);
  });

  const send = (payload: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(payload)}\n`);
  send({ id: 'state', type: 'get_state' });
  const state = await waitFor((line) => line.type === 'response' && line.id === 'state');
  assert.equal(state.success, true);
  assert.equal(state.command, 'get_state');

  send({ id: 'entries', type: 'get_entries' });
  const entries = await waitFor((line) => line.type === 'response' && line.id === 'entries');
  const bridge = (entries.data?.entries as Array<{ type?: string; customType?: string; data?: Record<string, unknown> }> | undefined)
    ?.find((entry) => entry.type === 'custom' && entry.customType === 'pi-web-bridge');
  assert.equal(bridge?.data?.schemaVersion, 1);
  assert.ok(Array.isArray(bridge?.data?.tools));
  assert.ok((bridge!.data!.tools as Array<{ name?: string }>).some((candidate) => candidate.name === 'tau_task'));

  send({ id: 'commands', type: 'get_commands' });
  const commands = await waitFor((line) => line.type === 'response' && line.id === 'commands');
  assert.equal(commands.success, true);
  assert.ok(Array.isArray(commands.data?.commands));
  assert.ok((commands.data!.commands as Array<{ name?: string }>).some((candidate) => candidate.name === 'task'));

  send({ id: 'task-on', type: 'prompt', message: '/task on' });
  const response = await waitFor((line) => line.type === 'response' && line.id === 'task-on');
  assert.equal(response.success, true);
  const appended = await waitFor((line) => line.type === 'entry_appended' && line.entry?.customType === 'pi-task-mode');
  assert.equal(appended.entry?.data?.enabled, true);
});
