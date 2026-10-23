import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-pi-rpc-smoke-'));
let releaseFirst;
let calls = 0;
const provider = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const complete = () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finish_reason = null) => ({ id: 'smoke', object: 'chat.completion.chunk', created: 1, model: 'smoke', choices: [{ index: 0, delta, finish_reason }] });
      res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'smoke answer' }))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    if (++calls === 1) releaseFirst = complete; else complete();
  });
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: {
  'traffic-smoke': { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'local-smoke-only', models: [{ id: 'smoke', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
} }));
const command = process.env.TAU_PI_COMMAND || process.execPath;
const child = spawn(command, [
  ...(process.env.TAU_PI_COMMAND ? [] : [path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js')]),
  '--mode', 'rpc', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--approve',
  '--extension', path.resolve('modules/capabilities/interaction/extensions/pi-user-interaction/index.ts'),
  '--extension', path.resolve('modules/capabilities/web-bridge/extensions/pi-web-bridge/index.ts'),
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
  const interactionTool = bridge.data.tools.find((candidate) => candidate.name === 'tau_ask_user');
  assert.ok(interactionTool?.active);
  assert.ok(!bridge.data.tools.some((candidate) => candidate.name === 'tau_task'));
  assert.equal('taskEnvelopeVersion' in bridge.data.capabilities, false);

  send({ id: 'commands', type: 'get_commands' });
  const commands = await waitFor((line) => line.type === 'response' && line.id === 'commands');
  assert.equal(commands.success, true);
  assert.ok(!commands.data?.commands?.some((candidate) => candidate.name === 'task'));
  send({ id: 'smoke-model', type: 'set_model', provider: 'traffic-smoke', modelId: 'smoke' });
  assert.equal((await waitFor((line) => line.id === 'smoke-model')).success, true);
  send({ id: 'initial', type: 'prompt', message: 'initial message' });
  assert.equal((await waitFor((line) => line.id === 'initial')).success, true);
  // Hold the provider response until both queues are populated.
  const deadline = Date.now() + 10_000;
  while (!releaseFirst) {
    assert.ok(Date.now() < deadline, 'local model request started');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  send({ id: 'follow', type: 'follow_up', message: 'follow-up message' });
  assert.equal((await waitFor((line) => line.id === 'follow')).success, true);
  send({ id: 'steer', type: 'steer', message: 'steering message' });
  assert.equal((await waitFor((line) => line.id === 'steer')).success, true);
  send({ id: 'rejected', type: 'prompt', message: 'cannot prompt while streaming' });
  assert.equal((await waitFor((line) => line.id === 'rejected')).success, false);
  releaseFirst();
  await waitFor((line) => line.type === 'message_start' && line.message?.role === 'user' && line.message.content?.some((block) => block.text === 'follow-up message'));
  await waitFor((line) => line.type === 'agent_settled');
  const users = lines.filter((line) => line.type === 'message_start' && line.message?.role === 'user');
  assert.deepEqual(users.map((line) => line.message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')), ['initial message', 'steering message', 'follow-up message']);
  assert.ok(users.every((line) => line.id === undefined && line.message.id === undefined), 'Pi user messages do not echo the command id');
  console.log('Pi RPC smoke passed: bridge, Interaction registration, rejection ACK, text correlation and steer-before-follow-up delivery (local provider).');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  fs.rmSync(agentDir, { recursive: true, force: true });
}
