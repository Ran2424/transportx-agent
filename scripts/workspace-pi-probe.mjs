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
  res.write(`data: ${JSON.stringify(chunk(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `probe-${providerCalls}`, type: 'function', function: tool }] } : { role: 'assistant', content: 'workspace probe complete' }))}\n\n`);
  res.write(`data: ${JSON.stringify(chunk({}, tool ? 'tool_calls' : 'stop'))}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ providers: { probe: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'local-probe-only', models: [{ id: 'smoke', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
const env = { ...process.env, TAU_APP_ROOT: repo, TAU_RESOURCES_DIR: repo, TAU_PI_ENTRYPOINT: cli, TAU_USER_DATA_DIR: root, PI_CODING_AGENT_DIR: root, PI_CODING_AGENT_SESSION_DIR: path.join(root, 'sessions') };
let host;
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
  const json = async (route, body) => {
    const response = await fetch(endpoint + route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value)); return value;
  };
  const results = (state) => state.entries.filter((entry) => entry.message?.role === 'toolResult').map((entry) => entry.message);
  const execute = async (session, name, args) => {
    const before = new Set(results(await json(`/api/live-sessions/${session.id}/snapshot`)).map((result) => result.toolCallId));
    const ack = await json('/api/rpc', { type: 'prompt', sessionId: session.id, message: 'probe:' + JSON.stringify({ name, arguments: JSON.stringify(args) }) });
    assert.equal(ack.success, true, JSON.stringify(ack));
    let state;
    try { state = await until(async () => { const state = await json(`/api/live-sessions/${session.id}/snapshot`); return !state.isStreaming && results(state).some((result) => result.toolName === name && !before.has(result.toolCallId)) && state; }, name, 15000); }
    catch (error) { report.failedSnapshot = await json(`/api/live-sessions/${session.id}/snapshot`); throw error; }
    const result = results(state).at(-1); assert.equal(result.isError, false, JSON.stringify(result)); return { state, result };
  };
  const saved = [];
  for (const domain of ['cad', 'spatial-analysis']) {
    const option = (await json('/api/platform/session-options')).modules.find((item) => item.id === `com.transportx.${domain}`);
    if (domain === 'cad') assert.ok(option?.enabledForNewSessions);
    // Spatial is a required workbench capability, not an optional module choice.
    const profile = defaultSessionProfile(option ? [{ id: option.id, version: option.version }] : []);
    const session = (await json('/api/live-sessions', { cwd: path.join(root, 'scenario'), name: `T2 first ${domain}`, model: 'probe/smoke', profile })).session;
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
  for (const item of saved) {
    const before = sha(item.state.sessionFile);
    const session = (await json('/api/live-sessions/resume', { filePath: item.state.sessionFile, cwd: item.session.cwd, model: 'probe/smoke' })).session;
    assert.notEqual(session.id, item.session.id);
    const name = item.domain === 'cad' ? 'cad_execution' : 'tau_spatial_execution';
    const operationId = report.T2.find((entry) => entry.domain === item.domain).operationId;
    const { result } = await execute(session, name, { action: 'query', operationId });
    assert.equal(result.details.state || (result.details.result ? 'succeeded' : null), 'succeeded');
    const owner = fs.readFileSync(audit, 'utf8').trim().split('\n').map(JSON.parse).findLast((entry) => entry.sessionId === session.id && entry.owner)?.owner;
    assert.deepEqual(owner, item.owner);
    Object.assign(report.T2.find((entry) => entry.domain === item.domain), { restartOwner: owner, querySucceeded: true, historyBeforeQuerySha256: before });
  }
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack; throw error;
} finally {
  if (host) await stop(host);
  provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve));
  const output = path.resolve(process.env.TRANSPORTX_WORKSPACE_PROBE_REPORT || '.plans/workspace-conversations/pi-probe.json');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, report: output, T1: report.T1.map(({ scenario, bytes }) => ({ scenario, bytes })), T2: report.T2.map(({ domain, result, querySucceeded }) => ({ domain, result, querySucceeded })) }));
  fs.rmSync(root, { recursive: true, force: true });
}
