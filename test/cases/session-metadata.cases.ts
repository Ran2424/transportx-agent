const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');

const { liveSessionMetadata, sessionMetadata, sessionSnapshot } = require('../../bin/session-metadata.js');

const source = {
  id: 'tau_1',
  pid: 123,
  cwd: '/tmp/session',
  modelSpec: 'openai/gpt-5',
  model: { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
  thinkingLevel: 'high',
  sessionFile: '/tmp/session/history.jsonl',
  sessionName: '早高峰分析',
  isStreaming: true,
  isCompacting: false,
  autoCompactionEnabled: true,
  createdAt: '2026-08-21T00:00:00.000Z',
  lastActiveAt: '2026-08-21T00:01:00.000Z',
  lastConversationAt: '2026-08-21T00:00:30.000Z',
  contextUsage: { tokens: 23000, contextWindow: 100000, percent: 23 },
  resolvedSessionPlan: { schemaVersion: 3 },
};

caseTest('keeps immutable session details out of the live metadata overlay', () => {
  const capabilities = { ok: true };
  const full = sessionMetadata(source, capabilities, [{ id: 'request-1' }]);
  const live = liveSessionMetadata(source, capabilities);

  assert.equal(full.modelLabel, 'openai/gpt-5');
  assert.equal(full.resolvedSessionPlan, source.resolvedSessionPlan);
  assert.deepEqual(full.pendingExtensionUiRequests, [{ id: 'request-1' }]);
  assert.equal(live.resolvedSessionPlan, undefined);
  assert.equal(live.cwd, undefined);
  assert.equal(live.isStreaming, true);
  assert.equal(live.contextUsage.tokens, 23000);
});

caseTest('combines the projection snapshot with the authoritative session metadata', () => {
  const snapshot = sessionSnapshot({ messages: [{ role: 'user', content: '分析' }] }, source, { ok: true }, []);
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.session.id, source.id);
  assert.equal(snapshot.session.resolvedSessionPlan, source.resolvedSessionPlan);
  assert.equal(snapshot.contextUsage.percent, 23);
});

caseTest('live snapshots include Host clock, current partial message and active tools', () => {
  const { LiveSessionManager, PiRpcSession } = require('../../bin/sessions.js');
  const manager = new LiveSessionManager();
  const session = new PiRpcSession(manager, { id: 'clocked', cwd: '/tmp/clocked' });
  session.handleEvent({ type: 'agent_start' });
  session.handleEvent({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'current partial' }] } });
  session.handleEvent({ type: 'tool_execution_start', toolCallId: 'call', toolName: 'read', args: { path: 'file' } });
  const snapshot = session.snapshot();
  assert.equal(typeof snapshot.hostGeneration, 'string');
  assert.ok(snapshot.revision >= 3);
  assert.equal(snapshot.streamingMessage.content[0].text, 'current partial');
  assert.equal(snapshot.activeToolEvents[0].toolCallId, 'call');
  session.handleEvent({ type: 'tool_execution_end', toolCallId: 'call', result: {} });
  session.handleEvent({ type: 'message_end', message: { role: 'assistant', content: 'finished' } });
  assert.equal(session.snapshot().streamingMessage, null);
  assert.equal(session.snapshot().activeToolEvents.length, 0);
  assert.notEqual(new LiveSessionManager().clock().hostGeneration, manager.clock().hostGeneration);
});

caseTest('core managers import without reading configuration and accept independent runtime dependencies', (t: any) => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-manager-isolation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'settings.json'), 'corrupt');
  const output = execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { LiveSessionManager, PiRpcSession } = require('./bin/sessions.js');
    assert.equal(require.cache[require.resolve('./bin/config.js')], undefined);
    assert.equal(require.cache[require.resolve('./bin/platform-composition.js')], undefined);
    const calls = [];
    const assembler = { assemble: (domain, cwd) => { calls.push(domain); return { modules: [], assets: [], workingDirectory: cwd }; }, save: () => {}, load: () => {} };
    PiRpcSession.prototype.start = async function () { calls.push(this.manager.runtime.command); };
    const dependencies = (domain) => ({ defaultDomainId: domain, assembler, assemblerForProfile: () => assembler, createWorkspace: () => process.env.PI_CODING_AGENT_DIR, command: domain + '-pi', spawn: () => {}, endpoints: {}, launch: () => ({ args: [], env: {} }) });
    (async () => {
      const a = new LiveSessionManager(dependencies('a'));
      const b = new LiveSessionManager(dependencies('b'));
      const sa = await a.create({ model: 'provider/model' });
      const sb = await b.create({ model: 'provider/model' });
      assert.deepEqual(calls, ['a','a-pi','b','b-pi']);
      assert.equal(a.get(sb.id), undefined);
      assert.equal(b.get(sa.id), undefined);
      process.stdout.write('isolated');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: 'utf8', env: { ...process.env, PI_CODING_AGENT_DIR: root, TAU_APP_ROOT: path.join(root, 'missing') } });
  assert.equal(output, 'isolated');
});

caseTest('suite reporter preserves named failures, skip and todo as native subtests', (t: any) => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-subtest-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'report.test.cjs');
  const helper = path.resolve('test/support/test-suite.ts');
  fs.writeFileSync(file, `const {suiteCase, suiteAfter, registerSuite}=require(${JSON.stringify(helper)});
suiteCase(__filename,'named pass',()=>{});
suiteCase(__filename,'named skip',{skip:'environment unavailable'},()=>{throw Error('must not run')});
suiteCase(__filename,'named todo',{todo:'pending'},()=>{throw Error('pending')});
suiteCase(__filename,'named failure',()=>{throw Error('reproduction')});
suiteAfter(()=>{console.log('cleanup first');throw Error('cleanup failed')});
suiteAfter(()=>console.log('cleanup second'));
registerSuite('report fixture');`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const report = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { encoding: 'utf8', env });
  assert.equal(report.status, 1);
  assert.match(report.stdout, /not ok .*named failure/);
  assert.match(report.stdout, /named skip.*# SKIP environment unavailable/);
  assert.match(report.stdout, /named todo.*# TODO pending/);
  assert.match(report.stdout, /# skipped 1/);
  assert.match(report.stdout, /# todo 1/);
  assert.match(report.stdout, /cleanup first/);
  assert.match(report.stdout, /cleanup second/);
});
