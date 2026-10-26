import { createHostConversation, nativeSnapshot, protocolHeaders } from './harness/workspace-client.mjs';
// T1/T2 prerequisites. Real Pi and production Host; only model responses are scripted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { defaultSessionProfile } from '../src/contracts/session-profile.ts';

const repo = process.cwd();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-workspace-probe-'));
const cli = path.join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const report = { at: new Date().toISOString(), baseline: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), pi: JSON.parse(fs.readFileSync(path.join(path.dirname(cli), '../package.json'))).version, node: process.version, platform: `${process.platform}/${process.arch}`, T1: [], T2: [], modelCalls: [] };
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const header = (file) => {
  if (!file || !fs.existsSync(file)) return null;
  const first = fs.readFileSync(file, 'utf8').split('\n')[0];
  try { const value = JSON.parse(first); return value.type === 'session' && value.id && value.cwd ? value : null; } catch { return null; }
};
async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error(`Timed out: ${label}`);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
  try { await closed; } finally { clearTimeout(timer); }
}

let mode = 'normal';
let releaseProvider;
let streamedReplies = 0;
let providerCalls = 0;
const provider = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); providerCalls++;
  if (mode === 'failure') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'workspace probe first-turn failure' } })); return; }
  if (mode === 'interrupt') return;
  const last = body.messages.at(-1);
  const user = body.messages.findLast((item) => item.role === 'user');
  const text = typeof user?.content === 'string' ? user.content : (user?.content || []).map((item) => item.text || '').join('\n');
  const request = text.startsWith('probe:') ? JSON.parse(text.slice(6).split('\n')[0]) : null;
  const previousTool = body.messages.findLast((item) => item.tool_calls)?.tool_calls.find((item) => item.id === last.tool_call_id)?.function.name;
  let tool = request && (last.role === 'user' || previousTool === 'manage_capabilities') ? request : null;
  if (tool && !body.tools.some((item) => item.function.name === tool.name)) tool = { name: 'manage_capabilities', arguments: JSON.stringify({ action: 'enable', moduleId: tool.name.startsWith('cad_') ? 'com.transportx.cad' : 'com.transportx.spatial-analysis' }) };
  report.modelCalls.push({ input: text.slice(0, 300), previousRole: last.role, previousTool, tool });
  const chunk = (delta, finish_reason = null) => ({ id: 'workspace-probe', object: 'chat.completion.chunk', created: 1, model: 'smoke', choices: [{ index: 0, delta, finish_reason }] });
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (mode === 'rename-stream') {
    const turn = ++streamedReplies;
    res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: `第${turn}轮改名期间保留的回答首段，` }))}\n\n`);
    await new Promise((resolve) => { releaseProvider = resolve; });
    res.write(`data: ${JSON.stringify(chunk({ content: `以及第${turn}轮改名后的回答尾段。` }))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`); res.end('data: [DONE]\n\n'); return;
  }
  res.write(`data: ${JSON.stringify(chunk(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `probe-${providerCalls}`, type: 'function', function: tool }] } : { role: 'assistant', content: 'workspace probe complete' }))}\n\n`);
  res.write(`data: ${JSON.stringify(chunk({}, tool ? 'tool_calls' : 'stop'))}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ providers: { probe: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'local-probe-only', models: [{ id: 'smoke', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
const env = { ...process.env, TAU_APP_ROOT: repo, TAU_RESOURCES_DIR: repo, TAU_PI_ENTRYPOINT: cli, TAU_USER_DATA_DIR: root, TAU_RUNTIME_COORDINATION_DIR: path.join(root, 'runtime-guards'), PI_CODING_AGENT_DIR: root, PI_CODING_AGENT_SESSION_DIR: path.join(root, 'sessions') };
let host, browser, diagnoseRename;
try {
  for (const scenario of ['empty', 'failure', 'interrupt', 'normal']) {
    mode = scenario;
    const cwd = path.join(root, `T1-${scenario}`); fs.mkdirSync(cwd);
    const file = path.join(root, 'sessions/transportx', `conv_${crypto.randomUUID()}.jsonl`);
    // Pi opens a reserved filename but does not create its parent directory.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-approve', '--model', 'probe/smoke', '--session', file], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', stderr = '', sequence = 0;
    const events = [], timeline = [];
    const observe = (event) => timeline.push({ at: new Date().toISOString(), event, header: header(file) });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) { try { const value = JSON.parse(line); events.push(value); if (['message_start', 'message_end', 'agent_settled'].includes(value.type)) observe(`${value.type}:${value.message?.role || ''}`); } catch {} }
    });
    const send = async (type, fields = {}) => {
      const id = `probe-${++sequence}`; child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n');
      return until(() => events.find((event) => event.id === id), `${scenario} ${type}: ${stderr}`);
    };
    try {
      const state = await send('get_state'); assert.equal(state.success, true);
      assert.equal(path.resolve(state.data.sessionFile), file); observe('startup');
      assert.equal(header(file), null, 'empty Pi session does not persist a fake header');
      if (scenario !== 'empty') {
        const before = providerCalls;
        assert.equal((await send('prompt', { message: 'Record the first-turn persistence boundary.' })).success, true);
        if (scenario === 'interrupt') { await until(() => providerCalls > before, 'pending provider request'); assert.equal((await send('abort')).success, true); }
        await until(() => events.some((event) => event.type === 'agent_settled'), `${scenario} settled`);
      }
      observe('before-stop');
      const bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
      report.T1.push({ scenario, reservedPath: path.relative(root, file).replaceAll('\\', '/'), bytes: bytes?.length || 0, timeline, errors: events.filter((event) => event.type === 'message_end' && event.message?.errorMessage).map((event) => event.message.errorMessage), stderr });
      if (scenario === 'normal') { assert.ok(header(file)); assert.equal(fs.realpathSync(header(file).cwd), fs.realpathSync(cwd)); }
      await stop(child); observe('after-stop');
      if (bytes) assert.deepEqual(fs.readFileSync(file), bytes, 'stopping does not replace existing history');
      if (scenario === 'normal') {
        const reopened = spawn(process.execPath, child.spawnargs.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = ''; reopened.stdout.on('data', (chunk) => { output += chunk; }); reopened.stderr.resume();
        try {
          reopened.stdin.write(JSON.stringify({ id: 'reopen', type: 'get_state' }) + '\n');
          await until(() => output.split('\n').some((line) => { try { return JSON.parse(line).id === 'reopen'; } catch { return false; } }), 'reopen nonempty history');
          assert.deepEqual(fs.readFileSync(file), bytes, 'opening an existing reserved history preserves its bytes');
        } finally { await stop(reopened); }
      }
    } finally { await stop(child); }
  }
  mode = 'normal';
  const audit = path.join(root, 'owner-audit.jsonl');
  const preload = path.join(root, 'owner-audit.cjs');
  fs.writeFileSync(preload, `
const fs = require('node:fs'), crypto = require('node:crypto');
const target = require(${JSON.stringify(path.join(repo, 'bin/util/execution-owner.js'))});
const original = target.executionOwner;
target.executionOwner = (session, sessionsDir) => {
 const file = session.sessionFile, first = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').split('\\n')[0]) : null;
 const record = { at: new Date().toISOString(), sessionId: session.id, cwd: session.cwd, file, header: first, planWorkspace: session.resolvedSessionPlan?.workspace, planSha256: crypto.createHash('sha256').update(JSON.stringify(session.resolvedSessionPlan)).digest('hex') };
 try { const owner = original(session, sessionsDir); fs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify({...record, owner})+'\\n'); return owner; }
 catch (error) { fs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify({...record, error: error.message})+'\\n'); throw error; }
};
const Pi = require(${JSON.stringify(path.join(repo, 'bin/sessions.js'))}).PiRpcSession;
const handle = Pi.prototype.handleEvent;
Pi.prototype.handleEvent = function(event) {
 if(event.type === 'tool_execution_start') fs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify({ at: new Date().toISOString(), event: event.type, toolName: event.toolName, sessionId: this.id, file: this.sessionFile, header: this.sessionFile && fs.existsSync(this.sessionFile) ? JSON.parse(fs.readFileSync(this.sessionFile,'utf8').split('\\n')[0]) : null })+'\\n');
 return handle.call(this,event);
};
`);
  const launchHost = async () => {
    const child = spawn(process.execPath, ['--require', preload, path.join(repo, 'bin/tau.js'), '--desktop', '--parent-pid', String(process.pid)], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    host = child;
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    const ready = await until(() => { if (child.exitCode !== null) throw new Error(stderr); return stdout.split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((item) => item?.type === 'transportx-agent-host-ready'); }, 'production Host ready');
    return `http://127.0.0.1:${ready.port}`;
  };
  let endpoint = await launchHost();
  const json = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(endpoint + route, { method, headers: { 'Content-Type': 'application/json', ...protocolHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value)); return value;
  };
  await until(async () => (await json('/api/health')).dataState === 'ready', 'Host data inventory');
  const results = (state) => state.entries.filter((entry) => entry.message?.role === 'toolResult').map((entry) => entry.message);
  const execute = async (session, name, args) => {
    const before = new Set(results(await nativeSnapshot(json, session.conversationId)).map((result) => result.toolCallId));
    const ack = await json('/api/rpc', { type: 'prompt', sessionId: session.id, message: 'probe:' + JSON.stringify({ name, arguments: JSON.stringify(args) }) });
    assert.equal(ack.success, true, JSON.stringify(ack));
    let state;
    try { state = await until(async () => { const state = await nativeSnapshot(json, session.conversationId); return !state.isStreaming && results(state).some((result) => result.toolName === name && !before.has(result.toolCallId)) && state; }, name, 15000); }
    catch (error) { report.failedSnapshot = await nativeSnapshot(json, session.conversationId); throw error; }
    const result = results(state).at(-1); assert.equal(result.isError, false, JSON.stringify(result)); return { state, result };
  };
  const saved = [];
  for (const domain of ['cad', 'spatial-analysis']) {
    const option = (await json('/api/platform/session-options')).modules.find((item) => item.id === `com.transportx.${domain}`);
    if (domain === 'cad') assert.ok(option?.enabledForNewSessions);
    // Spatial is a required workbench capability, not an optional module choice.
    const profile = defaultSessionProfile(option ? [{ id: option.id, version: option.version }] : []);
    const session = await createHostConversation(json, { parentDirectory: path.join(root, 'scenario'), name: `T2 first ${domain}`, model: 'probe/smoke', profile });
    assert.equal(header(session.sessionFile), null, 'T2 must start with an unpersisted session');
    const points = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { kind: 'road' }, geometry: domain === 'cad' ? { type: 'LineString', coordinates: [[121.44, 31.19], [121.441, 31.19]] } : { type: 'Point', coordinates: [121.44, 31.19] } }] };
    fs.writeFileSync(path.join(session.cwd, 'input.geojson'), JSON.stringify(points));
    const tool = domain === 'cad' ? 'cad_draw' : 'tau_spatial_analyze';
    const args = domain === 'cad' ? { kind: 'from-geojson', fileId: 'first', sourcePath: 'input.geojson', sourceCrs: 'EPSG:4326', target: { kind: 'local', origin: [121.44, 31.19] }, layerMap: { road: 'ROADS' } } : { operation: 'buffer', inputPath: 'input.geojson', inputCrs: 'EPSG:4326', metricCrs: 'EPSG:32651', distanceMeters: 10 };
    const { state, result } = await execute(session, tool, args);
    const records = fs.readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse).filter((item) => item.sessionId === session.id);
    const dispatch = records.find((item) => item.toolName === tool); assert.ok(dispatch?.header, 'valid header exists at first domain tool dispatch');
    const owned = records.filter((item) => item.owner); assert.ok(owned.length); assert.ok(records.every((item) => !item.error));
    assert.ok(owned.every((item) => fs.realpathSync(item.header.cwd) === fs.realpathSync(session.cwd) && fs.realpathSync(item.planWorkspace) === fs.realpathSync(session.cwd) && item.owner.piSessionId === dispatch.header.id));
    saved.push({ session, state, result, owner: owned[0].owner, domain });
    report.T2.push({ domain, records, operationId: result.details.operationId || result.details.result.analysisId, result: 'succeeded' });
  }
  await stop(host); endpoint = await launchHost();
  await until(async () => (await json('/api/health')).dataState === 'ready', 'restarted Host data inventory');
  for (const item of saved) {
    const before = sha(item.state.sessionFile);
    const session = (await json(`/api/conversations/${item.session.conversationId}/activate`, {})).runtime;
    assert.notEqual(session.id, item.session.id);
    const name = item.domain === 'cad' ? 'cad_execution' : 'tau_spatial_execution';
    const operationId = report.T2.find((entry) => entry.domain === item.domain).operationId;
    const { result } = await execute(session, name, { action: 'query', operationId });
    assert.equal(result.details.state || (result.details.result ? 'succeeded' : null), 'succeeded');
    const owner = fs.readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse).findLast((entry) => entry.sessionId === session.id && entry.owner)?.owner;
    assert.deepEqual(owner, item.owner);
    Object.assign(report.T2.find((entry) => entry.domain === item.domain), { restartOwner: owner, querySucceeded: true, historyBeforeQuerySha256: before });
  }
  // #90/#36: real Pi writes its own Native history; only the provider is controlled.
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ channel: process.env.TAU_BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ locale: 'zh-CN' }), uiErrors = [];
  page.on('pageerror', (error) => uiErrors.push(error.message));
  const frames = [];
  page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => { try { frames.push(JSON.parse(String(payload))); } catch {} }));
  const session = await createHostConversation(json, { name: '改名与保存复验', model: 'probe/smoke', parentDirectory: path.join(root, 'scenario') });
  const id = session.conversationId, route = `/api/conversations/${id}`, original = await json(`${route}/snapshot`), file = path.join(root, 'sessions', original.conversation.history.key);
  diagnoseRename = async () => ({ state: await json(`${route}/snapshot`), browserText: await page.locator('body').innerText(), frames: frames.slice(-100), uiErrors });
  const rename = async (name) => { const workspace = await json(`/api/workspaces/${session.workspaceId}`); return json(route, { name, expectedRevision: workspace.revision }, 'PATCH'); };
  await rename('首轮落盘前改名'); assert.equal(fs.existsSync(file), false, 'renaming cannot precreate the Native file');
  await page.goto(endpoint, { waitUntil: 'networkidle' });
  await page.evaluate((id) => localStorage.setItem('tau-active-conversation-id', id), id); await page.reload({ waitUntil: 'networkidle' });
  const composer = page.getByLabel('消息输入'); await composer.waitFor();
  mode = 'rename-stream'; await composer.fill('你好'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('第1轮改名期间保留的回答首段，', { exact: false }).first().waitFor();
  await page.locator('.session-row.is-active').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '重命名会话', exact: true });
  await dialog.locator('input').fill('生成中改名'); await dialog.getByRole('button', { name: '保存', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  const partial = await json(`${route}/snapshot`); assert.equal(partial.runtime.id, session.id); assert.equal(partial.snapshot.isStreaming, true);
  assert.equal(fs.existsSync(file), false, 'first reply is still unflushed during rename');
  await page.reload({ waitUntil: 'networkidle' }); await page.getByText('第1轮改名期间保留的回答首段，', { exact: false }).first().waitFor();
  releaseProvider(); releaseProvider = null; mode = 'normal';
  const rows = (state, role) => state.entries.filter((entry) => entry.message?.role === role);
  const settled = (count) => until(async () => { const state = await nativeSnapshot(json, id); return !state.isStreaming && rows(state, 'user').length === count && rows(state, 'assistant').length === count && state; }, `rename/persistence ${count} turns`);
  await settled(1); await page.getByText('以及第1轮改名后的回答尾段。', { exact: false }).first().waitFor();
  const firstMessages = JSON.parse(JSON.stringify(rows(await nativeSnapshot(json, id), 'assistant'))), firstNativeId = header(file).id;
  mode = 'rename-stream'; await composer.fill('你好'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('第2轮改名期间保留的回答首段，', { exact: false }).first().waitFor();
  await rename('已有历史生成中改名'); const secondPartial = await json(`${route}/snapshot`);
  assert.equal(secondPartial.runtime.id, session.id); assert.equal(secondPartial.snapshot.isStreaming, true); assert.equal(header(file).id, firstNativeId);
  await page.reload({ waitUntil: 'networkidle' }); await page.getByText('第2轮改名期间保留的回答首段，', { exact: false }).first().waitFor();
  releaseProvider(); releaseProvider = null; mode = 'normal';
  const secondSettled = await settled(2); assert.deepEqual(rows(secondSettled, 'assistant').slice(0, 1), firstMessages, 'renaming with an existing Native file preserves the prior reply');
  await page.getByText('以及第2轮改名后的回答尾段。', { exact: false }).first().waitFor();
  await until(async () => await page.getByText('你好', { exact: true }).count() === 2, 'both identical greetings remain visible');
  await rename('Untitled'); assert.equal((await json(`${route}/snapshot`)).runtime.sessionName, 'Untitled', 'an explicit title must agree in Manifest and live runtime');
  await json(`${route}/close`, { stopCurrent: true }); await rename('离线改名');
  // Reproduce the old Host's unstructured name tail in this test-owned file.
  fs.appendFileSync(file, JSON.stringify({ type: 'session_info', name: '旧 Host 尾部名称', explicit: true, timestamp: new Date().toISOString() }) + '\n');
  const bytes = fs.readFileSync(file), nativeId = header(file).id;
  await stop(host); endpoint = await launchHost(); await until(async () => (await json('/api/health')).dataState === 'ready', 'rename restart inventory');
  const restored = await json(`${route}/snapshot`); assert.equal(restored.conversation.name, '离线改名'); assert.equal(restored.runtime, null); assert.equal(restored.conversation.history.key, original.conversation.history.key); assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(rows(restored.snapshot, 'user').length, 2); assert.equal(rows(restored.snapshot, 'assistant').length, 2);
  await page.goto(endpoint, { waitUntil: 'networkidle' }); await page.evaluate((id) => localStorage.setItem('tau-active-conversation-id', id), id); await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '激活此会话', exact: true }).click(); await composer.waitFor();
  await composer.fill('你好'); await page.getByRole('button', { name: '发送消息', exact: true }).click(); await settled(3);
  assert.equal(header(file).id, nativeId); await page.reload({ waitUntil: 'networkidle' }); await until(async () => await page.getByText('你好', { exact: true }).count() === 3, 'three identical greetings survive restart and reload'); assert.deepEqual(uiErrors, []);
  assert.deepEqual(fs.readFileSync(file).subarray(0, bytes.length), bytes, 'legacy recovery and the third turn retain every prior Native byte');
  report.renamePersistence = { passed: true, firstFlushDeferred: true, streamedRename: true, existingHistoryStreamRename: true, reloadDuringStream: true, repeatedGreetings: 3, restarted: true, legacyNameTailRecovered: true, nativeIdentityPreserved: true, originalWindowsMiniMaxReproduced: false };
  report.passed = true;
} catch (error) {
  if (diagnoseRename) { try { report.renameFailure = await diagnoseRename(); } catch {} }
  report.passed = false; report.error = error.stack; throw error;
} finally {
  releaseProvider?.();
  if (browser) await browser.close();
  if (host) await stop(host);
  provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve));
  const output = path.resolve(process.env.TRANSPORTX_WORKSPACE_PROBE_REPORT || '.plans/workspace-conversations/pi-probe.json');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, report: output, T1: report.T1.map(({ scenario, bytes }) => ({ scenario, bytes })), T2: report.T2.map(({ domain, result, querySucceeded }) => ({ domain, result, querySucceeded })) }));
  fs.rmSync(root, { recursive: true, force: true });
}
