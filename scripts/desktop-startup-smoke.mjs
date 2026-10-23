import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-startup-smoke-'));
const lock = path.join(dataRoot, 'host.transportx-lock');
let app;
function ownerFile() { return path.join(lock, fs.readdirSync(lock)[0]); }

async function start() {
  app = await electron.launch({ args: ['.'], cwd: process.cwd(), env: { ...process.env, TAU_USER_DATA_DIR: dataRoot } });
  const window = await app.firstWindow({ timeout: 20_000 });
  await window.waitForSelector('.workspace-brand', { timeout: 20_000 });
  const healthUrl = new URL('/api/health', window.url());
  assert.equal((await (await fetch(healthUrl)).json()).status, 'ok');
  return { healthUrl, owner: JSON.parse(fs.readFileSync(ownerFile(), 'utf8')) };
}

async function waitForLeaseRelease(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (fs.existsSync(lock) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stop(healthUrl) {
  await app.close();
  app = null;
  await waitForLeaseRelease();
  assert.equal(fs.existsSync(lock), false, 'normal desktop exit must release its lease');
  await assert.rejects(fetch(healthUrl), 'normal desktop exit must stop its Host');
  for (const file of ['runtime.jsonl', 'agent-host.log', 'desktop.log']) {
    const records = fs.readFileSync(path.join(dataRoot, 'logs', file), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(records.length > 0 && records.every((record) => record.at && record.event), `${file} retains timestamped diagnostics after exit`);
  }
}

try {
  const fresh = await start();
  await stop(fresh.healthUrl);
  console.log('[desktop-startup] fresh startup and normal IPC exit passed');

  const crashing = await start();
  // Suppress only this test application's native modal so the crash can reach
  // the existing unexpected-exit/quit handler without user interaction.
  await app.evaluate(({ dialog }) => { dialog.showErrorBox = () => {}; });
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Desktop did not exit after its Host crashed')), 10_000);
    app.once('close', () => { clearTimeout(timer); resolve(); });
  });
  process.kill(crashing.owner.pid, 'SIGKILL');
  await exited;
  app = null;
  assert.equal(fs.existsSync(lock), true, 'force-killed Host should leave the crash fixture');
  const crashLog = fs.readFileSync(path.join(dataRoot, 'logs', 'desktop.log'), 'utf8');
  assert.ok(crashLog.includes('host_unexpected_exit'), 'the Host crash is persisted before the desktop exits');
  const recovered = await start();
  assert.notEqual(recovered.owner.nonce, crashing.owner.nonce);
  await stop(recovered.healthUrl);
  console.log('[desktop-startup] real Host force-kill, recovery and clean exit passed');

  execFileSync(process.execPath, ['-e', "require(process.argv[1]).acquireWriteLease(require('node:path').join(process.argv[2], 'host')); process.exit(0);", path.resolve('bin/util/json-storage.js'), dataRoot]);
  const legacyOwner = JSON.parse(fs.readFileSync(ownerFile(), 'utf8'));
  fs.renameSync(ownerFile(), path.join(lock, 'owner.json'));
  const legacy = await start();
  assert.notEqual(legacy.owner.nonce, legacyOwner.nonce);
  await stop(legacy.healthUrl);
  console.log('[desktop-startup] legacy owner.json recovery and clean exit passed');
} finally {
  try { await app?.close(); } finally { fs.rmSync(dataRoot, { recursive: true, force: true }); }
}
