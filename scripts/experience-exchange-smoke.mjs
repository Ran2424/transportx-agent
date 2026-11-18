import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as workspace from './harness/workspace-client.mjs';

const { values: args } = parseArgs({ options: {
  'traffic-root': { type: 'string' },
  'traffic-exe': { type: 'string' },
  evidence: { type: 'string' },
} });
assert.ok(args['traffic-root'] && args['traffic-exe'], 'Use --traffic-root PATH and --traffic-exe PATH after both builds.');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const trafficRepo = path.resolve(args['traffic-root']);
const trafficExe = path.resolve(args['traffic-exe']);
const evidenceRoot = path.resolve(args.evidence ?? os.tmpdir());
fs.mkdirSync(evidenceRoot, { recursive: true });
const run = fs.mkdtempSync(path.join(evidenceRoot, 'experience-exchange-'));
const trafficDir = path.join(run, 'traffic');
const profile = path.join(run, 'transportx');
const scope = 'studio-offline-ridership';
const scene = path.join(trafficDir, 'scenarios', scope);
const moduleId = 'com.transportx.experience-exchange';
const adminToken = randomBytes(32).toString('hex');
const mcpToken = randomBytes(32).toString('hex');
const tokenFile = path.join(run, 'mcp-token');
const report = { mode: 'isolated engineering smoke with a scripted tool dispatcher', checks: {} };
const children = [];
const toolRequests = [];
let runtime, txBase, trafficBase;
const toolJson = message => JSON.parse(typeof message.content === 'string' ? message.content : message.content.find(block => block.type === 'text').text);

const dispatcher = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const content = body.messages.findLast(item => item.role === 'user').content;
    const user = typeof content === 'string' ? content : content.map(item => item.text).join('');
    assert.ok(user.startsWith('experience-smoke:'));
    const requested = JSON.parse(user.slice('experience-smoke:'.length));
    const active = (body.tools ?? []).map(tool => tool.function.name);
    const last = body.messages.at(-1);
    const previous = body.messages.findLast(item => item.tool_calls)?.tool_calls[0]?.function.name;
    let call;
    if (requested.name === 'combined-analysis') {
      if (last.role === 'user') {
        assert.ok(active.includes('search_experience') && active.includes('analyze_workspace_table') && active.includes('complete_evidence_analysis'));
        assert.ok(active.includes('record_experience_use') && !active.includes('submit_experience_feedback'));
        call = { name: 'search_experience', args: { query: requested.args.query } };
      } else if (previous === 'search_experience') {
        assert.ok(active.includes('record_experience_use'));
        call = { name: 'record_experience_use', args: { releaseId: requested.args.release, disposition: requested.args.disposition ?? 'used', reason: '先核实当前可复查样本。' } };
      } else if (previous === 'record_experience_use') {
        assert.equal(toolJson(last).accepted, true);
        call = { name: 'analyze_workspace_table', args: { file: requested.args.path ?? 'evidence/counts.csv', aggregates: [{ op: 'sum', column: 'value', as: 'total' }], deliver: true } };
      } else if (previous === 'analyze_workspace_table') {
        const result = toolJson(last);
        assert.equal(Number(result.rows[0][0]), 30);
        assert.equal(result.delivered, true);
        if (requested.args.failSync) fs.writeFileSync(tokenFile, 'temporarily-invalid\n');
      }
    } else if (last.role === 'user' || (last.role === 'tool' && previous === 'manage_capabilities')) {
      call = active.includes(requested.name) ? requested : { name: 'manage_capabilities', args: { action: 'enable', moduleId } };
    }
    toolRequests.push(call?.name ?? null);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
      id: 'exchange-smoke', object: 'chat.completion.chunk', created: 1, model: 'probe',
      choices: [{ index: 0, delta, finish_reason }],
    }) + '\n\n');
    if (call) send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + toolRequests.length,
      type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] });
    else send({ role: 'assistant', content: '接口调用结束。' });
    send({}, call ? 'tool_calls' : 'stop');
    res.end('data: [DONE]\n\n');
  } catch {
    res.writeHead(500);
    res.end('Unexpected smoke dispatcher input.');
  }
});

