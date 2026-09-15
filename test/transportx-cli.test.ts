const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { defaultUserDataDir } = require('../bin/app-paths.js');

test('transportx arguments keep Module selection explicit', () => {
  const { parseCliArgs } = require('../bin/transportx.js');
  const parsed = parseCliArgs(['--module', 'com.transportx.task@1.0.1', '--append-system-prompt-file', 'eval.md', '--print', '--json', '分析数据']);
  assert.deepEqual(parsed.modules, ['com.transportx.task@1.0.1']);
  assert.equal(parsed.appendSystemPromptFile, path.resolve('eval.md'));
  assert.equal(parsed.prompt, '分析数据');
  assert.throws(() => parseCliArgs(['--no-modules', '--module', 'com.transportx.task']), /cannot be combined/);
  assert.throws(() => parseCliArgs(['--json', '分析数据']), /require --print/);
});

test('transportx rejects an unreadable appended system prompt before starting the Host', async () => {
  await assert.rejects(new Promise((resolve, reject) => {
    execFile(process.execPath, [
      path.join(process.cwd(), 'bin', 'transportx.js'),
      '--append-system-prompt-file', path.join(os.tmpdir(), `missing-${Date.now()}.md`),
      '--print',
      'CLI smoke prompt',
    ], { cwd: process.cwd(), timeout: 5_000 }, (error: Error & { code?: number } | null, _stdout: string, stderr: string) => {
      if (!error) return resolve(undefined);
      reject(Object.assign(error, { message: stderr.trim(), exitCode: error.code }));
    });
  }), (error: Error & { exitCode?: number }) => error.exitCode === 2 && /Cannot read appended system prompt file/.test(error.message));
});

test('transportx runs a headless prompt without optional Modules by default', async (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-cli-'));
  const homeDir = path.join(root, 'home');
  const sessionsDir = path.join(root, 'sessions');
  const projectsDir = path.join(root, 'projects');
  const systemPromptFile = path.join(root, 'eval-system-prompt.md');
  const launchFile = path.join(root, 'fake-pi-launch.json');
  const cliEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: path.join(homeDir, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    TAU_USER_DATA_DIR: '',
    PI_CODING_AGENT_DIR: '',
  };
  for (const directory of [homeDir, sessionsDir, projectsDir]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(systemPromptFile, '# Evaluation policy\nAnswer exactly.\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(process.execPath, [
      path.join(process.cwd(), 'bin', 'transportx.js'),
      '--model', 'fake/model',
      '--cwd', projectsDir,
      '--append-system-prompt-file', systemPromptFile,
      '--print',
      '--json',
      'CLI smoke prompt',
    ], {
      cwd: process.cwd(),
      timeout: 20_000,
      env: {
        ...cliEnv,
        PI_CODING_AGENT_SESSION_DIR: sessionsDir,
        TAU_PROJECTS_DIR: projectsDir,
        TAU_PI_ENTRYPOINT: path.join(process.cwd(), 'scripts', 'harness', 'fake-pi.mjs'),
        TAU_PYTHON_COMMAND: '/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10',
        FAKE_PI_LAUNCH_FILE: launchFile,
      },
    }, (error: Error | null, stdout: string, stderr: string) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve({ stdout, stderr }));
  });

  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.type, 'result');
  assert.match(output.answer, /fake-pi/);
  const launch = JSON.parse(fs.readFileSync(launchFile, 'utf8'));
  const appendPromptIndex = launch.argv.indexOf('--append-system-prompt');
  assert.match(launch.argv[appendPromptIndex + 1], /^# TransportX Agent 命令行会话上下文/);
  assert.match(launch.argv[appendPromptIndex + 1], /\n\n# Evaluation policy\nAnswer exactly\.$/);
  assert.equal(launch.piAgentDir, defaultUserDataDir(process.platform, cliEnv));
  const taskDirectory = path.join(projectsDir, fs.readdirSync(projectsDir)[0]);
  const plan = JSON.parse(fs.readFileSync(path.join(taskDirectory, '.tau', 'resolved-session-plan.json'), 'utf8'));
  assert.equal(plan.domain.id, 'com.transportx.cli');
  assert.deepEqual(plan.modules.map((module: any) => module.id), ['com.transportx.cli']);
  assert.equal(plan.modules.some((module: any) => module.id === 'com.transportx.geo'), false);
  assert.equal(plan.modules.some((module: any) => module.id === 'com.transportx.video'), false);
});
