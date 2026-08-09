const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('desktop Agent Host binds a random loopback port and publishes ready/health', async (t: any) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-host-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const child = spawn(process.execPath, [path.join(process.cwd(), 'bin', 'tau.js'), '--desktop', '--parent-pid', String(process.pid)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TAU_APP_ROOT: process.cwd(),
      TAU_RESOURCES_DIR: process.cwd(),
      TAU_USER_DATA_DIR: userData,
      TAU_PI_ENTRYPOINT: path.join(process.cwd(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
      TAU_PYTHON_COMMAND: process.execPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
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
        } catch {}
      }
    });
    child.once('exit', (code: number | null) => { clearTimeout(timer); reject(new Error(`Agent Host exited ${code}: ${stderr}`)); });
  });
  assert.equal(ready.host, '127.0.0.1');
  assert.ok(ready.port > 0);
  const health = await (await fetch(`http://127.0.0.1:${ready.port}/api/health`)).json();
  assert.equal(health.product, 'TransportX Traffic Agent');
  assert.equal(health.protocolVersion, 1);
  const skillSource = path.join(userData, 'install-source');
  fs.mkdirSync(skillSource);
  fs.writeFileSync(path.join(skillSource, 'SKILL.md'), '# Local test skill');
  const rpc = async (command: Record<string, unknown>) => (await (await fetch(`http://127.0.0.1:${ready.port}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) })).json()) as any;
  const installed = await rpc({ type: 'install_module', kind: 'skill', sourcePath: skillSource });
  assert.equal(installed.success, true);
  assert.equal(installed.data.installed.id, 'local.skill.install-source');
  assert.equal(installed.data.overview.modules.some((module: any) => module.id === 'local.skill.install-source' && module.removable), true);
  const removed = await rpc({ type: 'uninstall_module', moduleId: 'local.skill.install-source' });
  assert.equal(removed.success, true);
  assert.equal(removed.data.overview.modules.some((module: any) => module.id === 'local.skill.install-source'), false);
  child.kill('SIGTERM');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Agent Host did not exit after SIGTERM')), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
});