async function until(label, operation, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    assert.equal(child?.exitCode ?? null, null, label + ' child exited');
    const result = await operation();
    if (result) return result;
    await delay(150);
  }
  throw new Error('Timed out waiting for ' + label);
}

function start(command, commandArgs, options) {
  const child = spawn(command, commandArgs, { windowsHide: true, ...options });
  children.push(child);
  child.on('error', error => { child.startError = error; });
  return child;
}

async function stop(child, ipc = false) {
  if (!child || child.exitCode !== null || child.signalCode || child.startError) return;
  if (ipc && child.connected) child.send({ type: 'transportx-agent-host-stop' });
  else child.kill();
  for (let attempt = 0; attempt < 50 && child.exitCode === null && !child.signalCode; attempt += 1) await delay(100);
  if (child.exitCode === null && !child.signalCode) child.kill();
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

const safeEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(SYSTEMROOT|WINDIR|PATH|PATHEXT|TEMP|TMP|COMSPEC|USERPROFILE|LOCALAPPDATA|APPDATA|LANG|LC_ALL)$/iu.test(key)));

async function startTraffic() {
  const port = await freePort();
  trafficBase = `http://127.0.0.1:${port}`;
  const log = fs.openSync(path.join(run, 'traffic.log'), 'a');
  let child;
  try {
    child = start(trafficExe, [], {
      cwd: trafficDir, stdio: ['ignore', log, log], env: {
        ...safeEnv(),
        TRAFFIC_SCENARIO: scene,
        TRAFFIC_AGENT_HOST: '127.0.0.1',
        TRAFFIC_AGENT_PORT: String(port),
        TRAFFIC_SESSIONS_DB_PATH: path.join(trafficDir, 'audit', 'sessions.sqlite'),
        TRAFFIC_AUDIT_PATH: path.join(trafficDir, 'audit', 'events.ndjson'),
        TRAFFIC_LLM_BASE_URL: 'http://127.0.0.1:1',
        DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
        TA_ADMIN_TOKEN: adminToken,
        TA_EXPERIENCE_MCP_ENABLED: '1',
        TA_EXPERIENCE_MCP_DATA_SNAPSHOTS_ENABLED: '1',
        TA_EXPERIENCE_MCP_SCENE: scope,
        TA_EXPERIENCE_MCP_SCOPE: scope,
        TA_EXPERIENCE_MCP_CALLER: 'transportx-smoke',
        TA_EXPERIENCE_MCP_TOKEN: mcpToken,
      },
    });
  } finally {
    fs.closeSync(log);
  }
  await until('Traffic health', async () => {
    try { return (await fetch(trafficBase + '/health', { signal: AbortSignal.timeout(1000) })).ok; }
    catch { return false; }
  }, child);
  return child;
}

