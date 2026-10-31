import { protocolHeaders } from './harness/workspace-client.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { _electron as electron } from 'playwright';
import { hostPlatformOperations } from '../desktop/scripts/platform-profile.mjs';

const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-desktop-smoke-'));
const dataRoot = process.env.TRANSPORTX_SMOKE_DATA_ROOT || path.join(temporaryHome, '.transportx', 'traffic-agent');
const packagedApp = process.env.TRANSPORTX_PACKAGED_APP;

function packagedLayout(input) {
  const packagedPath = path.resolve(input);
  const profile = hostPlatformOperations().packaged;
  if (!profile) throw new Error(`Packaged desktop smoke is unsupported on ${process.platform}`);
  const directExecutable = profile.executableExtension && path.extname(packagedPath).toLowerCase() === profile.executableExtension;
  const root = directExecutable ? path.dirname(packagedPath) : packagedPath;
  return { executable: directExecutable ? packagedPath : path.join(root, ...profile.executableParts), resourcesDir: path.join(root, ...profile.resourcesParts) };
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
  if (manifest.ffmpeg || manifest.ffprobe || fs.existsSync(path.join(resourcesDir, 'runtimes', 'ffmpeg'))) {
    throw new Error('Base desktop package must not contain the optional ffmpeg runtime');
  }
  console.log('[desktop-smoke] optional ffmpeg runtime is absent from the base package');
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
  if (title !== 'TransportX Agent') throw new Error(`Unexpected title: ${title}`);
  const normalizedBrand = brand.toUpperCase();
  if (!normalizedBrand.includes('TRANSPORTX') || !normalizedBrand.includes('AGENT')) throw new Error(`Unexpected brand: ${brand}`);
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const current = BrowserWindow.getAllWindows()[0];
    return current.webContents.getLastWebPreferences();
  });
  if (preferences.nodeIntegration !== false || preferences.contextIsolation !== true || preferences.sandbox !== true) {
    throw new Error(`Unsafe renderer preferences: ${JSON.stringify(preferences)}`);
  }
  const healthUrl = `${new URL(window.url()).origin}/api/health`;
  let health = await (await fetch(healthUrl)).json();
  const inventoryDeadline = Date.now() + 20_000;
  while (health.dataState === 'initializing' && Date.now() < inventoryDeadline) { await new Promise((resolve) => setTimeout(resolve, 100)); health = await (await fetch(healthUrl)).json(); }
  if (health.dataState !== 'ready') throw new Error(`Desktop data inventory is unavailable: ${health.dataState}`);
  if (health.product !== 'TransportX Agent' || health.protocolVersion !== 2) throw new Error(`Unexpected health: ${JSON.stringify(health)}`);
  // Exercise the production Host -> Supervisor -> Electron dialog channel. Only
  // this test-owned fixture is accepted; the native decision itself is stubbed.
  const trustSource = path.join(temporaryHome, 'trust-probe');
  const trustMarker = path.join(temporaryHome, 'trust-probe-executed');
  fs.mkdirSync(trustSource);
  fs.writeFileSync(path.join(trustSource, 'manifest.json'), JSON.stringify({ manifestVersion: 2, id: 'local.desktop-trust-probe', name: 'Desktop trust fixture', version: '1.0.0', type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [], entrypoints: { piExtensions: ['index.js'] } }));
  fs.writeFileSync(path.join(trustSource, 'index.js'), `require('node:fs').writeFileSync(${JSON.stringify(trustMarker)}, 'executed');`);
  await app.evaluate(({ dialog }) => {
    globalThis.transportxTrustDialogOriginal = dialog.showMessageBox;
    globalThis.transportxTrustDecision = 0;
    globalThis.transportxTrustDialogs = [];
    dialog.showMessageBox = async (options) => {
      globalThis.transportxTrustDialogs.push(options);
      return { response: globalThis.transportxTrustDecision, checkboxChecked: false };
    };
  });
  const moduleRpc = async (body) => (await (await fetch(new URL('/api/rpc', healthUrl), { method: 'POST', headers: { 'Content-Type': 'application/json', ...protocolHeaders }, body: JSON.stringify(body) })).json());
  try {
    const denied = await moduleRpc({ type: 'install_module', sourcePath: trustSource, trusted: true });
    if (denied.success !== false || fs.existsSync(trustMarker)) throw new Error('Native trust rejection did not block the fixture');
    await app.evaluate(() => { globalThis.transportxTrustDecision = 1; });
    const accepted = await moduleRpc({ type: 'install_module', sourcePath: trustSource });
    if (!accepted.success || fs.existsSync(trustMarker)) throw new Error('Static installation executed the fixture or ignored native acceptance');
    const dialogs = await app.evaluate(() => globalThis.transportxTrustDialogs);
    if (dialogs.length !== 2 || dialogs.some((item) => item.defaultId !== 0 || item.cancelId !== 0 || !item.detail.includes('index.js') || !item.message.includes('local.desktop-trust-probe@1.0.0'))) throw new Error('Native trust disclosure or default choice is incorrect');
    if (!(await moduleRpc({ type: 'uninstall_module', moduleId: 'local.desktop-trust-probe' })).success) throw new Error('Could not remove the test-owned module');
    console.log('[desktop-smoke] native module trust IPC, rejection, acceptance and static install OK (test-owned decision stub)');
  } finally {
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = globalThis.transportxTrustDialogOriginal; });
  }
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
    headers: { 'Content-Type': 'application/json', ...protocolHeaders },
    body: JSON.stringify({ title: '桌面打包验证', html: `<article data-payload="${oversizedDataUrlPayload}"><h1>TransportX</h1><p>Desktop PDF bridge</p></article>` }),
  });
  const pdf = Buffer.from(await pdfResponse.arrayBuffer());
  if (!pdfResponse.ok || pdf.subarray(0, 4).toString() !== '%PDF') throw new Error(`Desktop PDF bridge failed: ${pdfResponse.status} ${pdf.toString('utf8', 0, 200)}`);
  const downloadsDir = path.join(temporaryHome, 'Downloads');
  await app.evaluate(({ app }, value) => app.setPath('downloads', value), downloadsDir);
  const downloadedPdfPath = await window.evaluate(async (origin) => {
    const response = await fetch(`${origin}/api/reports/pdf/download`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TransportX-Protocol': '2' },
      body: JSON.stringify({ title: '桌面下载验证', html: '<article><h1>TransportX</h1><p>Desktop download test</p></article>' }),
    });
    const { url } = await response.json();
    return await window.transportxDesktop.download(url);
  }, new URL(window.url()).origin);
  if (path.relative(downloadsDir, downloadedPdfPath).startsWith('..') || path.isAbsolute(path.relative(downloadsDir, downloadedPdfPath)) || !fs.existsSync(downloadedPdfPath) || fs.readFileSync(downloadedPdfPath).subarray(0, 4).toString() !== '%PDF') throw new Error('Desktop PDF download was not saved');
  // Prepare a test-owned PDF for the Canvas rendering check below.
  const previewUrl = await window.evaluate(async () => {
    const response = await fetch('/api/reports/pdf/download', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TransportX-Protocol': '2' },
      body: JSON.stringify({ title: 'Canvas page navigation', html: [1, 2, 3].map((page) => `<section style="${page < 3 ? 'break-after:page;' : ''}font-size:40px">CANVAS PDF PAGE ${page}</section>`).join('') }),
    });
    const { url } = await response.json();
    return url;
  });
  const inlinePdf = await (await fetch(new URL(previewUrl, window.url()))).arrayBuffer();
  await window.getByRole('button', { name: '打开设置' }).click();
  const settings = window.getByTestId('settings-workspace');
  await settings.waitFor();
  const updateState = await window.evaluate(() => window.transportxDesktop.update.getState());
  const appVersion = await app.evaluate(({ app }) => app.getVersion());
  if (updateState.currentVersion !== appVersion || (packaged ? updateState.phase === 'disabled' : updateState.phase !== 'disabled')) {
    throw new Error(`Unexpected desktop update bridge state: ${JSON.stringify(updateState)}`);
  }
  await settings.getByTestId('software-update').getByText(`当前版本 ${appVersion}`, { exact: true }).waitFor();
  console.log(`[desktop-smoke] update bridge OK (${updateState.phase}, ${appVersion})`);
  await settings.getByText(dataRoot, { exact: true }).waitFor();
  await settings.getByText(path.join(dataRoot, 'modules'), { exact: true }).waitFor();
  await settings.getByRole('button', { name: '模块', exact: true }).click();
  await settings.getByLabel('模块包路径').waitFor();
  await window.keyboard.press('Escape');
  const newWorkspace = window.getByRole('button', { name: '打开工作区', exact: true }).first();
  if (!await newWorkspace.isVisible()) await window.getByRole('button', { name: '打开或关闭侧栏', exact: true }).click();
  await newWorkspace.click();
  const newTask = window.getByRole('dialog', { name: '打开工作区' });
  await newTask.locator('.menu-select-trigger').click();
  await newTask.getByRole('option', { name: '添加模型' }).waitFor();
  await window.keyboard.press('Escape');
  if (!await newTask.getByRole('button', { name: '进入工作区' }).isDisabled()) throw new Error('New task must require an explicit model');
  await window.keyboard.press('Escape');
  if (!process.env.TRANSPORTX_SMOKE_DATA_ROOT) {
    const added = await moduleRpc({ type: 'add_model', provider: 'desktop-smoke', modelId: 'smoke', name: 'Desktop test model', baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'test-owned-desktop-key', contextWindow: 8192, maxTokens: 1024 });
    if (!added.success) throw new Error(JSON.stringify(added));
    const urls = []; window.on('request', (request) => urls.push(request.url()));
    await newWorkspace.click();
    await newTask.getByRole('button', { name: '创建新文件夹', exact: true }).click();
    await newTask.locator('.workspace-advanced > summary').click();
    await newTask.getByLabel('工作区名称', { exact: true }).fill('Desktop workspace');
    await newTask.getByLabel('会话名称（可选）', { exact: true }).fill('Desktop durable conversation');
    await newTask.getByRole('button', { name: '进入工作区', exact: true }).click();
    await window.getByLabel('消息输入').waitFor();
    const conversationId = await window.evaluate(() => localStorage.getItem('tau-active-conversation-id'));
    if ((await (await fetch(healthUrl)).json()).liveSessionCount !== 0) throw new Error('Desktop creation unexpectedly started Pi');
    await window.reload();
    await window.getByLabel('消息输入').waitFor();
    if (await window.evaluate(() => localStorage.getItem('tau-active-conversation-id')) !== conversationId) throw new Error('Desktop reload lost the saved identity');
    const activated = await fetch(new URL(`/api/conversations/${conversationId}/activate`, healthUrl), { method: 'POST', headers: { 'Content-Type': 'application/json', ...protocolHeaders }, body: '{}' });
    if (!activated.ok) throw new Error(await activated.text());
    const snapshot = await (await fetch(new URL(`/api/conversations/${conversationId}/snapshot`, healthUrl))).json();
    if (!snapshot.runtime?.id || snapshot.runtime.id === conversationId) throw new Error('Desktop did not separate durable and live identities');
    const closed = await fetch(new URL(`/api/conversations/${conversationId}/close`, healthUrl), { method: 'POST', headers: { 'Content-Type': 'application/json', ...protocolHeaders }, body: JSON.stringify({ stopCurrent: true }) });
    if (!closed.ok) throw new Error(await closed.text());
    await window.getByLabel('消息输入').waitFor();
    if (urls.some((value) => /^\/api\/(live-sessions|sessions|session-history|file|files)(?:\/|$)/.test(new URL(value).pathname))) throw new Error('Desktop requested an old business endpoint');
    fs.mkdirSync('.plans/workspace-conversations', { recursive: true });
    fs.writeFileSync('.plans/workspace-conversations/desktop-network.json', JSON.stringify({ oldBusinessRequests: 0, requests: urls.map((value) => new URL(value).pathname) }, null, 2));
    console.log('[desktop-smoke] durable create/reload, explicit real Pi activation/close and new-endpoint trace passed');
    fs.writeFileSync(path.join(snapshot.runtime.cwd, 'canvas-smoke.pdf'), Buffer.from(inlinePdf));
    const dock = window.getByTestId('workspace-dock');
    if (!await dock.isVisible()) await window.getByRole('button', { name: '打开或关闭文件栏', exact: true }).click();
    await dock.getByRole('button', { name: '刷新文件', exact: true }).click();
    await dock.getByRole('button', { name: /canvas-smoke.pdf/ }).click();
    const pdfView = window.locator('.canvas-panel:not([hidden]) .document-pdf');
    await pdfView.getByLabel('PDF 页码', { exact: true }).fill('3');
    await pdfView.locator('.page[data-page-number="3"] .textLayer').getByText('CANVAS PDF PAGE 3', { exact: true }).waitFor();
    await window.waitForFunction(() => {
      const canvas = document.querySelector('.canvas-panel:not([hidden]) .page[data-page-number="3"] canvas');
      return canvas && canvas.width > 0 && canvas.height > 0;
    });
    if (await pdfView.locator('iframe, object, embed').count()) throw new Error('PDF preview uses a browser plugin');
    const documentValidationDir = path.resolve('.plans/canvas-document-viewer/validation');
    fs.mkdirSync(documentValidationDir, { recursive: true });
    await pdfView.screenshot({ path: path.join(documentValidationDir, 'electron-pdf-page-3.png') });
    console.log('[desktop-smoke] integrated PDF worker, rendered page, selectable text and page navigation passed');
  }
  if (!fs.existsSync(path.join(dataRoot, 'scenario')) || !fs.existsSync(path.join(dataRoot, 'sessions')) || !fs.existsSync(path.join(dataRoot, 'modules'))) throw new Error(`TransportX data directories were not created under ${dataRoot}`);
  await app.close();
  let stopped = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await fetch(healthUrl); } catch { stopped = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!stopped) throw new Error('Agent Host remained reachable after Electron exit');
  if (fs.existsSync(path.join(dataRoot, 'host.transportx-lock'))) throw new Error('Host lease remained after normal desktop exit');
  console.log(`Desktop smoke passed: ${title} (${brand.replace(/\s+/g, ' ').trim()})`);
} finally {
  try { await app.close(); } catch {}
  fs.rmSync(temporaryHome, { recursive: true, force: true });
}
