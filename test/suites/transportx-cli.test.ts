const { test } = require('node:test') as typeof import('node:test');

test('Headless CLI honors explicit modules and refuses unreadable prompts', async (t) => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFile } = require('node:child_process');
  const { defaultUserDataDir } = require('../../bin/app-paths.js');

  // transportx arguments keep Module selection explicit
  {
    const { parseCliArgs } = require('../../bin/transportx.js');
    const parsed = parseCliArgs(['--module', 'com.transportx.interaction@1.1.0', '--append-system-prompt-file', 'eval.md', '--print', '--json', '分析数据']);
    assert.deepEqual(parsed.modules, ['com.transportx.interaction@1.1.0']);
    assert.equal(parsed.appendSystemPromptFile, path.resolve('eval.md'));
    assert.equal(parsed.prompt, '分析数据');
    assert.throws(() => parseCliArgs(['--no-modules', '--module', 'com.transportx.interaction']), /cannot be combined/);
    assert.throws(() => parseCliArgs(['--json', '分析数据']), /require --print/);
  }

  // transportx rejects an unreadable appended system prompt before starting the Host
  {
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
  }

  // transportx runs a headless prompt without optional Modules by default
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-cli-'));
    const homeDir = path.join(root, 'home');
    const sessionsDir = path.join(root, 'sessions');
    const projectsDir = path.join(root, 'projects');
    const systemPromptFile = path.join(root, 'eval-system-prompt.md');
    const launchFile = path.join(root, 'fake-pi-launch.json');
    const scenarioFile = path.join(root, 'rpc-events.json');
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
    const agentDir = defaultUserDataDir(process.platform, cliEnv);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fake: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', models: [{ id: 'model', contextWindow: 4096, maxTokens: 1024 }] } } }));
    fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({ fake: { type: 'api_key', key: 'fake-cli-key' } }));
    fs.writeFileSync(systemPromptFile, '# Evaluation policy\nAnswer exactly.\n');
    fs.writeFileSync(scenarioFile, JSON.stringify({ fallback: { steps: [
      { event: { type: 'extension_ui_request', id: 'cli_notify', method: 'notify', message: '开始分析' } },
      { event: { type: 'extension_ui_request', id: 'cli_status', method: 'setStatus', statusKey: 'progress', statusText: '分析中' } },
      { event: { type: 'extension_ui_request', id: 'cli_widget', method: 'setWidget', widgetKey: 'progress', widgetLines: ['分析中'] } },
      { event: { type: 'extension_ui_request', id: 'cli_title', method: 'setTitle', title: '分析任务' } },
      { event: { type: 'extension_ui_request', id: 'cli_editor', method: 'set_editor_text', text: '后续问题' } },
      { event: { type: 'queue_update', steering: [], followUp: [] } },
      { event: { type: 'agent_end', willRetry: true } },
      { event: { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 50, errorMessage: '429' } },
      { delay: 100 },
      { event: { type: 'auto_retry_end', success: true } },
      { event: { type: 'agent_start' } },
      { streamText: { text: 'fake-pi 重试完成后输出', chunks: 1 } },
    ] } }));
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
          TAU_PYTHON_COMMAND: process.env.TAU_PYTHON_COMMAND || 'python3',
          FAKE_PI_LAUNCH_FILE: launchFile,
          FAKE_PI_SCENARIO: scenarioFile,
        },
      }, (error: Error | null, stdout: string, stderr: string) => error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve({ stdout, stderr }));
    });

    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.type, 'result');
    assert.equal(output.answer, 'fake-pi 重试完成后输出', 'one-way events and retry agent_end do not terminate a CLI prompt');
    const launch = JSON.parse(fs.readFileSync(launchFile, 'utf8'));
    const appendPromptIndex = launch.argv.indexOf('--append-system-prompt');
    assert.match(launch.argv[appendPromptIndex + 1], /^# TransportX Agent 命令行会话上下文/);
    assert.match(launch.argv[appendPromptIndex + 1], /\n\n# Evaluation policy\nAnswer exactly\.$/);
    assert.equal(launch.piAgentDir, defaultUserDataDir(process.platform, cliEnv));
    const taskDirectory = path.join(projectsDir, fs.readdirSync(projectsDir)[0]);
    const manifest = JSON.parse(fs.readFileSync(path.join(taskDirectory, '.tau', 'workspace.json'), 'utf8'));
    assert.equal(manifest.conversations.length, 1);
    const plan = JSON.parse(fs.readFileSync(path.join(taskDirectory, '.tau', manifest.conversations[0].plan.path), 'utf8'));
    assert.equal(fs.readdirSync(projectsDir).length, 1, '--cwd is an allocation parent');
    assert.equal(plan.domain.id, 'com.transportx.cli');
    assert.deepEqual(plan.modules.map((module: any) => module.id), ['com.transportx.cli']);
    assert.equal(plan.modules.some((module: any) => module.id === 'com.transportx.geo'), false);
    assert.equal(plan.modules.some((module: any) => module.id === 'com.transportx.video'), false);
  }
});
