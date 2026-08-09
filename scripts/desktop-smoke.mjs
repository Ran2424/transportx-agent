import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-desktop-smoke-'));
const dataRoot = path.join(temporaryHome, '.transportx', 'traffic-agent');
const packagedApp = process.env.TRANSPORTX_PACKAGED_APP;
if (packagedApp) {
  const packagedPython = path.join(packagedApp, 'Contents', 'Resources', 'runtimes', 'python', 'bin', 'python3');
  const python = spawnSync(packagedPython, ['-B', '-I', '-c', 'import matplotlib,numpy,platform,sqlite3,ssl,yaml; print(platform.python_version())'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (python.status !== 0 || !python.stdout.trim().startsWith('3.10.')) {
    throw new Error(`Packaged Python runtime is invalid: ${(python.stderr || python.stdout).trim()}`);
  }
}
const app = await electron.launch({
  ...(packagedApp ? { executablePath: path.join(packagedApp, 'Contents', 'MacOS', 'TransportX Traffic Agent') } : { args: ['.'], cwd: process.cwd() }),
  env: {
    ...process.env,
    HOME: temporaryHome,
    TAU_USER_DATA_DIR: dataRoot,
    TAU_PYTHON_COMMAND: process.env.TAU_PYTHON_COMMAND || 'python3',
  },
});

try {
  const window = await app.firstWindow({ timeout: 20_000 });
  await window.waitForSelector('.workspace-brand', { timeout: 20_000 });
  const title = await window.title();
  const brand = await window.locator('.workspace-brand').innerText();
  if (title !== 'TransportX Traffic Agent') throw new Error(`Unexpected title: ${title}`);
  if (!brand.includes('TRANSPORTX') || !brand.includes('TRAFFIC AGENT')) throw new Error(`Unexpected brand: ${brand}`);
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const current = BrowserWindow.getAllWindows()[0];
    return current.webContents.getLastWebPreferences();
  });
  if (preferences.nodeIntegration !== false || preferences.contextIsolation !== true || preferences.sandbox !== true) {
    throw new Error(`Unsafe renderer preferences: ${JSON.stringify(preferences)}`);
  }
  const healthUrl = `${new URL(window.url()).origin}/api/health`;
  const health = await (await fetch(healthUrl)).json();
  if (health.product !== 'TransportX Traffic Agent' || health.protocolVersion !== 1) throw new Error(`Unexpected health: ${JSON.stringify(health)}`);
  const pdfResponse = await fetch(`${new URL(window.url()).origin}/api/reports/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '桌面打包验证', html: '<article><h1>TransportX</h1><p>macOS PDF bridge</p></article>' }),
  });
  const pdf = Buffer.from(await pdfResponse.arrayBuffer());
  if (!pdfResponse.ok || pdf.subarray(0, 4).toString() !== '%PDF') throw new Error(`Desktop PDF bridge failed: ${pdfResponse.status} ${pdf.toString('utf8', 0, 200)}`);
  await window.getByRole('button', { name: '打开设置' }).click();
  const settings = window.getByRole('dialog', { name: '设置' });
  await settings.waitFor();
  await settings.getByText(dataRoot, { exact: true }).waitFor();
  await settings.getByText(path.join(dataRoot, 'modules'), { exact: true }).waitFor();
  await settings.getByLabel('添加类型').waitFor();
  await settings.getByLabel('本地资源路径').waitFor();
  await window.keyboard.press('Escape');
  await window.getByRole('button', { name: '新建交通任务' }).first().click();
  const newTask = window.getByRole('dialog', { name: '新建交通任务' });
  await newTask.getByRole('button', { name: '添加模型' }).waitFor();
  if (!await newTask.getByRole('button', { name: '创建任务' }).isDisabled()) throw new Error('New task must require an explicit model');
  await window.keyboard.press('Escape');
  if (!fs.existsSync(path.join(dataRoot, 'scenario')) || !fs.existsSync(path.join(dataRoot, 'sessions')) || !fs.existsSync(path.join(dataRoot, 'modules'))) throw new Error(`TransportX data directories were not created under ${dataRoot}`);
  await app.close();
  let stopped = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await fetch(healthUrl); } catch { stopped = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!stopped) throw new Error('Agent Host remained reachable after Electron exit');
  console.log(`Desktop smoke passed: ${title} (${brand.replace(/\s+/g, ' ').trim()})`);
} finally {
  try { await app.close(); } catch {}
  fs.rmSync(temporaryHome, { recursive: true, force: true });
}
