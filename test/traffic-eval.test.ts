const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = process.cwd();

test('Shanghai eval fixture contains the 25 documented questions plus spatial and full-task cases', async () => {
  const { loadSuite } = await import('../scripts/eval/traffic-eval-lib.mjs');
  const suite = loadSuite(path.join(ROOT, 'evals/traffic-agent/shanghai-v1.json'));
  const questions = suite.cases.filter((item: any) => item.kind === 'question');
  assert.equal(questions.length, 25);
  assert.deepEqual(questions.map((item: any) => item.id), Array.from({ length: 25 }, (_, index) => `SH-${String(index + 1).padStart(3, '0')}`));
  assert.ok(suite.cases.filter((item: any) => item.category === 'spatial').length >= 3);
  assert.ok(suite.cases.filter((item: any) => item.id.startsWith('TASK-')).length >= 3);
  const markdown = fs.readFileSync(path.join(ROOT, 'docs/archive/shanghai-data-question-bank.md'), 'utf8');
  assert.equal((markdown.match(/^\| \d+ \|/gm) || []).length, 50);
});

test('eval parser rejects duplicate ids and numeric facts without units', async (t: any) => {
  const { loadSuite } = await import('../scripts/eval/traffic-eval-lib.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-eval-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'invalid.json');
  const item = { id: 'DUP', kind: 'question', category: 'bus', turns: [{ user: 'q', expected: { facts: [{ label: 'count', value: 1 }] } }], requiredModuleVersions: [{ id: 'module', version: '1.0.0' }], grading: { requireSuccessfulTurn: true, requireNoToolError: true } };
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, id: 'invalid', cases: [item, item] }));
  assert.throws(() => loadSuite(file), /unique/);
  assert.throws(() => loadSuite(file), /requires a unit/);
});

test('grader normalizes numeric formatting but rejects wrong units, tool errors and forbidden claims', async () => {
  const { gradeCase } = await import('../scripts/eval/traffic-eval-lib.mjs');
  const evalCase = { id: 'grade', kind: 'question', category: 'bus', turns: [{ user: 'q', expected: { facts: [{ label: 'count', value: 215066, unit: '笔' }], forbiddenTerms: ['跨类型直接相加'] } }], requiredModuleVersions: [{ id: 'data', version: '1.0.0' }], grading: { requireSuccessfulTurn: true, requireNoToolError: true } };
  const base = { completed: true, answers: ['结果为 215,066 笔。'], toolError: '', pendingExtensionUi: false, plan: { modules: [{ id: 'data', version: '1.0.0' }] }, artifacts: [] };
  assert.equal(gradeCase(evalCase, base).passed, true);
  assert.equal(gradeCase(evalCase, { ...base, answers: ['结果为 215,066 人次。'] }).passed, false);
  assert.equal(gradeCase(evalCase, { ...base, toolError: 'query failed' }).passed, false);
  assert.equal(gradeCase(evalCase, { ...base, answers: ['结果为 215,066 笔，跨类型直接相加。'] }).passed, false);
});

test('grader classifies empty answers, pending UI and missing citations as failures', async () => {
  const { gradeCase } = await import('../scripts/eval/traffic-eval-lib.mjs');
  const evalCase = { id: 'task', kind: 'task', category: 'road', turns: [{ user: 'q' }], requiredModuleVersions: [{ id: 'data', version: '1.0.0' }], grading: { requireSuccessfulTurn: true, requireNoToolError: true, requireDatasetCitation: true } };
  const result = gradeCase(evalCase, { completed: false, answers: [''], pendingExtensionUi: true, toolError: '', plan: { modules: [{ id: 'data', version: '1.0.0' }] }, hasDatasetCitation: false });
  assert.equal(result.passed, false);
  assert.ok(result.assertions.filter((item: any) => !item.passed).length >= 4);
});

test('Headless runner completes Host create, prompt, final answer, plan audit and close without Desktop', (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-headless-eval-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = path.join(root, 'source-agent');
  const data = path.join(root, 'data');
  const output = path.join(root, 'output');
  fs.mkdirSync(agent); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'fixture.sqlite'), 'fixture');
  const fixtureHash = require('node:crypto').createHash('sha256').update('fixture').digest('hex');
  fs.writeFileSync(path.join(data, 'SHA256SUMS.txt'), `${fixtureHash}  fixture.sqlite\n`);
  fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: {} }));
  const wrapper = path.join(root, 'fake-pi');
  fs.writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "0.80.10"; exit 0; fi\nexec "${process.execPath}" "${path.join(ROOT, 'scripts/harness/fake-pi.mjs')}" "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/eval/run-traffic-agent-eval.mjs'),
    '--suite', path.join(ROOT, 'test/fixtures/eval/headless-suite.json'),
    '--model', 'fixture/model', '--pi-agent-dir', agent, '--data-root', data,
    '--output-dir', output, '--timeout-ms', '15000',
  ], {
    cwd: ROOT,
    env: { ...process.env, TAU_PI_COMMAND: wrapper, FAKE_PI_SCENARIO: path.join(ROOT, 'test/fixtures/eval/headless-scenario.json') },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const summary = JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8'));
  const run = JSON.parse(fs.readFileSync(path.join(output, 'run.json'), 'utf8'));
  assert.equal(summary.passed, true);
  assert.equal(run.host.desktop, false);
  assert.equal(run.cases[0].plan.schemaVersion, 3);
  assert.equal(run.cases[0].plan.modules.find((item: any) => item.id === 'com.transportx.shanghaidata').version, '2.0.2');
});