async function request(base, route, { body, method = body === undefined ? 'GET' : 'POST', headers = {}, expected = 200 } = {}) {
  const response = await fetch(base + route, {
    method, headers: { 'content-type': 'application/json', ...headers }, signal: AbortSignal.timeout(10_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.ok(Array.isArray(expected) ? expected.includes(response.status) : response.status === expected,
    `${method} ${route} returned ${response.status}: ${text.slice(0, 350)}`);
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { return text; }
}

const admin = (route, options) => request(trafficBase, '/api/admin' + route, {
  ...options, headers: { Authorization: 'Bearer ' + adminToken },
});
const tx = (route, body) => request(txBase, route, { body, headers: workspace.protocolHeaders });
const exchange = '/experience-exchange/' + scope;
const knowledge = '/knowledge-collections';
const toolResults = snapshot => snapshot.entries.map(entry => entry.message).filter(item => item?.role === 'toolResult');

async function exactRule(ref) {
  const client = new Client({ name: 'experience-smoke-exact', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(trafficBase + '/mcp/experience'), {
      requestInit: { headers: { Authorization: 'Bearer ' + mcpToken } },
    }));
    const response = await client.callTool({
      name: 'search_experience',
      arguments: { query: 'exact reference', reference: { release_id: ref.release_id, entry_id: ref.entry_id } },
    });
    assert.ok(!response.isError);
    return response.structuredContent.experiences;
  } finally { await client.close(); }
}

async function call(child, name, args, isError = false) {
  const before = toolResults(await workspace.nativeSnapshot(tx, runtime.conversationId)).length;
  const ack = await tx('/api/rpc', { type: 'prompt', sessionId: runtime.id, clientCommandId: randomUUID(),
    message: 'experience-smoke:' + JSON.stringify({ name, args }) });
  assert.equal(ack.success, true, 'Agent Host did not acknowledge ' + name);
  const result = await until(name, async () => {
    const snapshot = await workspace.nativeSnapshot(tx, runtime.conversationId);
    return !snapshot.isStreaming && toolResults(snapshot).slice(before).findLast(item => item.toolName === name);
  }, child);
  assert.equal(Boolean(result.isError), isError, JSON.stringify(result));
  return result.details;
}

const entryId = 'review-before-change';
const ruleTitle = '判断变化是否会改变行动';
const ruleSource = { id: 'engineering-example', title: '合成联调规则', reference: 'local:experience-engineering-smoke' };

async function confirmRule(collectionId, body) {
  const current = await admin(knowledge + '/' + collectionId);
  const draft = await admin(knowledge + '/' + collectionId + '/draft', { method: 'PUT', body: {
    expected_revision: current.revision,
    name: ruleTitle, description: 'Synthetic engineering smoke',
    sources: [ruleSource],
    entries: [{ id: entryId, kind: 'rule', title: ruleTitle, body, scope, source_ids: [ruleSource.id] }],
    relations: [],
  } });
  const confirmed = await admin(knowledge + '/' + collectionId + '/confirm', { body: {
    expected_revision: draft.revision, digest: draft.draft.digest,
  } });
  return confirmed.binding;
}

function reference(experience) {
  const { release_id, entry_id, collection_id, revision, digest } = experience;
  return { release_id, entry_id, collection_id, revision, digest };
}

try {
  fs.mkdirSync(path.join(trafficDir, 'audit'), { recursive: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.cpSync(path.join(trafficRepo, 'tests', 'fixtures', 'studio-delivery', 'offline-ridership'), scene, { recursive: true });
  fs.writeFileSync(path.join(trafficDir, '.env'), '# Isolated engineering exercise.\n');
  fs.writeFileSync(tokenFile, mcpToken + '\n', { flag: 'wx', mode: 0o600 });
  execFileSync(process.env.TAU_PYTHON_COMMAND ?? 'python3', ['-c',
    'import pathlib,sqlite3,sys; p=pathlib.Path(sys.argv[1]); sqlite3.connect(p / "ridership.sqlite").executescript((p / "data.sql").read_text(encoding="utf-8"))',
    scene], { windowsHide: true });
  const traffic = await startTraffic();
  const form = new FormData();
  form.set('target', 'replace'); form.set('scene_id', scope); form.set('keep_semantic', 'true');
  form.set('files', new Blob(['value\n10\n20\n'], { type: 'text/csv' }), 'counts.csv');
  const importedResponse = await fetch(trafficBase + '/api/admin/datasource/ingest/execute', {
    method: 'POST', headers: { Authorization: 'Bearer ' + adminToken }, body: form, signal: AbortSignal.timeout(30_000),
  });
  const imported = await importedResponse.json();
  assert.equal(importedResponse.status, 200, JSON.stringify(imported));
  assert.deepEqual(imported.snapshot_warnings, []);
  assert.equal(imported.data_snapshots.length, 1);
  const snapshotId = imported.data_snapshots[0].snapshot_id;
  for (const token of [undefined, adminToken]) {
    await request(trafficBase, '/mcp/experience', { method: 'POST', headers: {
      Accept: 'application/json, text/event-stream', ...(token ? { Authorization: 'Bearer ' + token } : {}),
    }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, expected: [401, 403] });
  }
  await request(trafficBase, '/api/admin' + exchange, { headers: { Authorization: 'Bearer ' + mcpToken }, expected: [401, 403] });
  report.checks.authorization = true;

  await new Promise(resolve => dispatcher.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(profile, 'models.json'), JSON.stringify({ providers: { probe: {
    baseUrl: `http://127.0.0.1:${dispatcher.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture',
    models: [{ id: 'probe', input: ['text'], reasoning: false, maxTokens: 2048, contextWindow: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  const hostLog = fs.openSync(path.join(run, 'transportx.log'), 'a');
  let host;
  try {
    host = start(process.execPath, ['bin/tau.js', '--desktop', '--parent-pid', String(process.pid)], {
      cwd: repo, stdio: ['ignore', 'pipe', hostLog, 'ipc'],
      env: {
        ...safeEnv(), PI_OFFLINE: '1', PYTHONUTF8: '1', TAU_USER_DATA_DIR: profile, PI_CODING_AGENT_DIR: profile,
        TAU_RUNTIME_COORDINATION_DIR: path.join(profile, 'runtime-guards'),
        TAU_PROJECTS_DIR: path.join(profile, 'projects'), PI_CODING_AGENT_SESSION_DIR: path.join(profile, 'sessions'),
        TAU_PYTHON_COMMAND: process.env.TAU_PYTHON_COMMAND ?? 'python3',
        TAU_PI_ENTRYPOINT: path.join(repo, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
        TRANSPORTX_EXPERIENCE_MCP_URL: trafficBase + '/mcp/experience',
        TRANSPORTX_EXPERIENCE_TOKEN_FILE: tokenFile,
        TRANSPORTX_EXPERIENCE_SCOPE: scope,
      },
    });
    let startup = '';
    host.stdout.on('data', value => { startup += value.toString(); });
    const ready = await until('TransportX Agent Host', () => startup.split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).find(entry => entry?.type === 'transportx-agent-host-ready'), host);
    txBase = `http://127.0.0.1:${ready.port}`;
  } finally {
    fs.closeSync(hostLog);
  }
  await until('TransportX inventory', async () => (await tx('/api/health')).dataState === 'ready', host);
  const options = await tx('/api/platform/session-options');
  const mod = options.modules.find(item => item.id === moduleId);
  assert.ok(mod, 'Experience module missing from the real Agent Host.');
  const selected = options.modules.filter(item => item.selectedByDefault || item.id === moduleId)
    .map(({ id, version }) => ({ id, version }));
  runtime = await workspace.createHostConversation(tx, { name: 'Experience exchange smoke', model: 'probe/probe',
    profile: { ...workspace.smokeProfile, modules: { selectionMode: 'explicit', selected } } });
  assert.ok(runtime.conversationId);

  const collection = await admin(knowledge, { body: { name: ruleTitle, description: 'Synthetic engineering smoke' } });
  const collectionId = collection.id;
  const v1 = await confirmRule(collectionId, '先记录变化幅度和原任务目标。');
  const query = { query: '这次的变化，需要判断会不会改变行动吗？' };
  const unpublished = await call(host, 'search_experience', query);
  assert.deepEqual(unpublished.experiences, [], 'Confirmed knowledge requires separate experience publication.');
  await admin(exchange + '/releases', { body: {
    expected_revision: (await admin(exchange)).revision, binding: v1, entry_id: entryId,
  } });
  const found = await call(host, 'search_experience', query);
  assert.equal(found.scope, scope);
  assert.equal(found.experiences.length, 1);
  const oldRef = reference(found.experiences[0]);
  assert.equal(oldRef.revision, v1.revision);
  assert.equal(oldRef.digest, v1.digest);
  assert.ok(found.experiences[0].matched_terms.length >= 2);
  assert.ok(!toolRequests.includes('manage_capabilities'), 'Search should be open from the first request');
  assert.deepEqual((await exactRule(oldRef)).map(reference), [oldRef]);
  assert.deepEqual((await call(host, 'search_experience', { query: '芦苇显微结构 orchid taxonomy' })).experiences, []);
  const active = await admin(exchange);
  await admin(exchange + '/releases', { expected: 409, body: {
    expected_revision: active.revision, binding: v1, entry_id: oldRef.entry_id,
  } });
  report.checks.read = oldRef;

  const feedback = { submission_id: 'smoke-' + randomUUID(), run_id: runtime.conversationId,
    question: '这一变化会影响行动吗？', initial_interpretation: '描述幅度',
    correction: '先查清行动改变的条件', evidence_ref: ruleSource.reference,
    experience: oldRef, data_refs: ['dataset:offline-ridership@1'] };
  const received = await call(host, 'submit_experience_feedback', feedback);
  assert.ok(toolRequests.includes('manage_capabilities'), 'Feedback still requires activation');
  const replay = await call(host, 'submit_experience_feedback', feedback);
  assert.equal(received.feedback_id, replay.feedback_id);
  await call(host, 'submit_experience_feedback', { ...feedback, correction: 'Conflicting retry body' }, true);
  const queue = await admin(exchange);
  assert.equal(queue.feedback.length, 1);
  assert.ok(queue.feedback.some(item => item.id === received.feedback_id || item.feedback_id === received.feedback_id));
  await admin(exchange + '/feedback/' + received.feedback_id + '/review', { expected: 409, body: {
    expected_revision: queue.revision - 1, decision: 'accept', reason: 'This stale revision must be rejected',
  } });
  await admin(exchange + '/feedback/' + received.feedback_id + '/review', { body: {
    expected_revision: queue.revision, decision: 'accept', reason: '人工核对合成联调反馈。',
  } });
  report.checks.feedback = { id: received.feedback_id, sameRetry: true, rejectedDifferentPayload: true };

  const v2 = await confirmRule(collectionId, '如果任务涉及一项决定，记录改变选择的条件。');
  assert.equal((await call(host, 'search_experience', query)).experiences[0].revision, v1.revision);
  await admin(exchange + '/releases', { body: {
    expected_revision: (await admin(exchange)).revision, binding: v2, entry_id: entryId,
    feedback_ids: [received.feedback_id], evidence_ref: 'local:engineering-smoke-receipt',
  } });
  const updated = await call(host, 'search_experience', query);
  assert.equal(updated.experiences.length, 1);
  const newRef = reference(updated.experiences[0]);
  assert.equal(newRef.revision, v2.revision);
  assert.equal(newRef.digest, v2.digest);
  assert.notEqual(newRef.release_id, oldRef.release_id);
  const staleUsage = await call(host, 'record_experience_use', { releaseId: newRef.release_id, disposition: 'used', reason: 'The search ran in a previous turn.' }, true);
  assert.equal(staleUsage.accepted, false);
  report.checks.reviewedUpdate = newRef;

  const evidenceModule = options.modules.find(item => item.id === 'com.transportx.evidence-analysis');
  assert.ok(evidenceModule);
  const combined = await workspace.createHostConversation(tx, { name: 'Experience and evidence smoke', model: 'probe/probe',
    profile: { ...workspace.smokeProfile, modules: { selectionMode: 'explicit',
      selected: [...selected, { id: evidenceModule.id, version: evidenceModule.version }] } } });
  const snapshotList = await tx(`/api/conversations/${combined.conversationId}/traffic-snapshots`);
  assert.ok(snapshotList.snapshots.some(item => item.snapshot_id === snapshotId));
  const snapshot = await tx(`/api/conversations/${combined.conversationId}/traffic-snapshots`, { snapshotId });
  const second = await tx(`/api/conversations/${combined.conversationId}/traffic-snapshots`, { snapshotId });
  assert.notEqual(snapshot.path, second.path, 'A second selection must never overwrite the first');
  assert.equal(snapshot.snapshot.snapshot_id, snapshotId);
  fs.writeFileSync(path.join(combined.cwd, second.path), 'value\n999\n');
  execFileSync(process.execPath, ['-e', `const a = require('./bin/workspace-table.js'); a.analyzeWorkspaceTable(process.argv[1], {file:process.argv[2]}).then(() => process.exit(2), e => {if (!/changed/.test(e.message)) { console.error(e); process.exit(3); }});`, combined.cwd, second.path], { cwd: repo, env: { ...process.env, PI_CODING_AGENT_DIR: profile }, timeout: 30_000 });
  report.checks.snapshotTamperingRejected = true;
  const ack = await tx('/api/rpc', { type: 'prompt', sessionId: combined.id, clientCommandId: randomUUID(),
    message: 'experience-smoke:' + JSON.stringify({ name: 'combined-analysis', args: { query: query.query, release: newRef.release_id, path: snapshot.path } }) });
  assert.equal(ack.success, true);
  const combinedSnapshot = await until('combined evidence and experience receipt', async () => {
    const snapshot = await workspace.nativeSnapshot(tx, combined.conversationId);
    return !snapshot.isStreaming && snapshot.entries.some(entry => entry.customType === 'transportx.evidence-analysis.v1') && snapshot;
  }, host);
  const combinedReceipt = combinedSnapshot.entries.findLast(entry => entry.customType === 'transportx.evidence-analysis.v1').data;
  const experience = combinedSnapshot.entries.filter(entry => entry.customType === 'experience-exchange').map(entry => entry.data);
  const usage = experience.find(entry => entry.kind === 'disposition');
  assert.equal(combinedReceipt.status, 'verified');
  assert.equal(usage.releaseId, newRef.release_id);
  assert.equal(usage.digest, newRef.digest);
  assert.equal(usage.disposition, 'used');
  assert.ok(experience.some(entry => entry.kind === 'search' && entry.toolCallId === usage.lookupToolCallId));
  assert.deepEqual(combinedReceipt.relatedToolCallIds, [usage.receiptId]);
  assert.equal(combinedReceipt.experience, undefined);
  assert.equal(combinedSnapshot.entries.findLast(entry => entry.message?.role === 'assistant')?.message?.delivery?.status, 'submitted');
  assert.ok(combinedReceipt.evidence[0].tableRunId);
  assert.equal(combinedReceipt.evidence[0].sources[0].upstream.snapshot.snapshot_id, snapshotId);
  assert.equal(combinedReceipt.evidence[0].sources[0].upstream.snapshot.definition_sha256, snapshot.snapshot.definition_sha256);
  const runLedgerDirectory = path.join(profile, 'experience-run-receipts');
  const runLedger = fs.readdirSync(runLedgerDirectory).flatMap(name => fs.readFileSync(path.join(runLedgerDirectory, name), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
  const pendingUse = runLedger.find(item => item.kind === 'pending' && item.payload.experience.release_id === newRef.release_id);
  assert.deepEqual(pendingUse.payload.snapshot_ids, [snapshotId]);
  assert.ok(runLedger.some(item => item.kind === 'synced' && item.submissionId === pendingUse.payload.submission_id));
  const retry = await tx(`/api/conversations/${combined.conversationId}/traffic-use-receipts/retry`, {});
  assert.deepEqual(retry, { synced: 0, pending: 0 });
  report.checks.snapshotAndRemoteUseReceipt = true;
  report.checks.combinedAnalysisReceipt = combinedReceipt;
  report.checks.experienceUsageReceipt = usage;
  report.checks.priorTurnUsageRejected = true;
  const previousReceipts = combinedSnapshot.entries.filter(entry => entry.customType === 'transportx.evidence-analysis.v1').length;
  const offlineAck = await tx('/api/rpc', { type: 'prompt', sessionId: combined.id, clientCommandId: randomUUID(),
    message: 'experience-smoke:' + JSON.stringify({ name: 'combined-analysis', args: { query: query.query, release: newRef.release_id, path: snapshot.path, disposition: 'skipped', failSync: true } }) });
  assert.equal(offlineAck.success, true);
  const offlineSnapshot = await until('unsynchronized receipt', async () => {
    const state = await workspace.nativeSnapshot(tx, combined.conversationId);
    return !state.isStreaming && state.entries.filter(entry => entry.customType === 'transportx.evidence-analysis.v1').length > previousReceipts && state;
  }, host);
  assert.equal(offlineSnapshot.entries.findLast(entry => entry.customType === 'transportx.evidence-analysis.v1').data.status, 'verified');
  assert.equal(offlineSnapshot.entries.findLast(entry => entry.message?.role === 'assistant')?.message?.delivery?.status, 'submitted');
  assert.ok(offlineSnapshot.entries.some(entry => entry.type === 'custom_message' && entry.customType === 'transportx.receipt-sync' && entry.display === true));
  const pendingAfterFailure = fs.readdirSync(runLedgerDirectory).flatMap(name => fs.readFileSync(path.join(runLedgerDirectory, name), 'utf8').split('\n').filter(Boolean).map(JSON.parse)).find(item => item.kind === 'pending' && item.payload.disposition === 'skipped');
  assert.deepEqual(pendingAfterFailure.payload.snapshot_ids, [snapshotId]);
  fs.writeFileSync(tokenFile, mcpToken + '\n');
  const retried = await tx(`/api/conversations/${combined.conversationId}/traffic-use-receipts/retry`, {});
  assert.deepEqual(retried, { synced: 1, pending: 0 });
  assert.deepEqual(await tx(`/api/conversations/${combined.conversationId}/traffic-use-receipts/retry`, {}), { synced: 0, pending: 0 });
  report.checks.failedRemoteReceiptRetriedWithoutLosingAnswer = true;
  await workspace.closeHostConversation(tx, combined.conversationId);

  for (const ref of [oldRef, newRef]) {
    const overview = await admin(exchange);
    await admin(exchange + '/releases/' + ref.release_id + '/withdraw', { body: {
      expected_revision: overview.revision, reason: '结束合成联调。',
    } });
  }
  assert.deepEqual((await call(host, 'search_experience', query)).experiences, []);
  assert.deepEqual(await exactRule(newRef), []);
  const historical = await call(host, 'submit_experience_feedback', {
    ...feedback, submission_id: 'late-report', correction: 'A prior run referred to this withdrawn version.',
  });
  assert.notEqual(historical.feedback_id, received.feedback_id);
  const receiptPath = path.join(runtime.cwd, '.transportx', 'experience-exchange', 'receipts.jsonl');
  const receipts = fs.readFileSync(receiptPath, 'utf8');
  assert.ok(receipts.includes(oldRef.digest) && receipts.includes(newRef.digest));
  assert.ok(receipts.includes(received.feedback_id));
  assert.ok(!receipts.includes(mcpToken) && !receipts.includes(adminToken));
  fs.copyFileSync(receiptPath, path.join(run, 'transportx-receipts.jsonl'));
  await workspace.closeHostConversation(tx, runtime.conversationId);
  await stop(host, true);
  await stop(traffic);
  await startTraffic();
  const persisted = await admin(exchange);
  assert.equal(persisted.feedback.length, 2);
  assert.ok(persisted.feedback.some(item => item.feedback_id === historical.feedback_id &&
    item.status === 'pending' && item.submission.experience.release_id === oldRef.release_id));
  assert.equal(persisted.releases.length, 2);
  report.checks.withdrawal = true;
  report.checks.restartedTraffic = true;
  report.checks.duplicatePublicationRejected = true;
  report.checks.staleReviewRejected = true;
  report.checks.historicalFeedback = true;
  report.checks.searchReadyAndRanked = true;
  report.status = 'pass';
} catch (error) {
  report.status = 'fail';
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) await stop(child, child.connected).catch(() => {});
  dispatcher.closeAllConnections();
  await new Promise(resolve => dispatcher.close(resolve));
  if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile);
  // Keep the checked artifacts and scoped audit only. Tokens are ephemeral.
  report.dispatchedTools = toolRequests;
  fs.writeFileSync(path.join(run, 'evidence.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(path.join(run, 'evidence.json'));
}
