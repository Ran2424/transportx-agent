import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as workspace from './harness/workspace-client.mjs';

// Real Host + Pi, scripted OpenAI-compatible model. This tests lifecycle, not model quality.
const { values } = parseArgs({ options: { evidence: { type: 'string' } } });
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = path.resolve(values.evidence ?? os.tmpdir());
fs.mkdirSync(evidenceRoot, { recursive: true });
const run = fs.mkdtempSync(path.join(evidenceRoot, 'evidence-analysis-'));
const profile = path.join(run, 'profile');
fs.mkdirSync(profile, { recursive: true });
const report = {
  mode: 'isolated Host/Pi engineering smoke; scripted model, not model evaluation',
  checks: {},
};
const moduleId = 'com.transportx.evidence-analysis';
const entryType = 'transportx.evidence-analysis.v1';
const csv = Buffer.from('area,period,count\nnorth,AM,12\nnorth,AM,18\nsouth,AM,99\nnorth,PM,7\n');
const sha = createHash('sha256').update(csv).digest('hex');
const table = {
  file: 'evidence/counts.csv',
  filters: [
    { column: 'area', value: 'north' },
    { column: 'period', value: 'AM' },
  ],
  aggregates: [{ op: 'sum', column: 'count', as: 'total' }],
};
const answer = 'The north AM total is 30.';
let active, capturedId, dispatcherError, host, txBase, runtime;
const requests = [];

const dispatcher = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.ok(active, 'Unexpected model request outside an active scenario');
    const index = active.requests++;
    const tools = (body.tools ?? []).map((item) => item.function.name);
    requests.push({ scenario: active.name, index, tools });
    if (index === 0) {
      assert.ok(tools.includes('analyze_workspace_table'), 'Table tool must be available in the first request');
      assert.ok(
        tools.includes('complete_evidence_analysis'),
        'Completion tool must be available in the first request'
      );
    }
    let call, content;
    if (active.name === 'verified') {
      if (index === 0) content = 'PLAN_ONLY_SENTINEL: I will inspect the data.';
      else if (index === 1)
        call = {
          name: 'analyze_workspace_table',
          args: { ...table, file: path.join(runtime.cwd, table.file) },
        };
      else if (index === 2) {
        const result = body.messages.findLast((item) => item.role === 'tool');
        const text = typeof result?.content === 'string' ? result.content : JSON.stringify(result?.content);
        const match = text.match(/ev_[0-9a-f]{16}/);
        assert.ok(match, 'The table result must return a current-turn evidence ID');
        capturedId = match[0];
        call = {
          name: 'complete_evidence_analysis',
          args: { status: 'completed', answer, evidence: [capturedId] },
        };
      } else if (index === 3) content = 'Model completion text should be replaced by the verified answer.';
      else throw new Error('Unexpected request in verified scenario: ' + index);
    } else if (active.name === 'plans') {
      assert.ok(index < 2, 'Only one repair follow-up is permitted');
      content = 'PLAN_TWICE_SENTINEL: I will investigate later.';
    } else if (active.name === 'repair-write') {
      if (index === 1)
        call = { name: 'write', args: { path: 'evidence/forbidden.txt', content: 'Must be blocked' } };
      else if (index <= 2) content = 'I will inspect the evidence later.';
      else throw new Error('Unexpected repair-write request: ' + index);
    } else if (active.name === 'missing') {
      if (index === 0)
        call = { name: 'analyze_workspace_table', args: { ...table, file: 'evidence/missing.csv' } };
      else if (index === 1)
        call = {
          name: 'complete_evidence_analysis',
          args: { status: 'missing', answer: 'The file evidence/missing.csv is absent.', evidence: [] },
        };
      else if (index === 2) content = 'Completion.';
      else throw new Error('Unexpected missing-data request: ' + index);
    } else if (active.name === 'stale') {
      if (index === 0)
        call = {
          name: 'complete_evidence_analysis',
          args: {
            status: 'answered',
            answer: 'Stale fake answer.',
            evidence: [capturedId],
          },
        };
      else if (index <= 2) content = 'STALE_PLAN_SENTINEL: I will check later.';
      else throw new Error('Unexpected stale scenario request: ' + index);
    } else if (active.name === 'unsafe') {
      if (index === 0)
        call = {
          name: 'analyze_workspace_table',
          args: { ...table, file: '../foreign.csv' },
        };
      else if (index === 1)
        call = {
          name: 'analyze_workspace_table',
          args: { ...table, file: 'https://example.invalid/foreign.csv' },
        };
      else if (index <= 3) content = 'UNSAFE_PLAN_SENTINEL: I will check later.';
      else throw new Error('Unexpected unsafe scenario request: ' + index);
    } else throw new Error('Unknown scenario');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish_reason = null) =>
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'evidence-smoke',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'probe',
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          '\n\n'
      );
    if (call)
      send({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_' + randomUUID().replaceAll('-', ''),
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ],
      });
    else send({ role: 'assistant', content });
    send({}, call ? 'tool_calls' : 'stop');
    res.end('data: [DONE]\n\n');
  } catch (error) {
    dispatcherError = error;
    res.writeHead(500);
    res.end('Invalid smoke dispatcher request.');
  }
});

