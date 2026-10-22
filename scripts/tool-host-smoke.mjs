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
const lifecyclePhase = process.env.TRANSPORTX_TOOL_SMOKE_PHASE === 'lifecycle';
const recoveryPhase = process.env.TRANSPORTX_TOOL_SMOKE_PHASE === 'recovery';
const citationPhase = process.env.TRANSPORTX_TOOL_SMOKE_PHASE === 'citation' || recoveryPhase || lifecyclePhase;
const spatialPhase = process.env.TRANSPORTX_TOOL_SMOKE_PHASE === 'spatial' || citationPhase;
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
  ${spatialPhase ? "pi.registerCommand('p1_spatial_endpoint', { description: 'Test-owned loopback fault relay', handler: async (value) => { const url = new URL(value.trim()); if (url.hostname !== '127.0.0.1') throw new Error('Only the local test relay is allowed'); process.env.TAU_SPATIAL_ENDPOINT = url.origin; } });" : ''}
  ${citationPhase ? "pi.registerCommand('p2_citation_endpoint', { description: 'Test-owned Citation relay', handler: async (value) => { const url = new URL(value.trim()); if (url.hostname !== '127.0.0.1') throw new Error('Only the local test relay is allowed'); process.env.TAU_CITATION_ENDPOINT = url.origin; } });" : ''}
  ${citationPhase ? "pi.registerCommand('p2_citation_active', { description: 'Test-owned native active-tool change', handler: async (value) => { const names = pi.getActiveTools().filter(name => name !== 'tau_resolve_citation'); pi.setActiveTools(value.trim() === 'off' ? names : [...names, 'tau_resolve_citation']); } });" : ''}
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
  if (req.url.startsWith('/citation-fixture')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (req.url.includes('slow=1')) {
      fs.writeFileSync(path.join(root, 'web-fetch-started'), 'started');
      res.write('<html><body>partial');
      const timer = setTimeout(() => res.end(' complete</body></html>'), 4000);
      res.on('close', () => { clearTimeout(timer); if (!res.writableEnded) fs.writeFileSync(path.join(root, 'web-fetch-aborted'), 'closed'); });
    } else res.end('<html><body>Controlled web snapshot.</body></html>');
    return;
  }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); providerInputs.push(body);
  const last = body.messages.at(-1);
  const text = typeof last.content === 'string' ? last.content : (last.content || []).map((part) => part.text || '').join('\n');
  const input = text.trim().split('\n')[0];
  const previousUser = body.messages.findLast((message) => message.role === 'user');
  const previousText = typeof previousUser?.content === 'string' ? previousUser.content : (previousUser?.content || []).map((part) => part.text || '').join('\n');
  if (spatialPhase && last.role !== 'user' && previousText.startsWith('spatial-fail-model:')) {
    res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'injected model failure after an unknown Spatial result' } })); return;
  }
  const tool = last.role !== 'user' ? null : spatialPhase && (input.startsWith('spatial:') || input.startsWith('spatial-fail-model:'))
    ? { name: 'tau_spatial_analyze', arguments: input.slice(input.indexOf(':') + 1) }
    : spatialPhase && input.startsWith('spatial-status:') ? { name: 'tau_spatial_execution', arguments: input.slice('spatial-status:'.length) }
    : lifecyclePhase && input.startsWith('module-package:') ? { name: 'tau_module_package', arguments: input.slice('module-package:'.length) }
    : citationPhase && input.startsWith('citation:') ? { name: 'tau_resolve_citation', arguments: input.slice('citation:'.length) }
      : spatialPhase && input.startsWith('traffic:') ? { name: 'traffic_peak_hour', arguments: input.slice('traffic:'.length) }
      : { name: 'tau_p0_probe', arguments: JSON.stringify({ mode: input }) };
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
const preload = path.join(root, 'citation-network-fixture.mjs');
if (citationPhase) fs.writeFileSync(preload, `
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), dns = require('node:dns/promises'), https = require('node:https'), http = require('node:http');
const lookup = dns.lookup, request = https.request;
dns.lookup = (name, options) => name === 'citation.fixture.test' ? Promise.resolve([{ address: '203.0.113.10', family: 4 }]) : lookup(name, options);
https.request = (options, ...rest) => options.hostname === 'citation.fixture.test'
  ? http.request({ hostname: '127.0.0.1', port: ${provider.address().port}, path: options.path, method: options.method, headers: options.headers, signal: options.signal }, ...rest)
  : request(options, ...rest);
`);
const recoveryPreload = path.join(root, 'spatial-crash-fixture.mjs');
if (recoveryPhase) fs.writeFileSync(recoveryPreload, `
import fs from 'node:fs'; import { createRequire } from 'node:module';
const child = createRequire(import.meta.url)('node:child_process');
const spawn = child.spawn, rename = fs.renameSync, write = fs.writeFileSync;
const phaseFile = ${JSON.stringify(path.join(root, 'fault-phase'))}, countFile = ${JSON.stringify(path.join(root, 'python-dispatch-count'))};
const phase = () => fs.existsSync(phaseFile) ? fs.readFileSync(phaseFile, 'utf8') : '';
child.spawn = (...args) => {
 const processChild = spawn(...args);
 if (args[1]?.some(value => String(value).endsWith('/spatial_analysis.py'))) {
  write(countFile, String(Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : '0') + 1));
  write(${JSON.stringify(path.join(root, 'domain-child-pid'))}, String(processChild.pid));
  if (phase() === 'during_execution') setTimeout(() => process.kill(process.pid, 'SIGKILL'), 50);
 }
 return processChild;
};
fs.renameSync = (source, target) => {
 const manifest = String(target).includes('spatial-results') && String(target).endsWith('/manifest.json');
 if (manifest && phase() === 'before_commit') process.kill(process.pid, 'SIGKILL');
 const value = rename(source, target);
 if (manifest && phase() === 'after_commit') process.kill(process.pid, 'SIGKILL');
 return value;
};
`);
const hostExecutable = process.env.TRANSPORTX_SMOKE_HOST_EXECUTABLE;
function launchHost() {
const current = spawn(hostExecutable || process.execPath, [...(citationPhase ? ['--import', preload] : []), ...(recoveryPhase ? ['--import', recoveryPreload] : []), path.join(appRoot, 'bin/tau.js'), '--desktop', '--parent-pid', String(process.pid)], {
  cwd: fs.statSync(appRoot).isDirectory() ? appRoot : path.dirname(appRoot), env: { ...process.env, ...(hostExecutable ? { ELECTRON_RUN_AS_NODE: '1' } : {}), TAU_APP_ROOT: appRoot, TAU_RESOURCES_DIR: appRoot, TAU_USER_DATA_DIR: root, PI_CODING_AGENT_DIR: root, PI_CODING_AGENT_SESSION_DIR: path.join(root, 'sessions'), TAU_PI_ENTRYPOINT: path.join(appRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
current.stdout.on('data', (chunk) => { stdout += chunk; });
current.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
current.on('message', (message) => {
  if (message.type !== 'transportx-module-trust-request') return;
  trustDecisions++;
  assert.ok(message.request.id === 'local.p0-probe' || spatialPhase && message.request.id === 'local.traffic-peak');
  current.send({ type: 'transportx-module-trust-response', id: message.id, accepted: accept });
});
return current;
}
let child = launchHost();
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
  async function restartHost() {
    const previous = child;
    if (previous.exitCode === null && previous.signalCode === null) {
      const exited = new Promise((resolve) => previous.once('exit', resolve)); previous.kill('SIGKILL'); await exited;
    }
    stdout = ''; stderr = ''; child = launchHost();
    const ready = await until(() => stdout.split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((value) => value?.type === 'transportx-agent-host-ready'), 'restarted production Host');
    endpoint = `http://127.0.0.1:${ready.port}`;
    return endpoint;
  }
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
  if (!baseline) {
    const settingsPath = path.join(root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const hook = path.join(root, 'untrusted-package-hook.cjs');
    fs.writeFileSync(hook, `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'package-hook-ran'))}, 'unsafe');`);
    fs.writeFileSync(settingsPath, JSON.stringify({ ...settings, packages: ['npm:@transportx-p0/missing-fixture@0.0.0'], npmCommand: [process.execPath, hook] }));
  }
  assert.equal((await rpc({ type: 'prompt', sessionId: session.id, message: '/p0_reload' })).success, true);
  await until(() => fs.existsSync(reloaded), 'Pi resource reload');
  if (!baseline) {
    const extra = await json('/api/live-sessions', { cwd: path.join(root, 'scenario'), model: 'probe/smoke', name: 'P0 package-hook denial' });
    assert.equal((await rpc({ type: 'get_state', sessionId: extra.session.id })).success, true);
    await fetch(`${endpoint}/api/live-sessions/${extra.session.id}`, { method: 'DELETE' });
  }
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
    assert.equal(fs.existsSync(path.join(root, 'package-hook-ran')), false, 'resource reload must not install settings packages or run npm hooks');
    assert.equal(trustDecisions, 2, 'accepted package scope is reused on every session startup');
  }
  const persisted = fs.readFileSync(final.sessionFile, 'utf8');
  assert.match(persisted, /p0_expected_failure/); assert.match(persisted, /p0_ok/);
  const spatial = spatialPhase ? await (await import('./harness/spatial-host-smoke.mjs')).spatialHostSmoke({ root, endpoint, json, rpc, until, appRoot, providerInputs }) : undefined;
  const citation = citationPhase ? await (await import('./harness/citation-host-smoke.mjs')).citationHostSmoke({ root, endpoint, json, rpc, until, providerInputs }) : undefined;
  if (lifecyclePhase) for (const version of ['1.0.0', '1.0.1']) fs.cpSync(path.join(root, 'modules/local.traffic-peak', version), path.join(root, `lifecycle-backup-${version}`), { recursive: true });
  const lifecycle = lifecyclePhase ? await (await import('./harness/module-lifecycle-smoke.mjs')).moduleLifecycleSmoke({ root, endpoint, json, rpc, until }) : undefined;
  const authoring = lifecyclePhase ? await (await import('./harness/module-package-smoke.mjs')).modulePackageSmoke({ root, json, rpc, until }) : undefined;
  const recovery = recoveryPhase ? await (await import('./harness/spatial-recovery-smoke.mjs')).spatialRecoverySmoke({ root, json, rpc, until, restartHost, endpoint: () => endpoint }) : undefined;
  console.log(JSON.stringify({ phase: baseline ? 'before P0 trust changes' : citationPhase ? 'P2' : spatialPhase ? 'P1' : 'P0', pi: '0.80.10', node: process.version, platform: `${process.platform}/${process.arch}`, cpu: os.cpus()[0].model, memoryGiB: Math.round(os.totalmem() / 2 ** 30), samples, errorsUsePiChannel: true, executeSignalObserved: true, headerPersistedBeforeFirstTool: true, ...(!baseline ? { rejectedCodeNeverLoaded: true, automaticDiscoveryBlocked: true } : {}), historyVerified: true, spatial, citation, recovery, lifecycle, authoring, harnessRssBytes: process.memoryUsage().rss }, null, 2));
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
    await closed; clearTimeout(timer);
  }
  provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
