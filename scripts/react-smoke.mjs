#!/usr/bin/env node
import net from 'node:net';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

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
const pageErrors = [];
try {
  const { baseUrl } = await waitForReady(child, () => output);
  browser = await chromium.launch({ channel: process.env.TAU_BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="agent-status"]:is([data-state="connected"], [data-state="streaming"])').waitFor();

  await page.getByRole('button', { name: '新建交通任务' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建交通任务' });
  await dialog.locator('.menu-select-trigger', { hasText: 'kimi-coding/k2p7' }).waitFor();
  await dialog.getByRole('button', { name: '创建任务' }).click();

  const composer = page.getByLabel('消息输入');
  await composer.waitFor();
  await composer.fill('基线-happy-collapsed');
  await composer.press('Enter');
  await page.locator('.assistant-message', { hasText: '上海早高峰分析结果' }).waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor({ timeout: 10_000 });

  await composer.fill('基线-geo');
  await composer.press('Enter');
  await page.locator('.assistant-message', { hasText: '地图已发布，可在右侧地图面板查看。' }).waitFor({ timeout: 10_000 });

  const resourceLoaded = page.waitForResponse((response) => response.url().includes('/geo-resources/geo_111111111111111111111111/data'));
  await composer.fill('geo-main-start');
  await composer.press('Enter');
  await page.locator('.assistant-message', { hasText: '请选择两条道路' }).waitFor({ timeout: 10_000 });
  await page.getByLabel('选择地图').selectOption('geo_interaction_map');
  const geoMap = page.locator('.geo-map');
  await geoMap.waitFor({ timeout: 10_000 });
  assert.equal((await resourceLoaded).ok(), true);
  await page.waitForTimeout(250);
  const modeSwitch = page.getByLabel('切换模式');
  assert.equal(await modeSwitch.inputValue(), 'browse');
  const mapBox = await geoMap.boundingBox();
  if (!mapBox) throw new Error('Geo map has no browser layout box');
  const screenshotRequest = page.waitForRequest((request) => request.url().includes('/geo-screenshots'));
  await page.getByRole('button', { name: '保存截图', exact: true }).click();
  const screenshotDataUrl = (await screenshotRequest).postDataJSON().dataUrl;
  const screenshotSize = await page.evaluate((dataUrl) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('Saved Geo screenshot is not a readable image'));
    image.src = dataUrl;
  }), screenshotDataUrl);
  assert.ok(screenshotSize.height > mapBox.height + 40, 'Geo screenshot should include the legend and description below the map');
  const screenshotNotice = page.locator('.geo-notice');
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
  await modeSwitch.selectOption('feature');
  const tray = page.locator('.geo-context-tray');
  let selectedFeatures = 0;
  for (let fraction = 0.05; fraction <= 0.95 && selectedFeatures < 2; fraction += 0.01) {
    await page.mouse.click(mapBox.x + mapBox.width * fraction, mapBox.y + mapBox.height * 0.5);
    await page.waitForTimeout(20);
    const match = await tray.count() ? (await tray.textContent())?.match(/(\d+) features/) : null;
    const nextCount = Number(match?.[1] || 0);
    if (nextCount > selectedFeatures) { selectedFeatures = nextCount; fraction += 0.06; }
  }
  await tray.getByText('2 features').waitFor({ timeout: 10_000 });
  await tray.getByRole('button', { name: '附到对话' }).click();
  await page.locator('.composer-geo-contexts').waitFor();

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
  const updatedOption = page.getByRole('option', { name: 'Geo 双向交互分析结果' });
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
  const inspected = JSON.parse(JSON.parse(audit.inspectText).content[0].text);
  assert.equal(inspected.contexts[0].features.length, 2);
  assert.doesNotMatch(audit.inspectText, /not-exposed/);
  assert.equal(audit.contextOk, true);
  assert.equal(audit.context.context.sceneRevision, 1);
  console.log('Geo smoke: stored Context and inspect output audited.');

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

  if (pageErrors.length) throw new Error(`Web scenario raised page errors: ${pageErrors.join('\n')}`);
  console.log('Web scenario passed: baseline workflow plus Geo user Context, Agent request, audited result, and refresh recovery.');
} catch (error) {
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
