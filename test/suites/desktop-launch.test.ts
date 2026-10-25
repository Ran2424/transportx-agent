const { test } = require('node:test') as typeof import('node:test');

test('Desktop Host starts, serves health, releases its lease and rejects a second writer', async (t) => {
  {
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { spawn } = require('node:child_process');
    const { toPosixPath } = require('../../bin/util/path.js');

    // desktop Agent Host binds a random loopback port and publishes ready/health
    {
      const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-host-'));
      t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
      const { writeLegacyCitationFixture } = require('../support/citation-v2.ts');
      const task = path.join(userData, 'scenario', 'old-task');
      const legacy = writeLegacyCitationFixture(task);
      const damaged = writeLegacyCitationFixture(path.join(userData, 'scenario', 'damaged-task'));
      fs.writeFileSync(damaged.file, '{damaged');
      const histories = path.join(userData, 'sessions'); fs.mkdirSync(histories, { recursive: true });
      for (const [label, fixture] of [['old', legacy], ['damaged', damaged]] as const) fs.writeFileSync(path.join(histories, `${label}.jsonl`), fixture.entries.map((entry: any) => JSON.stringify(entry.type === 'session' ? { ...entry, id: `native-${label}` } : entry)).join('\n') + '\n');

      const child = spawn(process.execPath, [path.join(process.cwd(), 'bin', 'tau.js'), '--desktop', '--parent-pid', String(process.pid)], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TAU_APP_ROOT: process.cwd(),
          TAU_RESOURCES_DIR: process.cwd(),
          TAU_USER_DATA_DIR: userData, TAU_RUNTIME_COORDINATION_DIR: path.join(userData, 'runtime-guards'), PI_CODING_AGENT_DIR: userData, PI_CODING_AGENT_SESSION_DIR: path.join(userData, 'sessions'),
          TAU_PI_ENTRYPOINT: path.join(process.cwd(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
          TAU_PYTHON_COMMAND: process.env.TAU_PYTHON_COMMAND || 'python3',
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
      assert.equal(health.protocolVersion, 2);
      let migration: any;
      const deadline = Date.now() + 15000;
      do { migration = await (await fetch(`http://127.0.0.1:${ready.port}/api/migration`)).json(); if (migration.dataState === 'ready' && migration.pending === 0) break; await new Promise((resolve) => setTimeout(resolve, 50)); } while (Date.now() < deadline);
      assert.equal(migration.dataState, 'ready'); assert.equal(migration.pending, 0);
      assert.ok(migration.inventory.items.some((item: any) => item.path === toPosixPath(fs.realpathSync(task)) && item.state === 'ready'), JSON.stringify(migration.inventory.items, null, 2));
      assert.ok(migration.inventory.items.some((item: any) => item.path === toPosixPath(fs.realpathSync(path.dirname(path.dirname(damaged.file)))) && item.state === 'failed'));
      const migrated = JSON.parse(fs.readFileSync(legacy.file, 'utf8'));
      assert.equal(migrated.version, '3.0', 'target conversion finishes independently after Host begins serving diagnostics');
      assert.equal(migrated.sessionId, 'legacy_session');
      assert.equal(migrated.evidence[0].evidenceId, 'occurrence_legacy');
      assert.equal(fs.readFileSync(damaged.file, 'utf8'), '{damaged', 'a damaged task does not prevent Host startup');
      assert.equal(fs.readFileSync(path.join(task, '.tau/migrations/workspace-v1/backups/.tau/citations.json'), 'utf8'), legacy.bytes);
      const moduleSource = path.join(userData, 'install-source');
      fs.mkdirSync(path.join(moduleSource, 'skill'), { recursive: true });
      fs.writeFileSync(path.join(moduleSource, 'skill', 'SKILL.md'), '# Local test skill');
      fs.writeFileSync(path.join(moduleSource, 'manifest.json'), JSON.stringify({ manifestVersion: 2, id: 'local.test-skill', name: 'Local test skill', version: '1.0.0', type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [], entrypoints: { skills: ['skill/SKILL.md'] } }));
      const rpc = async (command: Record<string, unknown>) => (await (await fetch(`http://127.0.0.1:${ready.port}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TransportX-Protocol': '2' }, body: JSON.stringify(command) })).json()) as any;
      let acceptTrust = false;
      const trustRequests: any[] = [];
      child.on('message', (message: any) => {
        if (message.type !== 'transportx-module-trust-request') return;
        trustRequests.push(message.request);
        child.send({ type: 'transportx-module-trust-response', id: message.id, accepted: acceptTrust });
      });
      const rejected = await rpc({ type: 'install_module', sourcePath: moduleSource, trusted: true });
      assert.equal(rejected.success, false, 'an RPC boolean cannot authorize code execution');
      assert.match(rejected.error, /trust was not accepted/);
      assert.equal(fs.existsSync(path.join(userData, 'modules', 'local.test-skill', '1.0.0')), false);
      acceptTrust = true; // This harness owns and authorizes only the temporary fixture.
      const installed = await rpc({ type: 'install_module', sourcePath: moduleSource });
      assert.equal(installed.success, true);
      assert.equal(installed.data.installed.id, 'local.test-skill');
      assert.equal(trustRequests.length, 2);
      assert.deepEqual(trustRequests[1].entrypoints, ['skill/SKILL.md']);
      assert.equal(installed.data.overview.modules.some((module: any) => module.id === 'local.test-skill' && module.removable && module.enabled), true);
      const skillModule = installed.data.overview.modules.find((module: any) => module.id === 'local.test-skill');
      assert.deepEqual(skillModule.skillFiles, [{ entryPath: 'skill/SKILL.md', name: 'Local test skill', content: '# Local test skill', truncated: false }]);
      const manifest = JSON.parse(fs.readFileSync(path.join(moduleSource, 'manifest.json'), 'utf8'));
      fs.writeFileSync(path.join(moduleSource, 'manifest.json'), JSON.stringify({ ...manifest, version: '1.0.1' }));
      acceptTrust = false;
      assert.equal((await rpc({ type: 'install_module', sourcePath: moduleSource })).success, false);
      assert.equal(fs.existsSync(path.join(userData, 'modules', 'local.test-skill', '1.0.0', 'manifest.json')), true, 'rejecting an update retains every prior version');
      assert.equal(fs.existsSync(path.join(userData, 'modules', 'local.test-skill', '1.0.1')), false);
      const yazl = require('yazl');
      const archive = path.join(userData, 'update.zip');
      const zip = new yazl.ZipFile();
      zip.addBuffer(Buffer.from(JSON.stringify({ ...manifest, version: '1.0.1' })), 'local.test-skill/1.0.1/manifest.json');
      zip.addBuffer(Buffer.from('# Local test skill'), 'local.test-skill/1.0.1/skill/SKILL.md');
      await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(archive);
        output.on('close', resolve); output.on('error', reject); zip.outputStream.on('error', reject);
        zip.outputStream.pipe(output); zip.end();
      });
      const inspection = await rpc({ type: 'inspect_module_archive', sourcePath: archive });
      assert.equal(inspection.success, true);
      const archiveDenied = await rpc({ type: 'install_module_archive', importId: inspection.data.inspection.importId, selections: [{ id: manifest.id, version: '1.0.1' }], trusted: true });
      assert.equal(archiveDenied.success, false, 'archive installation must obtain a native decision too');
      assert.equal(fs.existsSync(path.join(userData, 'modules', 'local.test-skill', '1.0.0', 'manifest.json')), true);
      assert.equal(fs.existsSync(path.join(userData, 'modules', 'local.test-skill', '1.0.1')), false);
      const invalidFolder = await rpc({ type: 'open_module_directory', moduleId: '../unregistered', path: userData });
      assert.equal(invalidFolder.success, false);
      assert.match(invalidFolder.error, /Module is unavailable/);
      const removed = await rpc({ type: 'uninstall_module', moduleId: 'local.test-skill' });
      assert.equal(removed.success, true);
      assert.equal(removed.data.overview.modules.some((module: any) => module.id === 'local.test-skill'), false);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'settings/module-trust.json'), 'utf8')), {}, 'uninstall revokes the removed package scopes');
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
      assert.equal(fs.readFileSync(damaged.file, 'utf8'), '{damaged');
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
          env: { ...process.env, TAU_APP_ROOT: process.cwd(), TAU_RESOURCES_DIR: process.cwd(), TAU_USER_DATA_DIR: userData, TAU_RUNTIME_COORDINATION_DIR: path.join(userData, 'runtime-guards'), PI_CODING_AGENT_DIR: userData, PI_CODING_AGENT_SESSION_DIR: path.join(userData, 'sessions'), TAU_PI_ENTRYPOINT: path.join(process.cwd(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'), TAU_PYTHON_COMMAND: process.env.TAU_PYTHON_COMMAND || 'python3' },
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
      const crashed = new Promise<void>((resolve) => first.once('exit', resolve));
      first.kill('SIGKILL'); await crashed;
      assert.equal(fs.existsSync(lock), true);
      const second = await start();
      assert.equal(fs.readFileSync(legacy.file, 'utf8'), migratedBytes, 'restart does not rewrite migrated registries');
      assert.ok(fs.existsSync(path.join(userData, 'migrations')), 'restart retains the migration authority');
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

    // An occupied writer serves blocked diagnostics and cannot mutate its authority
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
          TAU_USER_DATA_DIR: userData, TAU_RUNTIME_COORDINATION_DIR: path.join(userData, 'runtime-guards'), PI_CODING_AGENT_DIR: userData, PI_CODING_AGENT_SESSION_DIR: path.join(userData, 'sessions'),
          TAU_PI_ENTRYPOINT: path.join(process.cwd(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
          TAU_PYTHON_COMMAND: process.env.TAU_PYTHON_COMMAND || 'python3',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      const ready = await new Promise<any>((resolve, reject) => {
        let buffer = ''; const timer = setTimeout(() => reject(new Error(`Blocked Host did not serve diagnostics: ${stderr}`)), 10000);
        child.stdout.on('data', (chunk: Buffer) => { buffer += chunk; for (const line of buffer.split(/\r?\n/)) { try { const value = JSON.parse(line); if (value.type === 'transportx-agent-host-ready') { clearTimeout(timer); resolve(value); } } catch {} } });
        child.once('error', reject);
      });
      const base = `http://127.0.0.1:${ready.port}`;
      const health = await (await fetch(`${base}/api/health`)).json();
      assert.equal(health.protocolVersion, 2); assert.equal(health.dataState, 'blocked');
      const write = await fetch(`${base}/api/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TransportX-Protocol': '2' }, body: '{}' }); assert.equal(write.status, 503);
      const stopped = new Promise<void>((resolve) => child.once('exit', resolve)); child.kill('SIGTERM'); await stopped;
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
      const { assertPiResourceBoundary } = require('../../bin/pi-runtime.js');
      const unpatched = path.join(root, 'dist');
      fs.mkdirSync(path.join(unpatched, 'core'), { recursive: true });
      fs.writeFileSync(path.join(unpatched, 'core/resource-loader.js'), '// Unpatched Pi fixture');
      assert.throws(() => assertPiResourceBoundary([path.join(unpatched, 'cli.js')]), /boundary patch is missing/);
      const extension = path.join(root, 'extension.ts');
      const skill = path.join(root, 'SKILL.md');
      const prompt = path.join(root, 'prompt.md');
      fs.writeFileSync(extension, 'export {};\n');
      fs.writeFileSync(skill, '# Skill\n');
      fs.writeFileSync(prompt, '工作目录：{{TASK_WORKING_DIRECTORY}}\n');
      fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ name: 'Launch fixture' }));
      const plan = {
        modules: [{
          id: 'local.launch', version: '1.0.0', packageRoot: root,
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
        serviceTokens: { citation: 'citation-token', spatial: 'spatial-token', video: 'video-token', geo: 'geo-token', canvas: 'canvas-token', moduleAuthoring: 'authoring-token' },
        endpoints: { citation: 'http://127.0.0.1:3000', spatial: 'http://127.0.0.1:3001', video: 'http://127.0.0.1:3002', geo: 'http://127.0.0.1:3003', canvas: 'http://127.0.0.1:3004', moduleAuthoring: 'http://127.0.0.1:3005' },
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
