const { test } = require('node:test') as typeof import('node:test');

test('Desktop Host starts, serves health, releases its lease and rejects a second writer', async (t) => {
  {
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { spawn } = require('node:child_process');

    // desktop Agent Host binds a random loopback port and publishes ready/health
    {
      const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-host-'));
      t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
      const { writeLegacyCitationFixture } = require('../support/citation-v2.ts');
      const task = path.join(userData, 'scenario', 'old-task');
      const legacy = writeLegacyCitationFixture(task);
      const damaged = writeLegacyCitationFixture(path.join(userData, 'scenario', 'damaged-task'));
      fs.writeFileSync(damaged.file, '{damaged');
      const child = spawn(process.execPath, [path.join(process.cwd(), 'bin', 'tau.js'), '--desktop', '--parent-pid', String(process.pid)], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TAU_APP_ROOT: process.cwd(),
          TAU_RESOURCES_DIR: process.cwd(),
          TAU_USER_DATA_DIR: userData, PI_CODING_AGENT_DIR: userData, PI_CODING_AGENT_SESSION_DIR: path.join(userData, 'sessions'),
          TAU_PI_ENTRYPOINT: path.join(process.cwd(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
          TAU_PYTHON_COMMAND: process.execPath,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      const ready = await new Promise<any>((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error(`ready timeout: ${stderr}`)), 10_000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) {
            try {
              const value = JSON.parse(line);
              if (value.type === 'transportx-agent-host-ready') { clearTimeout(timer); resolve(value); }
            } catch { }
          }
        });
        child.once('exit', (code: number | null) => { clearTimeout(timer); reject(new Error(`Agent Host exited ${code}: ${stderr}`)); });
      });
      assert.equal(ready.host, '127.0.0.1');
      assert.ok(ready.port > 0);
      const health = await (await fetch(`http://127.0.0.1:${ready.port}/api/health`)).json();
      assert.equal(health.product, 'TransportX Agent');
      assert.equal(health.protocolVersion, 1);
      const migrated = JSON.parse(fs.readFileSync(legacy.file, 'utf8'));
      assert.equal(migrated.version, '3.0', 'upgrade migration finishes before Host readiness');
      assert.equal(migrated.sessionId, 'legacy_session');
      assert.equal(migrated.evidence[0].evidenceId, 'occurrence_legacy');
      assert.equal(fs.readFileSync(damaged.file, 'utf8'), '{damaged', 'a damaged task does not prevent Host startup');
      const backup = path.join(userData, 'migrations', fs.readdirSync(path.join(userData, 'migrations'))[0]);
      assert.equal(fs.readFileSync(path.join(backup, 'scenario', 'old-task', '.tau', 'citations.json'), 'utf8'), legacy.bytes);
      const moduleSource = path.join(userData, 'install-source');
      fs.mkdirSync(path.join(moduleSource, 'skill'), { recursive: true });
      fs.writeFileSync(path.join(moduleSource, 'skill', 'SKILL.md'), '# Local test skill');
      fs.writeFileSync(path.join(moduleSource, 'manifest.json'), JSON.stringify({ manifestVersion: 2, id: 'local.test-skill', name: 'Local test skill', version: '1.0.0', type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [], entrypoints: { skills: ['skill/SKILL.md'] } }));
      const rpc = async (command: Record<string, unknown>) => (await (await fetch(`http://127.0.0.1:${ready.port}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) })).json()) as any;
      const installed = await rpc({ type: 'install_module', sourcePath: moduleSource });
      assert.equal(installed.success, true);
      assert.equal(installed.data.installed.id, 'local.test-skill');
      assert.equal(installed.data.overview.modules.some((module: any) => module.id === 'local.test-skill' && module.removable && module.enabled), true);
      const skillModule = installed.data.overview.modules.find((module: any) => module.id === 'local.test-skill');
      assert.deepEqual(skillModule.skillFiles, [{ entryPath: 'skill/SKILL.md', name: 'Local test skill', content: '# Local test skill', truncated: false }]);
      const invalidFolder = await rpc({ type: 'open_module_directory', moduleId: '../unregistered', path: userData });
      assert.equal(invalidFolder.success, false);
      assert.match(invalidFolder.error, /Module is unavailable/);
      const removed = await rpc({ type: 'uninstall_module', moduleId: 'local.test-skill' });
      assert.equal(removed.success, true);
      assert.equal(removed.data.overview.modules.some((module: any) => module.id === 'local.test-skill'), false);
      const stopped = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Agent Host did not exit after SIGTERM')), 5000);
        child.once('exit', (code: number) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`Host exited ${code}`)); });
      });
      const acknowledgement = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Host did not acknowledge update preparation')), 5000);
        child.on('message', (message: any) => { if (message.type === 'transportx-update-stopped') { clearTimeout(timer); resolve(message); } });
      });
      child.send({ type: 'transportx-update-stop', id: 'desktop-test-update' });
      assert.deepEqual(await acknowledgement, { type: 'transportx-update-stopped', id: 'desktop-test-update', ok: true });
      await stopped;
      assert.equal(fs.existsSync(userData), true);
      assert.equal(fs.existsSync(path.join(userData, 'host.transportx-lock')), false);
      const records = fs.readFileSync(path.join(userData, 'logs', 'runtime.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(records.some((entry: any) => entry.event === 'host_ready'), 'Host startup logs remain in user data after exit');
      assert.ok(records.some((entry: any) => entry.event === 'citation_registry_migrated'));
      assert.ok(records.some((entry: any) => entry.event === 'citation_migration_failed'));
    }

    // Force-kill leaves a dead lease; the next Host recovers it and normal IPC stop removes it.
    {
      const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-host-restart-'));
      t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
      const { writeLegacyCitationFixture } = require('../support/citation-v2.ts');
      const legacy = writeLegacyCitationFixture(path.join(userData, 'scenario', 'old-task'));
      const lock = path.join(userData, 'host.transportx-lock');
      const start = async () => {
        const child = spawn(process.execPath, [path.join(process.cwd(), 'bin', 'tau.js'), '--desktop', '--parent-pid', String(process.pid)], {
          cwd: process.cwd(),
          env: { ...process.env, TAU_APP_ROOT: process.cwd(), TAU_RESOURCES_DIR: process.cwd(), TAU_USER_DATA_DIR: userData, PI_CODING_AGENT_DIR: userData, PI_CODING_AGENT_SESSION_DIR: path.join(userData, 'sessions'), TAU_PI_ENTRYPOINT: path.join(process.cwd(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'), TAU_PYTHON_COMMAND: process.execPath },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
        const ready = await new Promise<any>((resolve, reject) => {
          let buffer = '';
          const timer = setTimeout(() => reject(new Error(`restart ready timeout: ${stderr}`)), 10_000);
          child.stdout.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
            for (const line of lines) {
              try { const value = JSON.parse(line); if (value.type === 'transportx-agent-host-ready') { clearTimeout(timer); resolve(value); } } catch {}
            }
          });
          child.once('error', (error: Error) => { clearTimeout(timer); reject(error); });
          child.once('exit', (code: number) => { clearTimeout(timer); reject(new Error(`Restart exited ${code}: ${stderr}`)); });
        });
        assert.equal((await (await fetch(`http://127.0.0.1:${ready.port}/api/health`)).json()).status, 'ok');
        return child;
      };
      const first = await start();
      const migratedBytes = fs.readFileSync(legacy.file, 'utf8');
      const backups = fs.readdirSync(path.join(userData, 'migrations'));
      const crashed = new Promise<void>((resolve) => first.once('exit', resolve));
      first.kill('SIGKILL'); await crashed;
      assert.equal(fs.existsSync(lock), true);
      const second = await start();
      assert.equal(fs.readFileSync(legacy.file, 'utf8'), migratedBytes, 'restart does not rewrite migrated registries');
      assert.deepEqual(fs.readdirSync(path.join(userData, 'migrations')), backups);
      const ownerFile = path.join(lock, fs.readdirSync(lock)[0]);
      assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).pid, second.pid);
      const stopped = new Promise<number>((resolve) => second.once('exit', resolve));
      second.send({ type: 'transportx-agent-host-stop' });
      assert.equal(await stopped, 0);
      assert.equal(fs.existsSync(lock), false);
      const third = await start();
      const stoppedAgain = new Promise<number>((resolve) => third.once('exit', resolve));
      third.send({ type: 'transportx-agent-host-stop' });
      assert.equal(await stoppedAgain, 0);
      assert.equal(fs.existsSync(lock), false);
    }

    // desktop startup refuses an occupied Host lease with a failure exit code
    {
      const { acquireWriteLease } = require('../../bin/util/json-storage.js');
      const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-host-busy-'));
      t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
      const release = acquireWriteLease(path.join(userData, 'host'));
      t.after(release);
      const lock = path.join(userData, 'host.transportx-lock');
      const ownerPath = path.join(lock, fs.readdirSync(lock)[0]);
      const owner = fs.readFileSync(ownerPath, 'utf8');
      const { writeLegacyCitationFixture } = require('../support/citation-v2.ts');
      const legacy = writeLegacyCitationFixture(path.join(userData, 'scenario', 'locked-task'));
      const child = spawn(process.execPath, [path.join(process.cwd(), 'bin', 'tau.js'), '--desktop'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TAU_APP_ROOT: process.cwd(),
          TAU_RESOURCES_DIR: process.cwd(),
          TAU_USER_DATA_DIR: userData, PI_CODING_AGENT_DIR: userData, PI_CODING_AGENT_SESSION_DIR: path.join(userData, 'sessions'),
          TAU_PI_ENTRYPOINT: path.join(process.cwd(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
          TAU_PYTHON_COMMAND: process.execPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Occupied Host startup did not exit')), 10_000);
        child.once('error', (error: Error) => { clearTimeout(timer); reject(error); });
        child.once('close', (code: number | null) => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(code, 1);
      assert.match(stderr, /Another writer owns/);
      assert.equal(fs.readFileSync(ownerPath, 'utf8'), owner);
      assert.equal(fs.readFileSync(legacy.file, 'utf8'), legacy.bytes, 'a second writer cannot migrate user data');
      assert.equal(fs.existsSync(path.join(userData, 'migrations')), false);
    }
  }

  {
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { buildSessionPiLaunch } = require('../../bin/session-pi-launch.js');

    // builds Pi startup arguments and session-scoped asset environment
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-session-pi-launch-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const extension = path.join(root, 'extension.ts');
      const skill = path.join(root, 'SKILL.md');
      const prompt = path.join(root, 'prompt.md');
      fs.writeFileSync(extension, 'export {};\n');
      fs.writeFileSync(skill, '# Skill\n');
      fs.writeFileSync(prompt, '工作目录：{{TASK_WORKING_DIRECTORY}}\n');
      const plan = {
        modules: [{
          entrypoints: [
            { kind: 'extension', path: extension },
            { kind: 'skill', path: skill },
            { kind: 'prompt', path: prompt },
          ]
        }],
        assets: [
          { id: 'data:roads', kind: 'data', path: '/assets/roads' },
          { id: 'knowledge:rules', kind: 'knowledge', path: '/assets/rules' },
        ],
      };
      const launch = buildSessionPiLaunch({
        cwd: root,
        sessionId: 'tau_1',
        sessionFile: '/tmp/history.jsonl',
        modelSpec: 'openai/gpt-5',
        appendSystemPrompt: '# Evaluation policy\nAnswer exactly.',
        resolvedSessionPlan: plan,
        serviceTokens: { citation: 'citation-token', spatial: 'spatial-token', video: 'video-token', geo: 'geo-token', canvas: 'canvas-token' },
        endpoints: { citation: 'http://127.0.0.1:3000', spatial: 'http://127.0.0.1:3001', video: 'http://127.0.0.1:3002', geo: 'http://127.0.0.1:3003', canvas: 'http://127.0.0.1:3004' },
      });

      assert.deepEqual(launch.args.slice(-10), [
        '--extension', extension,
        '--skill', skill,
        '--append-system-prompt', `工作目录：${root}\n\n# Evaluation policy\nAnswer exactly.`,
        '--session', '/tmp/history.jsonl',
        '--model', 'openai/gpt-5',
      ]);
      const { hostPlatform } = require('../../bin/host-platform.js');
      const promptRoot = path.join(process.cwd(), 'src/server/prompts');
      assert.equal(launch.args[launch.args.indexOf('--system-prompt') + 1], ['PI_SYSTEM.md', hostPlatform.systemPrompt].map((file) => fs.readFileSync(path.join(promptRoot, file), 'utf8').trim()).join('\n\n'));
      assert.equal(launch.env.TAU_VIDEO_TOKEN, 'video-token');
      assert.equal(launch.env.TAU_CANVAS_TOKEN, 'canvas-token');
      assert.deepEqual(JSON.parse(launch.env.TRANSPORTX_DATA_ASSETS_JSON), { 'data:roads': '/assets/roads' });
      assert.deepEqual(JSON.parse(launch.env.TRANSPORTX_KNOWLEDGE_ASSETS_JSON), { 'knowledge:rules': '/assets/rules' });
    }
  }
});
