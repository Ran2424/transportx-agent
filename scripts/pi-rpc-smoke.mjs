import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-pi-rpc-smoke-'));
const command = process.env.TAU_PI_COMMAND || 'pi';
const child = spawn(command, [
  '--mode', 'rpc', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--approve',
  '--extension', path.resolve('extensions/pi-task-mode/index.ts'),
  '--extension', path.resolve('extensions/pi-web-bridge/index.ts'),
], {
  cwd: process.cwd(),
  env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TAU_DISABLED: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdoutBuffer = '';
let stderr = '';
const lines = [];
const waiters = new Set();
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });
child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk;
  const complete = stdoutBuffer.split(/\r?\n/);
  stdoutBuffer = complete.pop() || '';
  for (const line of complete) {
    try { lines.push(JSON.parse(line)); } catch { /* Pi diagnostics are not RPC messages. */ }
  }
  for (const notify of waiters) notify();
});

function waitFor(predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
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
}

function send(payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

try {
  send({ id: 'state', type: 'get_state' });
  const state = await waitFor((line) => line.type === 'response' && line.id === 'state');
  assert.equal(state.success, true);
  assert.equal(state.command, 'get_state');

  send({ id: 'entries', type: 'get_entries' });
  const entries = await waitFor((line) => line.type === 'response' && line.id === 'entries');
  const bridge = entries.data?.entries?.find((entry) => entry.type === 'custom' && entry.customType === 'pi-web-bridge');
  assert.equal(bridge?.data?.schemaVersion, 1);
  assert.ok(Array.isArray(bridge?.data?.tools));
  assert.ok(bridge.data.tools.some((candidate) => candidate.name === 'tau_task'));

  send({ id: 'commands', type: 'get_commands' });
  const commands = await waitFor((line) => line.type === 'response' && line.id === 'commands');
  assert.equal(commands.success, true);
  assert.ok(commands.data?.commands?.some((candidate) => candidate.name === 'task'));

  send({ id: 'task-on', type: 'prompt', message: '/task on' });
  assert.equal((await waitFor((line) => line.type === 'response' && line.id === 'task-on')).success, true);
  const appended = await waitFor((line) => line.type === 'entry_appended' && line.entry?.customType === 'pi-task-mode');
  assert.equal(appended.entry?.data?.enabled, true);
  console.log('Pi RPC smoke passed: bridge, task command, and task-mode event are available.');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  fs.rmSync(agentDir, { recursive: true, force: true });
}
