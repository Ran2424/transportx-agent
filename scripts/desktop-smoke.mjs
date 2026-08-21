import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { _electron as electron } from 'playwright';

const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-desktop-smoke-'));
const dataRoot = process.env.TRANSPORTX_SMOKE_DATA_ROOT || path.join(temporaryHome, '.transportx', 'traffic-agent');
const packagedApp = process.env.TRANSPORTX_PACKAGED_APP;

function packagedLayout(input) {
  const packagedPath = path.resolve(input);
  if (process.platform === 'darwin') {
    return {
      executable: path.join(packagedPath, 'Contents', 'MacOS', 'TransportX Traffic Agent'),
      resourcesDir: path.join(packagedPath, 'Contents', 'Resources'),
    };
  }
  if (process.platform === 'win32') {
    const executable = path.extname(packagedPath).toLowerCase() === '.exe'
      ? packagedPath
      : path.join(packagedPath, 'TransportX Traffic Agent.exe');
    return { executable, resourcesDir: path.join(path.dirname(executable), 'resources') };
  }
  throw new Error(`Packaged desktop smoke is unsupported on ${process.platform}`);
}

const packaged = packagedApp ? packagedLayout(packagedApp) : null;
if (packaged) {
  if (!fs.existsSync(packaged.executable)) throw new Error(`Packaged application is missing: ${packaged.executable}`);
  const resourcesDir = packaged.resourcesDir;
  const manifest = JSON.parse(fs.readFileSync(path.join(resourcesDir, 'runtime-manifest.json'), 'utf8'));
  const packagedPython = path.join(resourcesDir, manifest.python?.path || '');
  const python = spawnSync(packagedPython, ['-B', '-I', '-c', 'import matplotlib,numpy,platform,sqlite3,ssl,yaml; print(platform.python_version())'], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (python.status !== 0 || !python.stdout.trim().startsWith('3.10.')) {
    throw new Error(`Packaged Python runtime is invalid: ${(python.stderr || python.stdout).trim()}`);
  }
  // Video runtime: ffmpeg/ffprobe must be present, runnable and integrity-recorded.
  for (const name of ['ffmpeg', 'ffprobe']) {
    const entry = manifest[name];
    if (!entry || !entry.sha256 || !entry.version) throw new Error(`Packaged runtime manifest is missing the ${name} entry`);
    const binary = path.join(resourcesDir, entry.path);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    if (digest !== entry.sha256) throw new Error(`Packaged ${name} checksum mismatch`);
    const probe = spawnSync(binary, ['-version'], { encoding: 'utf8' });
    if (probe.status !== 0 || !probe.stdout.includes(entry.version)) throw new Error(`Packaged ${name} is invalid: ${(probe.stderr || probe.stdout).trim()}`);
  }
  console.log(`[desktop-smoke] packaged ffmpeg runtime OK (ffmpeg ${manifest.ffmpeg.version})`);
}
const app = await electron.launch({
  ...(packaged ? { executablePath: packaged.executable } : { args: ['.'], cwd: process.cwd() }),
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
  const normalizedBrand = brand.toUpperCase();
  if (!normalizedBrand.includes('TRANSPORTX') || !normalizedBrand.includes('TRAFFIC AGENT')) throw new Error(`Unexpected brand: ${brand}`);
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
  // Phase 0 playback spike: the packaged renderer must accept the Video Input Spec codec.
  const codecSupport = await window.evaluate(() => {
    const probe = document.createElement('video');
    return {
      h264: probe.canPlayType('video/mp4; codecs="avc1.42E01E"'),
      aac: probe.canPlayType('video/mp4; codecs="mp4a.40.2"'),
    };
  });
  if (!codecSupport.h264 || codecSupport.h264 === 'no') throw new Error(`Packaged renderer cannot play H.264 MP4: ${JSON.stringify(codecSupport)}`);
  console.log(`[desktop-smoke] renderer video codec support OK (${codecSupport.h264})`);
  const oversizedDataUrlPayload = 'A'.repeat(1_500_000);
  const pdfResponse = await fetch(`${new URL(window.url()).origin}/api/reports/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '桌面打包验证', html: `<article data-payload="${oversizedDataUrlPayload}"><h1>TransportX</h1><p>Desktop PDF bridge</p></article>` }),
  });
  const pdf = Buffer.from(await pdfResponse.arrayBuffer());
  if (!pdfResponse.ok || pdf.subarray(0, 4).toString() !== '%PDF') throw new Error(`Desktop PDF bridge failed: ${pdfResponse.status} ${pdf.toString('utf8', 0, 200)}`);
  const downloadsDir = path.join(temporaryHome, 'Downloads');
  await app.evaluate(({ app }, value) => app.setPath('downloads', value), downloadsDir);
  const downloadedPdfPath = await window.evaluate(async (origin) => {
    const response = await fetch(`${origin}/api/reports/pdf/download`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '桌面下载验证', html: '<article><h1>TransportX</h1><p>Desktop download test</p></article>' }),
    });
    const { url } = await response.json();
    return await window.transportxDesktop.download(url);
  }, new URL(window.url()).origin);
  if (!downloadedPdfPath.startsWith(`${downloadsDir}${path.sep}`) || !fs.existsSync(downloadedPdfPath) || fs.readFileSync(downloadedPdfPath).subarray(0, 4).toString() !== '%PDF') throw new Error('Desktop PDF download was not saved');
  await window.getByRole('button', { name: '打开设置' }).click();
  const settings = window.getByTestId('settings-workspace');
  await settings.waitFor();
  await settings.getByText(dataRoot, { exact: true }).waitFor();
  await settings.getByText(path.join(dataRoot, 'modules'), { exact: true }).waitFor();
  await settings.getByRole('button', { name: '模块', exact: true }).click();
  await settings.getByLabel('模块包路径').waitFor();
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
