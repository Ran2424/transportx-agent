const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

test('transportx arguments keep Module selection explicit', () => {
  const { parseCliArgs } = require('../bin/transportx.js');
  const parsed = parseCliArgs(['--module', 'com.transportx.task@1.0.1', '--print', '--json', '分析数据']);
  assert.deepEqual(parsed.modules, ['com.transportx.task@1.0.1']);
  assert.equal(parsed.prompt, '分析数据');
  assert.throws(() => parseCliArgs(['--no-modules', '--module', 'com.transportx.task']), /cannot be combined/);
  assert.throws(() => parseCliArgs(['--json', '分析数据']), /require --print/);
});

test('transportx runs a headless prompt without optional Modules by default', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-cli-'));
  const agentDir = path.join(root, 'agent');
  const sessionsDir = path.join(root, 'sessions');
  const projectsDir = path.join(root, 'projects');
  for (const directory of [agentDir, sessionsDir, projectsDir]) fs.mkdirSync(directory, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [
      path.join(process.cwd(), 'bin', 'transportx.js'),
      '--model', 'fake/model',
      '--cwd', projectsDir,
      '--print',
      '--json',
      'CLI smoke prompt',
    ], {
      cwd: process.cwd(),
      timeout: 20_000,
      env: {
        ...process.env,
        TAU_USER_DATA_DIR: root,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: sessionsDir,
        TAU_PROJECTS_DIR: projectsDir,
        TAU_PI_ENTRYPOINT: path.join(process.cwd(), 'scripts', 'harness', 'fake-pi.mjs'),
        TAU_PYTHON_COMMAND: '/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10',
      },
    }, (error: Error | null, stdout: string, stderr: string) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve({ stdout, stderr }));
  });

  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.type, 'result');
  assert.match(output.answer, /fake-pi/);
  const taskDirectory = path.join(projectsDir, fs.readdirSync(projectsDir)[0]);
  const plan = JSON.parse(fs.readFileSync(path.join(taskDirectory, '.tau', 'resolved-session-plan.json'), 'utf8'));
  assert.equal(plan.domain.id, 'com.transportx.cli');
  assert.deepEqual(plan.modules.map((module: any) => module.id), ['com.transportx.cli']);
  assert.equal(plan.modules.some((module: any) => module.id === 'com.transportx.geo'), false);
  assert.equal(plan.modules.some((module: any) => module.id === 'com.transportx.video'), false);
});
