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

async function waitForLeaseRelease(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (fs.existsSync(lock) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stop(healthUrl) {
  await app.close();
  app = null;
  await waitForLeaseRelease();
  if (fs.existsSync(lock)) {
    try {
      const owner = JSON.parse(fs.readFileSync(ownerFile(), 'utf8'));
      let alive = false;
      try { process.kill(owner.pid, 0); alive = true; } catch {}
      console.error('[desktop-startup] lease still present', { owner, alive });
    } catch (error) {
      console.error('[desktop-startup] lease owner unreadable', error);
    }
    for (const file of ['desktop.log', 'agent-host.log']) {
      try { console.error(`[desktop-startup] ${file}\n${fs.readFileSync(path.join(dataRoot, 'logs', file), 'utf8').slice(-4000)}`); } catch {}
    }
  }
  assert.equal(fs.existsSync(lock), false, 'normal desktop exit must release its lease');
  await assert.rejects(fetch(healthUrl), 'normal desktop exit must stop its Host');
  for (const file of ['runtime.jsonl', 'agent-host.log', 'desktop.log']) {
    const records = fs.readFileSync(path.join(dataRoot, 'logs', file), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(records.length > 0 && records.every((record) => record.at && record.event), `${file} retains timestamped diagnostics after exit`);
  }
}

try {
  const fresh = await start();
  // Exercise the real preload/IPC path while replacing only the native OS dialog in this test app.
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async (_window, options) => {
      if (JSON.stringify(options.properties) !== JSON.stringify(['openDirectory'])) throw new Error('Directory-only chooser required');
      return { canceled: false, filePaths: [directory] };
    };
  }, dataRoot);
  const chooserWindow = await app.firstWindow();
  assert.equal(await chooserWindow.evaluate(() => window.transportxDesktop.selectWorkspaceDirectory()), fs.realpathSync(dataRoot).replaceAll('\\', '/'));
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  assert.equal(await chooserWindow.evaluate(() => window.transportxDesktop.selectWorkspaceDirectory()), null);
  await chooserWindow.getByRole('button', { name: /^(打开工作区|Open workspace)$/ }).first().click();
  const creation = chooserWindow.locator('.new-session-dialog');
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, dataRoot);
  await creation.getByRole('button', { name: /^(打开已有文件夹|Open an existing folder)$/ }).click();
  const expectedDirectory = fs.realpathSync(dataRoot).replaceAll('\\', '/');
  await creation.locator('.workspace-location-path').filter({ hasText: path.basename(dataRoot) }).waitFor();
  assert.equal(await creation.locator('.workspace-location-path').getAttribute('title'), expectedDirectory);
  assert.equal(await creation.locator('input[aria-label]').count(), 0, 'native folder selection renders a path card');
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await creation.getByRole('button', { name: /^(更换|Change)$/ }).click();
  assert.equal(await creation.locator('.workspace-location-path').getAttribute('title'), expectedDirectory, 'cancel keeps the previous folder');
  await creation.getByRole('button', { name: /^(取消|Cancel)$/ }).click();
  console.log('[desktop-startup] real directory chooser bridge and cancellation passed');
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
