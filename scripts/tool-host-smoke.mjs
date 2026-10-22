// Real Pi, production Host routes/assembly and isolated, explicitly authorized fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const appRoot = path.resolve(process.env.TRANSPORTX_SMOKE_APP_ROOT || '.');
const baseline = process.env.TRANSPORTX_SMOKE_BASELINE === '1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-tool-host-'));
const source = path.join(root, 'probe');
fs.mkdirSync(source);
const marker = path.join(root, 'loaded');
const aborted = path.join(root, 'aborted');
const started = path.join(root, 'started');
const reloaded = path.join(root, 'reloaded');
fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ manifestVersion: 2, id: 'local.p0-probe', name: 'Authorized P0 fixture', version: '1.0.0', type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [], entrypoints: { piExtensions: ['index.ts'] } }));
fs.writeFileSync(path.join(source, 'index.ts'), `
import fs from 'node:fs';
import { Type } from 'typebox';
export default function(pi) {
  fs.writeFileSync(${JSON.stringify(marker)}, 'loaded');
  pi.registerCommand('p0_reload', { description: 'Reload only approved resources', handler: async (_, ctx) => { await ctx.reload(); fs.writeFileSync(${JSON.stringify(reloaded)}, 'done'); } });
  pi.registerTool({ name: 'tau_p0_probe', label: 'P0 probe', description: 'Isolated trust and Pi error/signal probe', parameters: Type.Object({ mode: Type.String() }),
    async execute(id, params, signal, update, ctx) {
      const file = ctx.sessionManager.getSessionFile();
      const persisted = file && fs.existsSync(file);
      fs.writeFileSync(${JSON.stringify(started)}, JSON.stringify({ id, file, persisted, header: persisted ? JSON.parse(fs.readFileSync(file, 'utf8').split('\\n')[0]) : null }));
      if (params.mode === 'fail') throw new Error('p0_expected_failure');
      if (params.mode === 'cancel') await new Promise((resolve, reject) => {
        const cancel = () => { fs.writeFileSync(${JSON.stringify(aborted)}, 'signal'); reject(new Error('p0_cancel_confirmed')); };
        if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
      });
      return { content: [{ type: 'text', text: 'p0_ok' }], details: { kind: 'p0-probe' } };
    }
  });
}`);
const providerInputs = [];
const provider = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); providerInputs.push(body);
  const last = body.messages.at(-1);
  const text = typeof last.content === 'string' ? last.content : (last.content || []).map((part) => part.text || '').join('\n');
  const tool = last.role === 'user' ? { name: 'tau_p0_probe', arguments: JSON.stringify({ mode: text.trim().split('\n')[0] }) } : null;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null) => ({ id: 'probe', object: 'chat.completion.chunk', created: 1, model: 'smoke', choices: [{ index: 0, delta, finish_reason }] });
  res.write(`data: ${JSON.stringify(chunk(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${providerInputs.length}`, type: 'function', function: tool }] } : { role: 'assistant', content: 'probe_done' }))}\n\n`);
  res.write(`data: ${JSON.stringify(chunk({}, tool ? 'tool_calls' : 'stop'))}\n\n`); res.end('data: [DONE]\n\n');
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ providers: { probe: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'local-only', models: [{ id: 'smoke', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
// Automatic discovery must not execute an Extension in either global or project paths.
const autoExtension = `import fs from 'node:fs'; export default () => fs.writeFileSync(${JSON.stringify(path.join(root, 'auto-loaded'))}, 'unsafe');`;
fs.mkdirSync(path.join(root, 'extensions'));
fs.writeFileSync(path.join(root, 'extensions', 'untrusted.ts'), autoExtension);
let stderr = '', stdout = '', accept = false, trustDecisions = 0;
const child = spawn(process.execPath, [path.join(appRoot, 'bin/tau.js'), '--desktop', '--parent-pid', String(process.pid)], {
  cwd: appRoot, env: { ...process.env, TAU_APP_ROOT: appRoot, TAU_RESOURCES_DIR: appRoot, TAU_USER_DATA_DIR: root, PI_CODING_AGENT_DIR: root, PI_CODING_AGENT_SESSION_DIR: path.join(root, 'sessions'), TAU_PI_ENTRYPOINT: path.join(appRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
child.on('message', (message) => {
  if (message.type !== 'transportx-module-trust-request') return;
  trustDecisions++;
  assert.equal(message.request.id, 'local.p0-probe');
  child.send({ type: 'transportx-module-trust-response', id: message.id, accepted: accept });
});
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check(); if (value) return value;
    if (child.exitCode !== null) throw new Error(`Host exited: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}; ${stderr}`);
}
let endpoint;
const samples = [];
try {
  const ready = await until(() => stdout.split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((value) => value?.type === 'transportx-agent-host-ready'), 'Host ready');
  endpoint = `http://127.0.0.1:${ready.port}`;
  async function json(url, body) {
    const response = await fetch(endpoint + url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value)); return value;
  }
  const rpc = (body) => json('/api/rpc', body);
  if (!baseline) {
    assert.equal((await rpc({ type: 'install_module', sourcePath: source, trusted: true })).success, false);
    assert.equal(fs.existsSync(marker), false, 'rejected code is neither imported nor executed');
  }
  accept = true; // User-requested development acceptance authorizes only this test-owned fixture.
  assert.equal((await rpc({ type: 'install_module', sourcePath: source })).success, true);
  assert.equal(fs.existsSync(marker), false, 'installation never evaluates extensions');
  const sessions = [];
  for (let index = 0; index < 5; index++) {
    const begin = performance.now();
    const created = await json('/api/live-sessions', { cwd: path.join(root, 'scenario'), model: 'probe/smoke', name: `P0 ${index}` });
    const session = created.session; sessions.push(session);
    fs.rmSync(started, { force: true });
    assert.equal((await rpc({ type: 'prompt', sessionId: session.id, message: 'success' })).success, true);
    await until(() => fs.existsSync(started), 'first Pi tool');
    await until(async () => !(await json(`/api/live-sessions/${session.id}/snapshot`)).isStreaming, 'first turn settled');
    await rpc({ type: 'get_state', sessionId: session.id });
    const entries = await until(async () => {
      const response = await json(`/api/live-sessions/${session.id}/snapshot`);
      return response.entries.some((entry) => entry.customType === 'pi-web-bridge') && response.entries;
    }, 'production Bridge');
    const bridge = entries.filter((entry) => entry.customType === 'pi-web-bridge').at(-1).data;
    assert.ok(bridge.tools.some((tool) => tool.name === 'tau_p0_probe' && tool.active));
    samples.push({ startupToFirstToolHistoryAndBridgeMs: Math.round(performance.now() - begin), tools: bridge.tools.length, moduleCount: JSON.parse(fs.readFileSync(path.join(session.cwd, '.tau/resolved-session-plan.json'), 'utf8')).modules.length });
    fs.mkdirSync(path.join(session.cwd, '.pi/extensions'), { recursive: true });
    fs.writeFileSync(path.join(session.cwd, '.pi/extensions/untrusted.ts'), autoExtension);
    if (index < 4) await fetch(`${endpoint}/api/live-sessions/${session.id}`, { method: 'DELETE' });
  }
  const session = sessions.at(-1);
  const snapshot = () => json(`/api/live-sessions/${session.id}/snapshot`);
  assert.equal((await rpc({ type: 'prompt', sessionId: session.id, message: '/p0_reload' })).success, true);
  await until(() => fs.existsSync(reloaded), 'Pi resource reload');
  for (const mode of ['fail', 'cancel', 'success']) {
    fs.rmSync(started, { force: true });
    assert.equal((await rpc({ type: 'prompt', sessionId: session.id, message: mode })).success, true);
    await until(() => fs.existsSync(started), 'Pi tool started');
    const owner = JSON.parse(fs.readFileSync(started, 'utf8'));
    assert.equal(owner.persisted, true, 'Pi flushes the header before the first tool executes');
    assert.equal(fs.realpathSync(owner.header.cwd), fs.realpathSync(session.cwd));
    assert.ok(owner.header.id);
    if (mode === 'cancel') {
      assert.equal((await rpc({ type: 'abort', sessionId: session.id })).success, true);
      await until(() => fs.existsSync(aborted), 'Pi execute AbortSignal');
    }
    await until(async () => !(await snapshot()).isStreaming, 'Pi settled');
  }
  const final = await snapshot();
  const results = final.entries.filter((entry) => entry.message?.role === 'toolResult').map((entry) => entry.message);
  assert.ok(results.some((result) => result.isError && JSON.stringify(result).includes('p0_expected_failure')));
  assert.ok(results.some((result) => !result.isError && JSON.stringify(result).includes('p0_ok')));
  if (!baseline) {
    assert.equal(fs.existsSync(path.join(root, 'auto-loaded')), false, 'global/project auto-discovery stays disabled across reload');
    assert.equal(trustDecisions, 2, 'accepted package scope is reused on every session startup');
  }
  const persisted = fs.readFileSync(final.sessionFile, 'utf8');
  assert.match(persisted, /p0_expected_failure/); assert.match(persisted, /p0_ok/);
  console.log(JSON.stringify({ phase: baseline ? 'before P0 trust changes' : 'P0', pi: '0.80.10', node: process.version, platform: `${process.platform}/${process.arch}`, cpu: os.cpus()[0].model, memoryGiB: Math.round(os.totalmem() / 2 ** 30), samples, errorsUsePiChannel: true, executeSignalObserved: true, headerPersistedBeforeFirstTool: true, ...(!baseline ? { rejectedCodeNeverLoaded: true, automaticDiscoveryBlocked: true } : {}), historyVerified: true, harnessRssBytes: process.memoryUsage().rss }, null, 2));
} finally {
  if (child.exitCode === null) {
    const closed = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
    await closed; clearTimeout(timer);
  }
  provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