async function until(label, operation, timeout = 90_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (dispatcherError) throw dispatcherError;
    if (host?.startError) throw host.startError;
    assert.equal(host?.exitCode ?? null, null, label + ': Host exited');
    const value = await operation();
    if (value) return value;
    await delay(150);
  }
  throw new Error('Timed out waiting for ' + label);
}
async function request(route, { body, expected = 200 } = {}) {
  const response = await fetch(txBase + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...workspace.protocolHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${route}: ${response.status} ${text.slice(0, 350)}`);
  return text ? JSON.parse(text) : null;
}
const tx = (route, body) => request(route, { body });
function jsonlEntries(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) return jsonlEntries(file);
    if (!item.isFile() || !item.name.endsWith('.jsonl')) return [];
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  });
}
const entries = () => jsonlEntries(profile);
const receipts = () => entries().filter((item) => item.type === 'custom' && item.customType === entryType);
const messages = (all) =>
  all
    .filter((item) => item.type === 'message')
    .map((item) => item.message)
    .filter(Boolean);
const contentText = (message) =>
  typeof message.content === 'string'
    ? message.content
    : (message.content ?? []).map((item) => item.text ?? '').join('\n');
async function exercise(name) {
  const before = receipts().length;
  const messagesBefore = messages(entries()).length;
  active = { name, requests: 0 };
  const ack = await tx('/api/rpc', {
    type: 'prompt',
    sessionId: runtime.id,
    clientCommandId: randomUUID(),
    message: `evidence smoke ${name}: calculate the north AM count from evidence/counts.csv.`,
  });
  assert.equal(ack.success, true);
  const receipt = await until(name + ' receipt', () => receipts()[before]);
  const newMessages = messages(entries()).slice(messagesBefore);
  const turn = {
    receipt: receipt.data,
    messages: newMessages,
    requests: active.requests,
  };
  active = undefined;
  return turn;
}

try {
  await new Promise((resolve, reject) => dispatcher.once('error', reject).listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(
    path.join(profile, 'models.json'),
    JSON.stringify({
      providers: {
        probe: {
          baseUrl: `http://127.0.0.1:${dispatcher.address().port}/v1`,
          api: 'openai-completions',
          apiKey: 'fixture',
          models: [
            {
              id: 'probe',
              input: ['text'],
              reasoning: false,
              maxTokens: 2048,
              contextWindow: 16384,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    })
  );
  const log = fs.openSync(path.join(run, 'host.log'), 'a');
  try {
    const safeEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(SYSTEMROOT|WINDIR|PATH|PATHEXT|TEMP|TMP|COMSPEC|USERPROFILE|LOCALAPPDATA|APPDATA|LANG|LC_ALL)$/iu.test(
          key
        )
      )
    );
    host = spawn(process.execPath, ['bin/tau.js', '--desktop', '--parent-pid', String(process.pid)], {
      cwd: repo,
      windowsHide: true,
      stdio: ['ignore', 'pipe', log, 'ipc'],
      env: {
        ...safeEnv,
        PI_OFFLINE: '1',
        PYTHONUTF8: '1',
        TAU_USER_DATA_DIR: profile,
        PI_CODING_AGENT_DIR: profile,
        TAU_PROJECTS_DIR: path.join(profile, 'projects'),
        PI_CODING_AGENT_SESSION_DIR: path.join(profile, 'sessions'),
        TAU_PYTHON_COMMAND: process.env.TAU_PYTHON_COMMAND ?? 'python3',
        TAU_PI_ENTRYPOINT: path.join(
          repo,
          'node_modules',
          '@earendil-works',
          'pi-coding-agent',
          'dist',
          'cli.js'
        ),
      },
    });
    host.on('error', (error) => {
      host.startError = error;
    });
    let startup = '';
    host.stdout.on('data', (chunk) => {
      startup += chunk.toString();
    });
    const ready = await until('Host startup', () =>
      startup
        .split('\n')
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        })
        .find((item) => item.type === 'transportx-agent-host-ready')
    );
    txBase = `http://127.0.0.1:${ready.port}`;
  } finally {
    fs.closeSync(log);
  }
  await until('Host inventory', async () => (await tx('/api/health')).dataState === 'ready');
  const options = await tx('/api/platform/session-options');
  assert.ok(
    options.modules.some((item) => item.id === moduleId),
    'Evidence module missing'
  );
  const selected = options.modules
    .filter((item) => item.selectedByDefault || item.id === moduleId)
    .map(({ id, version }) => ({ id, version }));
  runtime = await workspace.createHostConversation(tx, {
    name: 'Evidence analysis smoke',
    model: 'probe/probe',
    profile: {
      ...workspace.smokeProfile,
      modules: { selectionMode: 'explicit', selected },
    },
  });
  fs.mkdirSync(path.join(runtime.cwd, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(runtime.cwd, 'evidence', 'counts.csv'), csv);
  await request('/api/internal/analysis/table', {
    body: {
      sessionId: runtime.id,
      token: 'foreign-token',
      toolCallId: randomUUID(),
      contractVersion: '1.0.0',
      ...table,
    },
    expected: 403,
  });
  report.checks.foreignHostRequestRejected = true;

  const verified = await exercise('verified');
  assert.equal(
    verified.requests,
    4,
    'One initial response, one repair request and two tool continuations expected'
  );
  assert.equal(verified.receipt.status, 'verified');
  assert.equal(verified.receipt.repair, true);
  assert.deepEqual(verified.receipt.selected, [capturedId]);
  const proof = verified.receipt.evidence.find((item) => item.id === capturedId);
  assert.ok(proof?.tableRunId);
  assert.ok(
    proof.sources.some(
      (source) => source.path === 'evidence/counts.csv' && source.sha256 === sha && source.bytes === csv.length
    )
  );
  const tableResult = verified.messages.find(
    (item) => item.role === 'toolResult' && item.toolName === 'analyze_workspace_table'
  );
  assert.equal(Boolean(tableResult?.isError), false);
  assert.equal(Number(tableResult.details.rows[0][0]), 30);
  assert.equal(tableResult.details.matchedRows, 2);
  assert.equal(tableResult.details.evidenceId, capturedId);
  assert.equal(tableResult.details.runId, proof.tableRunId);
  const completion = verified.messages.find(
    (item) => item.role === 'toolResult' && item.toolName === 'complete_evidence_analysis'
  );
  assert.equal(completion?.details?.accepted, true);
  const text = verified.messages
    .filter((item) => item.role === 'assistant')
    .map(contentText)
    .join('\n');
  assert.ok(text.includes(answer));
  assert.ok(!text.includes('PLAN_ONLY_SENTINEL'));
  report.checks.verifiedRepair = {
    requests: verified.requests,
    sourceSha256: sha,
    tableRunId: proof.tableRunId,
    evidenceId: capturedId,
  };

  const plans = await exercise('plans');
  assert.equal(plans.requests, 2);
  assert.equal(plans.receipt.status, 'incomplete');
  assert.equal(plans.receipt.repair, true);
  assert.ok(
    !plans.messages
      .filter((item) => item.role === 'assistant')
      .map(contentText)
      .join('\n')
      .includes('PLAN_TWICE_SENTINEL')
  );
  report.checks.twoPlansIncomplete = true;

  const guarded = await exercise('repair-write');
  assert.ok(
    guarded.messages.some((item) => item.role === 'toolResult' && item.toolName === 'write' && item.isError)
  );
  assert.ok(!fs.existsSync(path.join(runtime.cwd, 'evidence', 'forbidden.txt')));
  assert.equal(guarded.receipt.status, 'incomplete');
  report.checks.repairDidNotWrite = true;

  const missing = await exercise('missing');
  assert.equal(missing.receipt.status, 'missing');
  assert.ok(
    missing.messages
      .filter((item) => item.role === 'assistant')
      .map(contentText)
      .join('\n')
      .includes('evidence/missing.csv is absent')
  );
  report.checks.missingSourceReportsGap = true;

  const stale = await exercise('stale');
  const rejected = stale.messages.find(
    (item) => item.role === 'toolResult' && item.toolName === 'complete_evidence_analysis'
  );
  assert.equal(Boolean(rejected?.isError), true);
  assert.equal(rejected?.details?.accepted, false);
  assert.equal(stale.receipt.status, 'incomplete');
  assert.deepEqual(stale.receipt.selected, []);
  assert.ok(
    !stale.messages
      .filter((item) => item.role === 'assistant')
      .map(contentText)
      .join('\n')
      .includes('Stale fake answer.')
  );
  report.checks.staleEvidenceRejected = true;

  const unsafe = await exercise('unsafe');
  const rejectedTables = unsafe.messages.filter(
    (item) => item.role === 'toolResult' && item.toolName === 'analyze_workspace_table'
  );
  assert.equal(rejectedTables.length, 2);
  assert.ok(rejectedTables.every((item) => item.isError));
  assert.equal(unsafe.receipt.status, 'incomplete');
  assert.deepEqual(unsafe.receipt.evidence, []);
  report.checks.unsafePathsRejected = true;
  await workspace.closeHostConversation(tx, runtime.conversationId);
  report.status = 'pass';
} catch (error) {
  report.status = 'fail';
  report.error = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  if (host && host.exitCode === null && !host.signalCode && !host.startError) {
    if (host.connected) host.send({ type: 'transportx-agent-host-stop' });
    for (let i = 0; i < 50 && host.exitCode === null && !host.signalCode; i++) await delay(100);
    if (host.exitCode === null && !host.signalCode) host.kill();
  }
  dispatcher.closeAllConnections();
  await new Promise((resolve) => dispatcher.close(resolve));
  report.providerRequests = requests;
  fs.writeFileSync(path.join(run, 'evidence.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(path.join(run, 'evidence.json'));
}
