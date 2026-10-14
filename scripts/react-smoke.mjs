#!/usr/bin/env node
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documentSmoke } from './harness/document-smoke.mjs';
import { feedbackSmoke, composerSmoke, conversationStyleSmoke } from './harness/feedback-smoke.mjs';
import { softwareUpdateSmoke } from './harness/software-update-smoke.mjs';
import { localModelSmoke } from './harness/local-model-smoke.mjs';
import { workspaceCleanupSmoke } from './harness/workspace-cleanup-smoke.mjs';
import { conversationLayoutSmoke, toolStateSmoke, streamingScrollSmoke, workingDisplaySmoke } from './harness/conversation-layout-smoke.mjs';
import { prepareComposerContextSmoke, composerSelectionSmoke } from './harness/composer-selection-smoke.mjs';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForReady(child, diagnostics) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Fake Pi server exited (${child.exitCode}).\n${diagnostics()}`);
    const match = diagnostics().match(/TAU_FAKE_READY (\{[^\n]+\})/);
    if (match) return JSON.parse(match[1]);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Fake Pi server timed out.\n${diagnostics()}`);
}

const port = await freePort();
let output = '';
const child = spawn(process.execPath, ['scripts/harness/serve-with-fake-pi.mjs', '--port', String(port)], {
  cwd: process.cwd(),
  env: { ...process.env, TAU_REACT_STATIC_DIR: 'dist/web' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

let browser;
let page;
const pageErrors = [];
const requestedUrls = [];
try {
  const { baseUrl, longHistoryFile, longHistoryCwd } = await waitForReady(child, () => output);
  browser = await chromium.launch({ channel: process.env.TAU_BROWSER_CHANNEL || 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => requestedUrls.push(request.url()));
  await page.addInitScript(() => { if (window === window.top) localStorage.setItem('tau-show-thinking', 'true'); });

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="agent-status"]:is([data-state="connected"], [data-state="streaming"])').waitFor();

  await page.getByRole('button', { name: '新建交通任务' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建交通任务' });
  await dialog.locator('.menu-select-trigger', { hasText: 'kimi-coding/k2p7' }).waitFor();
  await dialog.getByRole('button', { name: '创建任务' }).click();

  const composer = page.getByLabel('消息输入');
  await composer.waitFor();
  await localModelSmoke(page, baseUrl);
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const executionDetails = page.getByRole('switch', { name: '显示执行详情', exact: true });
  assert.equal(await executionDetails.getAttribute('aria-checked'), 'false', 'execution details default to Working even with the legacy auto-enabled preference');
  assert.equal(await page.getByRole('switch', { name: '默认展开思考内容' }).getAttribute('aria-checked'), 'false');
  await executionDetails.click();
  await page.keyboard.press('Escape');
  await page.reload();
  await composer.waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('tau-show-execution-details')), 'true', 'explicit display choices survive reload');
  await feedbackSmoke(page, baseUrl, longHistoryFile, longHistoryCwd);
  await composerSmoke(page, baseUrl);
  await composer.fill('资源-svg-policy');
  await composer.press('Enter');
  await page.locator('.assistant-message', { hasText: 'SVG 策略测试文件已生成' }).waitFor();
  const svgSessionId = await page.evaluate(() => localStorage.getItem('tau-active-live-session-id'));
  for (const route of ['preview', 'raw']) {
    const svgPage = await browser.newPage();
    const requests = [];
    svgPage.on('request', (request) => requests.push(request.url()));
    const response = await svgPage.goto(`${baseUrl}/api/file/${route}?sessionId=${svgSessionId}&path=active.svg`);
    assert.match(response.headers()['content-security-policy'], /sandbox/);
    assert.equal(await svgPage.evaluate(() => globalThis.svgExecuted === true), false);
    assert.equal(requests.some((url) => url.includes('svg-executed=1')), false);
    await svgPage.close();
  }
  console.log('Resource smoke: direct SVG preview/raw navigation cannot execute scripts.');
  await documentSmoke(page, browser);
  await conversationStyleSmoke(page);
  await toolStateSmoke(page, baseUrl);
  if (process.env.TAU_STYLE_STAGE !== 'tools') await conversationLayoutSmoke(page);
  await streamingScrollSmoke(page);
  await workingDisplaySmoke(page);
  assert.equal(requestedUrls.some((url) => /(?:docx|xlsx|pptx)_parser_bg|render-worker/.test(url)), false, 'non-Office workflows do not load OOXML WASM or workers');
  await composer.fill('实时-markdown');
  await composer.press('Enter');
  const liveMarkdown = page.locator('.assistant-message.is-streaming');
  await liveMarkdown.locator('h2', { hasText: '实时报告' }).waitFor({ timeout: 5_000 });
  const steer = page.getByRole('button', { name: '发送引导', exact: true });
  assert.equal(await steer.isDisabled(), true, 'empty guidance cannot be sent');
  assert.equal(await page.getByRole('button', { name: '终止当前任务', exact: true }).isEnabled(), true, 'stopping remains available');
  const steeringCommands = [];
  const rejectSteer = async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== 'steer') return route.continue();
    steeringCommands.push(command);
    await route.fulfill({ json: { success: false, error: 'steer boundary smoke' } });
  };
  await page.route('**/api/rpc', rejectSteer);
  await composer.fill('补充中文条件');
  await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  await page.waitForTimeout(50);
  assert.equal(steeringCommands.length, 0, 'composition does not send guidance');
  await steer.click();
  await page.locator('.composer-error', { hasText: 'steer boundary smoke' }).waitFor();
  assert.equal(steeringCommands.length, 1, 'valid guidance can be sent');
  assert.equal(await composer.inputValue(), '补充中文条件', 'rejected guidance preserves the draft');
  await composer.fill('');
  await page.unroute('**/api/rpc', rejectSteer);
  await liveMarkdown.locator('li', { hasText: '已完成第一项' }).waitFor({ timeout: 5_000 });
  await page.locator('.assistant-message:not(.is-streaming)', { hasText: 'Markdown 应在回复结束前完成渲染。' }).waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor({ timeout: 10_000 });

  await composer.fill('基线-happy-collapsed');
  await composer.press('Enter');
  await page.locator('.assistant-message', { hasText: '上海早高峰分析结果' }).waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor({ timeout: 10_000 });

  await composer.fill('基线-task');
  await composer.press('Enter');
  const askUserDialog = page.getByRole('dialog', { name: '选择分析范围' });
  await askUserDialog.getByRole('button', { name: '只看工作日' }).waitFor({ timeout: 10_000 });
  const customAnswer = askUserDialog.getByLabel('输入其他答案');
  await customAnswer.fill('仅分析节假日');
  await customAnswer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await customAnswer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  assert.equal(await askUserDialog.isVisible(), true, 'composition does not submit a custom answer');
  await customAnswer.press('Enter');
  await page.locator('.assistant-message', { hasText: '任务面板已更新，继续执行查询步骤。' }).waitFor({ timeout: 10_000 });
  assert.match(output, /ui ui_scope responded: .*"value":"仅分析节假日"/);

  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  await composer.fill('React-dialog-input'); await composer.press('Enter');
  const inputDialog = page.getByRole('dialog', { name: '输入路段名称', exact: true });
  const roadInput = inputDialog.getByRole('textbox');
  await roadInput.fill('漕溪北路');
  await roadInput.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await roadInput.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  await page.waitForTimeout(100);
  assert.equal(await inputDialog.isVisible(), true, 'composition does not resolve an input dialog');
  await roadInput.press('Enter');
  await page.locator('.assistant-message', { hasText: '已收到路段名称。' }).waitFor();
  assert.match(output, /ui ui_react_input responded: .*"value":"漕溪北路"/);

  await prepareComposerContextSmoke(page);
  await composer.fill('基线-geo');
  await composer.press('Enter');
  await page.locator('.assistant-message', { hasText: '地图已发布，可在右侧地图面板查看。' }).waitFor({ timeout: 10_000 });

  let releaseMapResource;
  const heldMapResource = new Promise((resolve) => { releaseMapResource = resolve; });
  let mapResourceStarted;
  const mapResourceArrived = new Promise((resolve) => { mapResourceStarted = resolve; });
  const resourcePattern = '**/geo-resources/geo_111111111111111111111111/data*';
  const holdMapResource = async (route) => { mapResourceStarted(); await heldMapResource; await route.continue(); };
  await page.route(resourcePattern, holdMapResource);
  const resourceLoaded = page.waitForResponse((response) => response.url().includes('/geo-resources/geo_111111111111111111111111/data'));
  await composer.fill('geo-main-start');
  await composer.press('Enter');
  await page.locator('.assistant-message', { hasText: '请选择两条道路' }).waitFor({ timeout: 10_000 });
  await page.locator('[role=tab][aria-selected=true]', { hasText: '交互' }).waitFor();
  assert.equal(await page.getByLabel('选择地图', { exact: true }).count(), 0);
  assert.equal(await page.locator('[data-testid=agent-canvas] [role=tab]').count(), 2);
  const geoMap = page.locator('.canvas-panel:not([hidden]) .geo-map');
  await geoMap.waitFor({ timeout: 10_000 });
  await mapResourceArrived;
  const modeSwitch = page.locator('.canvas-panel:not([hidden])').getByLabel('切换模式');
  assert.equal(await modeSwitch.inputValue(), 'browse');
  const mapBox = await geoMap.boundingBox();
  if (!mapBox) throw new Error('Geo map has no browser layout box');
  const screenshotRequest = page.waitForRequest((request) => request.url().includes('/geo-screenshots'));
  let screenshotPosted = false;
  const observeScreenshot = (request) => { if (request.url().includes('/geo-screenshots')) screenshotPosted = true; };
  page.on('request', observeScreenshot);
  await page.getByRole('button', { name: '保存截图', exact: true }).click();
  await page.waitForTimeout(150);
  assert.equal(screenshotPosted, false, 'a screenshot must not be saved while its GeoJSON source is still loading');
  releaseMapResource();
  assert.equal((await resourceLoaded).ok(), true);
  const screenshotDataUrl = (await screenshotRequest).postDataJSON().dataUrl;
  page.off('request', observeScreenshot);
  await page.unroute(resourcePattern, holdMapResource);
  const screenshotSize = await page.evaluate((dataUrl) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      // Inspect the map area itself so legend/description pixels cannot hide a blank map.
      const pixels = context.getImageData(0, 0, canvas.width, Math.floor(canvas.height * 0.7)).data;
      let nonBackground = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] && Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) - Math.min(pixels[index], pixels[index + 1], pixels[index + 2]) > 30) nonBackground++;
      }
      resolve({ width: image.naturalWidth, height: image.naturalHeight, nonBackground });
    };
    image.onerror = () => reject(new Error('Saved Geo screenshot is not a readable image'));
    image.src = dataUrl;
  }), screenshotDataUrl);
  assert.ok(screenshotSize.height > mapBox.height + 40, 'Geo screenshot should include the legend and description below the map');
  assert.ok(screenshotSize.nonBackground > 100, 'Geo screenshot contains rendered colored road features, not just a PNG header or legend');
  const screenshotNotice = page.locator('.canvas-panel:not([hidden]) .geo-notice');
  await screenshotNotice.waitFor({ timeout: 10_000 });
  const screenshotFilename = (await screenshotNotice.textContent())?.match(/map-screenshot-[\d-]+\.png/)?.[0];
  assert.ok(screenshotFilename);
  const screenshotSaved = await page.evaluate(async (filename) => {
    const sessions = await (await fetch('/api/live-sessions')).json();
    const files = await (await fetch(`/api/files?sessionId=${encodeURIComponent(sessions.sessions[0].id)}`)).json();
    return files.items.some((item) => item.name === filename && item.size > 0);
  }, screenshotFilename);
  assert.equal(screenshotSaved, true);
  console.log('Geo smoke: map, layer legend and description saved in the task directory.');

  await composer.fill('geo-agent-screenshot');
  await composer.press('Enter');
  await page.locator('.assistant-message', { hasText: '地图截图已自动保存，可插入报告。' }).waitFor({ timeout: 10_000 });
  const agentScreenshotSaved = await page.evaluate(async () => {
    const sessions = await (await fetch('/api/live-sessions')).json();
    const files = await (await fetch(`/api/files?sessionId=${encodeURIComponent(sessions.sessions[0].id)}`)).json();
    return files.items.filter((item) => /^map-screenshot-[\d-]+\.png$/.test(item.name) && item.size > 0).length >= 2;
  });
  assert.equal(agentScreenshotSaved, true);
  console.log('Geo smoke: Agent-requested screenshot captured by the workbench and saved automatically.');

  await page.getByRole('tab', { name: 'Geo 交互验收地图', exact: true }).click();
  await modeSwitch.selectOption('feature');
  const tray = page.locator('.canvas-panel:not([hidden]) .geo-context-tray');
  let selectedFeatures = 0;
  for (let fraction = 0.05; fraction <= 0.95 && selectedFeatures < 2; fraction += 0.01) {
    const selectionBox = await geoMap.boundingBox();
    if (!selectionBox) throw new Error('Geo selection map has no browser layout box');
    await page.mouse.click(selectionBox.x + selectionBox.width * fraction, selectionBox.y + selectionBox.height * 0.5);
    await page.waitForTimeout(20);
    const match = await tray.count() ? (await tray.textContent())?.match(/(\d+) features/) : null;
    const nextCount = Number(match?.[1] || 0);
    if (nextCount > selectedFeatures) { selectedFeatures = nextCount; fraction += 0.06; }
  }
  await tray.getByText('2 features').waitFor({ timeout: 10_000 });
  await tray.getByRole('button', { name: '附到对话' }).click();
  await page.locator('.composer-geo-contexts').waitFor();
  await composer.fill('');
  assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isEnabled(), true, 'map context alone is deliverable');
  await composerSelectionSmoke(page);
  const activeMapNode = await geoMap.elementHandle();
  await page.getByRole('tab', { name: '下车热点热力图', exact: true }).click();
  await page.getByRole('tab', { name: 'Geo 交互验收地图', exact: true }).click();
  assert.equal(await geoMap.evaluate((node, previous) => node === previous, activeMapNode), true, 'tab switching preserves the map instance');
  await page.getByRole('button', { name: '关闭视图：下车热点热力图', exact: true }).click();
  await page.getByLabel('重新打开成果').selectOption('geo:dropoff_heatmap');
  await page.getByRole('tab', { name: 'Geo 交互验收地图', exact: true }).click();


  await composer.fill('geo-main-context');
  await composer.press('Enter');
  const requestBanner = page.locator('.geo-request-banner', { hasText: '请框选补充分析范围' });
  await requestBanner.waitFor({ timeout: 10_000 });
  const requestMapBox = await geoMap.boundingBox();
  if (!requestMapBox) throw new Error('Geo request map has no browser layout box');
  await page.mouse.move(requestMapBox.x + requestMapBox.width * 0.35, requestMapBox.y + requestMapBox.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(requestMapBox.x + requestMapBox.width * 0.65, requestMapBox.y + requestMapBox.height * 0.65, { steps: 6 });
  await page.mouse.up();
  await requestBanner.getByRole('button', { name: '提交' }).click();
  await page.locator('.assistant-message', { hasText: '已读取两个稳定道路要素' }).waitFor({ timeout: 10_000 });
  console.log('Geo smoke: bidirectional request completed.');
  const updatedOption = page.getByRole('tab', { name: 'Geo 双向交互分析结果', exact: true });
  await updatedOption.waitFor({ state: 'attached', timeout: 10_000 });
  assert.equal(await updatedOption.textContent(), 'Geo 双向交互分析结果');

  const audit = await page.evaluate(async () => {
    const sessions = await (await fetch('/api/live-sessions')).json();
    const sessionId = sessions.sessions[0].id;
    const snapshot = await (await fetch(`/api/live-sessions/${encodeURIComponent(sessionId)}/snapshot`)).json();
    const user = snapshot.entries.map((entry) => entry.message).find((message) => message?.role === 'user' && JSON.stringify(message.content).includes('geo-main-context'));
    const inspect = snapshot.entries.map((entry) => entry.message).find((message) => message?.role === 'toolResult' && message.toolName === 'inspect_map_context');
    const contextId = user?.geoContextIds?.[0];
    const contextResponse = contextId ? await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/geo-contexts/${encodeURIComponent(contextId)}`) : null;
    return { contextIds: user?.geoContextIds, inspectText: JSON.stringify(inspect), contextOk: contextResponse?.ok, context: contextResponse?.ok ? await contextResponse.json() : null };
  });
  assert.equal(audit.contextIds?.length, 1);
  const delivered = await page.evaluate(async () => {
    const sessions = await (await fetch('/api/live-sessions')).json();
    const snapshot = await (await fetch(`/api/live-sessions/${sessions.sessions[0].id}/snapshot`)).json();
    return snapshot.entries.map((entry) => entry.message).find((message) => message?.role === 'user' && JSON.stringify(message.content).includes('geo-main-context'));
  });
  assert.equal(delivered.attachmentIds.length, 5);
  assert.equal(delivered.canvasContextIds.length, 1);
  assert.equal(await page.locator('.composer-selection').count(), 0, 'successful delivery clears only the submitted selections');
  const inspected = JSON.parse(JSON.parse(audit.inspectText).content[0].text);
  assert.equal(inspected.contexts[0].features.length, 2);
  assert.doesNotMatch(audit.inspectText, /not-exposed/);
  assert.equal(audit.contextOk, true);
  assert.equal(audit.context.context.sceneRevision, 1);
  console.log('Geo smoke: stored Context and inspect output audited.');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  const restoredInput = page.locator('.user-message', { hasText: 'geo-main-context' });
  assert.equal(await restoredInput.count(), 1, 'mixed input has one restored user message');
  assert.doesNotMatch(await restoredInput.innerText(), /transportx-attachment-context|本轮用户消息包含/);
  const restoredDelivery = await page.evaluate(async () => {
    const sessionId = localStorage.getItem('tau-active-live-session-id');
    const snapshot = await (await fetch(`/api/live-sessions/${sessionId}/snapshot`)).json();
    return snapshot.entries.map((entry) => entry.message).find((message) => message?.role === 'user' && JSON.stringify(message.content).includes('geo-main-context'));
  });
  assert.deepEqual(restoredDelivery.attachmentIds, delivered.attachmentIds);
  assert.deepEqual(restoredDelivery.geoContextIds, delivered.geoContextIds);
  assert.deepEqual(restoredDelivery.canvasContextIds, delivered.canvasContextIds);
  fs.writeFileSync('.plans/style-upgrade-phase-three/validation/delivery.json', JSON.stringify({ attachments: delivered.attachmentIds.length, geoContexts: delivered.geoContextIds.length, canvasContexts: delivered.canvasContextIds.length, restored: true }, null, 2));
  console.log('Mixed delivery smoke: attachment, Geo and Canvas references survive reload without internal prompt text or duplicate user messages.');

  // Generate a small local video in the browser so the UI test needs no external video assets.
  console.log('Canvas smoke: generating test video.');
  const videoBytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    const context = canvas.getContext('2d');
    const stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const finished = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start();
    for (let frame = 0; frame < 12; frame++) {
      context.fillStyle = frame % 2 ? '#687b77' : '#485a65';
      context.fillRect(0, 0, 320, 180);
      await new Promise((resolve) => setTimeout(resolve, 85));
    }
    recorder.stop(); await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error('Test video recording timed out')), 5000))]);
    stream.getTracks().forEach((track) => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  console.log('Canvas smoke: test video ready.', videoBytes.length);
  await page.route('**/video-resources/video_canvas_*/data', (route) => route.fulfill({ contentType: 'video/webm', body: Buffer.from(videoBytes) }));
  await page.route('**/video-resources/video_canvas_*/metrics', (route) => route.fulfill({ json: { metrics: [] } }));
  for (const [prompt, title] of [['canvas-video-first', '东入口录像'], ['canvas-video-second', '西入口录像']]) {
    await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
    console.log('Canvas smoke: presenting', title);
    await composer.fill(prompt); await composer.press('Enter');
    await page.locator('[role=tab][aria-selected=true]', { hasText: title }).waitFor();
  }
  const firstVideo = page.locator('[id="canvas-panel-video:video_canvas_a"] video');
  await page.getByRole('tab', { name: '东入口录像', exact: true }).click();
  await firstVideo.evaluate(async (video) => { video.muted = true; await Promise.race([video.play(), new Promise((_, reject) => setTimeout(() => reject(new Error(`Video play timed out: ${video.readyState}, ${video.networkState}, ${video.error?.message}`)), 5000))]); });
  await page.getByRole('tab', { name: '西入口录像', exact: true }).click();
  assert.equal(await firstVideo.evaluate((video) => video.paused), true, 'background videos pause');
  await page.getByRole('button', { name: '关闭视图：下车热点热力图', exact: true }).click();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  await composer.fill('canvas-show-map'); await composer.press('Enter');
  await page.locator('[role=tab][aria-selected=true]', { hasText: '下车热点热力图' }).waitFor();
  assert.equal(await page.getByRole('tab', { name: '下车热点热力图', exact: true }).count(), 1);
  assert.equal(await page.getByLabel('切换地图面板', { exact: true }).count(), 0);
  await page.waitForTimeout(450);
  if (process.env.TAU_CANVAS_SCREENSHOT) {
    await page.setViewportSize({ width: 1580, height: 1000 });
    await page.getByRole('tab', { name: 'Geo 双向交互分析结果', exact: true }).click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: process.env.TAU_CANVAS_SCREENSHOT });
  }
  console.log('Canvas smoke: named tabs, map preservation, close/reopen, video selection/pause and Agent focus passed.');

  await composer.fill('geo-refresh-request');
  await composer.press('Enter');
  await page.locator('.geo-request-banner', { hasText: '刷新恢复验收' }).waitFor({ timeout: 10_000 });
  console.log('Geo smoke: refresh request is waiting.');
  const requestBeforeReload = await page.evaluate(async () => {
    const sessions = await (await fetch('/api/live-sessions')).json();
    const snapshot = await (await fetch(`/api/live-sessions/${sessions.sessions[0].id}/snapshot`)).json();
    return snapshot.geoInteraction.waitingRequest.requestId;
  });
  await page.reload({ waitUntil: 'networkidle' });
  console.log('Geo smoke: renderer reloaded.');
  await page.waitForTimeout(1_000);
  console.log('Geo smoke: connection state after reload:', await page.locator('[data-testid="agent-status"]').getAttribute('data-state'));
  await page.locator('[data-testid="agent-status"]:is([data-state="connected"], [data-state="streaming"])').waitFor();
  const restoredBanner = page.locator('.geo-request-banner', { hasText: '刷新恢复验收' });
  await restoredBanner.waitFor({ timeout: 10_000 });
  const requestAfterReload = await page.evaluate(async () => {
    const sessions = await (await fetch('/api/live-sessions')).json();
    const snapshot = await (await fetch(`/api/live-sessions/${sessions.sessions[0].id}/snapshot`)).json();
    return snapshot.geoInteraction.waitingRequest.requestId;
  });
  assert.equal(requestAfterReload, requestBeforeReload);
  console.log('Geo smoke: same request restored from snapshot.');
  await restoredBanner.getByRole('button', { name: '取消' }).click();
  await page.locator('.assistant-message', { hasText: '刷新后的地图请求已正确结束' }).waitFor({ timeout: 10_000 });
  console.log('Geo smoke: restored request cancelled.');



  await softwareUpdateSmoke(browser, baseUrl);
  await workspaceCleanupSmoke(page);
  if (pageErrors.length) throw new Error(`Web scenario raised page errors: ${pageErrors.join('\n')}`);
  console.log('Web scenario passed: baseline workflow plus Geo user Context, Agent request, audited result, and refresh recovery.');
} catch (error) {
  fs.mkdirSync('.plans/canvas-document-viewer/validation', { recursive: true });
  if (page && !page.isClosed()) {
    await page.screenshot({ path: '.plans/canvas-document-viewer/validation/web-failure.png' }).catch(() => {});
    fs.writeFileSync('.plans/canvas-document-viewer/validation/web-failure.txt', await page.locator('body').innerText().catch(() => 'Page unavailable'));
  }
  throw new Error(`${error instanceof Error ? error.stack || error.message : String(error)}\n\nPage errors:\n${pageErrors.join('\n')}\n\nFake server output:\n${output}`);
} finally {
  await browser?.close();
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
