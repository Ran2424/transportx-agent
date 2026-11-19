import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as workspace from './harness/workspace-client.mjs';
import { answer, table, createEvidenceModel } from './harness/evidence-analysis-model.mjs';

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
let host, txBase, runtime;
const {dispatcher, state: model, requests} = createEvidenceModel(() => runtime.cwd);

async function until(label, operation, timeout = 90_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (model.dispatcherError) throw model.dispatcherError;
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
function conversationEntries(conversationId) {
  const file = path.join(profile, 'sessions', 'transportx', `${conversationId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}
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
  const conversationId = runtime.conversationId;
  const before = conversationEntries(conversationId).length;
  model.active = { name, requests: 0 };
  const ack = await tx('/api/rpc', {
    type: 'prompt',
    sessionId: runtime.id,
    clientCommandId: randomUUID(),
    message: `evidence smoke ${name}: calculate the north AM count from evidence/counts.csv.`,
  });
  assert.equal(ack.success, true);
  const settled = await until(name + ' receipt', () => {
    const entries = conversationEntries(conversationId).slice(before);
    const receipt = entries.find((item) => item.type === 'custom' && item.customType === entryType);
    return receipt && { receipt, messages: messages(entries) };
  });
  const turn = {
    receipt: settled.receipt.data,
    messages: settled.messages,
    requests: model.active.requests,
  };
  model.active = undefined;
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
        TAU_RUNTIME_COORDINATION_DIR: path.join(profile, 'runtime-guards'),
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
  assert.equal(verified.messages.findLast(item => item.role === 'assistant')?.delivery?.status, 'submitted');
  assert.equal(verified.receipt.repair, true);
  assert.deepEqual(verified.receipt.selected, [model.capturedId]);
  const proof = verified.receipt.evidence.find((item) => item.id === model.capturedId);
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
  assert.equal(tableResult.details.evidenceId, model.capturedId);
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
  assert.match(text, /Total count\*\* — 30/);
  assert.ok(!text.includes('PLAN_ONLY_SENTINEL'));
  report.checks.verifiedRepair = {
    requests: verified.requests,
    sourceSha256: sha,
    tableRunId: proof.tableRunId,
    evidenceId: model.capturedId,
  };

  const direct = await exercise('direct-delivery');
  assert.equal(direct.requests, 4);
  assert.equal(direct.receipt.status, 'verified');
  assert.equal(direct.receipt.repair, false);
  assert.equal(direct.receipt.providerStopAfterApproval, 'length');
  const directDelivery = direct.messages.findLast((item) => item.role === 'assistant');
  assert.equal(directDelivery?.delivery?.status, 'submitted');
  assert.match(contentText(directDelivery), /mean: 15/);
  assert.equal(direct.receipt.evidence[0].calculation, undefined);
  assert.equal(direct.receipt.evidence[0].unmatchedFilters[0].value, 'am');
  assert.ok(direct.messages.some(item => item.toolName === 'complete_evidence_analysis' && item.isError));
  assert.equal(direct.receipt.evidence[1].calculation.matchedRows, 2);
  assert.deepEqual(direct.receipt.selected, [direct.receipt.evidence[1].id]);
  report.checks.unmatchedFilterBlocksSubmissionUntilRechecked = true;
  report.checks.directAggregateSurvivesMissingNarration = true;

  const readOnly = await exercise('csv-read-is-not-a-calculation');
  assert.equal(readOnly.receipt.status, 'incomplete');
  assert.ok(readOnly.messages.some((item) => item.toolName === 'complete_evidence_analysis' && item.isError));
  report.checks.csvReadDoesNotSubmitAnUncalculatedValue = true;

  const plans = await exercise('plans');
  assert.equal(plans.requests, 2);
  assert.equal(plans.receipt.status, 'incomplete');
  assert.equal(plans.messages.findLast(item => item.role === 'assistant')?.delivery?.status, 'incomplete');
  assert.equal((await workspace.nativeSnapshot(tx, runtime.conversationId)).outcome, null);
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
  assert.equal(missing.messages.findLast(item => item.role === 'assistant')?.delivery?.status, 'needs_review');
  assert.ok(
    missing.messages
      .filter((item) => item.role === 'assistant')
      .map(contentText)
      .join('\n')
      .includes('evidence/missing.csv is absent')
  );
  report.checks.missingSourceReportsGap = true;

  const invalid = await exercise('invalid-is-not-missing');
  assert.equal(invalid.receipt.status, 'incomplete');
  assert.equal(invalid.receipt.evidence.length, 0);
  assert.ok(invalid.messages.some((item) => item.role === 'toolResult' &&
    item.toolName === 'complete_evidence_analysis' && item.isError && item.details?.accepted === false));
  report.checks.invalidQueryDoesNotProveMissingSource = true;

  const forged = await exercise('forged-related');
  assert.equal(forged.receipt.status, 'incomplete');
  assert.ok(forged.receipt.evidence.length > 0);
  assert.equal(forged.receipt.relatedToolCallIds, undefined);
  assert.ok(forged.messages.some(item => item.toolName === 'complete_evidence_analysis' && item.isError));
  report.checks.forgedRelatedReceiptRejected = true;

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
  runtime = await workspace.createHostConversation(tx, {
    name: 'Required explanation smoke', model: 'probe/probe',
    profile: { ...workspace.smokeProfile, task: { ...workspace.smokeProfile.task, answerRequirements: ['Explain scope and definition'] }, modules: { selectionMode: 'explicit', selected } },
  });
  fs.mkdirSync(path.join(runtime.cwd, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(runtime.cwd, 'evidence', 'counts.csv'), csv);
  const explanation = await exercise('required-explanation');
  assert.equal(explanation.receipt.status, 'verified');
  const bound = explanation.receipt.claims;
  assert.deepEqual(bound.map(claim => claim.kind), ['scope', 'sample', 'value', 'time']);
  assert.equal(bound[0].evidenceId, bound[1].evidenceId);
  assert.deepEqual(bound[0].plan.filters, table.filters);
  assert.equal(bound[1].matchedRows, 2);
  assert.equal(Number(bound[2].value), 30);
  assert.deepEqual(bound[3].groups, [{ value: 'AM', count: 2 }]);
  assert.equal(explanation.messages.filter(item => item.toolName === 'complete_evidence_analysis' && item.isError).length, 3);
  assert.match(contentText(explanation.messages.findLast(item => item.role === 'assistant')), /Window\*\* — period .*AM \(2 rows\)/);
  report.checks.requiredExplanationDisablesDirectDelivery = true;
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
