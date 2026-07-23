#!/usr/bin/env node
// Phase 6 React adapter smoke: real Node server + fake Pi, covering Shell,
// Conversation, feature hydration, Task Board, lazy Geo Runtime, dialogs and responsive drawers.
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
    if (child.exitCode !== null) throw new Error(`Tau fake harness exited (${child.exitCode}).\n${diagnostics()}`);
    const match = diagnostics().match(/TAU_FAKE_READY (\{[^\n]+\})/);
    if (match) return JSON.parse(match[1]);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Tau fake harness timed out.\n${diagnostics()}`);
}

const port = await freePort();
let serverOutput = '';
const child = spawn(process.execPath, ['scripts/harness/serve-with-fake-pi.mjs', '--port', String(port)], {
  cwd: process.cwd(),
  env: { ...process.env, TAU_REACT_STATIC_DIR: path.resolve('dist/web') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => { serverOutput += chunk; });
child.stderr.on('data', (chunk) => { serverOutput += chunk; });

let browser;
try {
  const ready = await waitForReady(child, () => serverOutput);
  const baseUrl = ready.baseUrl;
  browser = await chromium.launch({ channel: process.env.TAU_BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  const reactPage = await context.newPage();
  const reactErrors = [];
  const requestedUrls = [];
  reactPage.on('pageerror', (error) => reactErrors.push(error.message));
  reactPage.on('request', (request) => requestedUrls.push(request.url()));
  await reactPage.goto(baseUrl, { waitUntil: 'networkidle' });
  await reactPage.locator('[data-testid="react-shell"]').waitFor({ timeout: 10_000 });
  await reactPage.locator('[data-testid="agent-status"][data-state="connected"]').waitFor({ timeout: 10_000 });
  await reactPage.getByRole('heading', { name: /从一个清晰的/ }).waitFor();

  // Settings: focus enters the dialog, theme applies, Esc closes and restores focus.
  const settingsButton = reactPage.getByRole('button', { name: '打开设置' });
  await settingsButton.click();
  await reactPage.getByRole('dialog', { name: '设置' }).waitFor();
  const focusInSettings = await reactPage.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null);
  if (!focusInSettings) throw new Error('Settings dialog did not capture focus');
  await reactPage.locator('[role="radio"][aria-checked="false"]').first().click();
  const selectedTheme = await reactPage.evaluate(() => document.documentElement.dataset.theme);
  await reactPage.keyboard.press('Escape');
  await reactPage.getByRole('dialog', { name: '设置' }).waitFor({ state: 'hidden' });
  if (!await settingsButton.evaluate((node) => node === document.activeElement)) throw new Error('Settings dialog did not restore trigger focus');

  // Command palette keyboard path.
  await reactPage.keyboard.press('Control+k');
  await reactPage.getByRole('dialog', { name: '命令' }).waitFor();
  await reactPage.getByRole('option', { name: /工作台设置/ }).waitFor();
  await reactPage.keyboard.press('Escape');

  async function createTask(name) {
    await reactPage.getByRole('button', { name: '新建交通任务' }).first().click();
    const dialog = reactPage.getByRole('dialog', { name: '新建交通任务' });
    await dialog.getByLabel('任务名称').fill(name);
    await dialog.getByRole('button', { name: '创建任务' }).click();
    await reactPage.locator('.live-tab.is-active .live-tab-select', { hasText: name }).waitFor({ timeout: 10_000 });
  }

  await createTask('React 阶段四任务 A');
  await reactPage.getByRole('button', { name: '新建交通任务' }).last().click();
  const secondDialog = reactPage.getByRole('dialog', { name: '新建交通任务' });
  await secondDialog.getByLabel('任务名称').fill('React 阶段四任务 B');
  await secondDialog.getByRole('button', { name: '创建任务' }).click();
  await reactPage.locator('.live-tab.is-active .live-tab-select', { hasText: 'React 阶段四任务 B' }).waitFor({ timeout: 10_000 });
  await reactPage.locator('.live-tab-select', { hasText: 'React 阶段四任务 A' }).click();
  await reactPage.locator('.live-tab.is-active .live-tab-select', { hasText: 'React 阶段四任务 A' }).waitFor();

  // Conversation: React composer sends through the command port; optimistic
  // user message and streaming/final assistant rendering share the Kernel.
  const composer = reactPage.getByLabel('消息输入');
  await composer.fill('基线-happy');
  await composer.press('Enter');
  await reactPage.locator('.user-message', { hasText: '基线-happy' }).waitFor();
  await reactPage.locator('.assistant-message', { hasText: '上海早高峰分析结果' }).waitFor({ timeout: 10_000 });
  const thinkingToggle = reactPage.locator('.thinking-toggle', { hasText: '思考过程' });
  await thinkingToggle.waitFor();
  if (await thinkingToggle.getAttribute('aria-expanded') !== 'true') throw new Error('Thinking block should be expanded by default');
  const thinkingChrome = await reactPage.locator('.thinking-block pre').evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, border: style.borderTopStyle };
  });
  if (thinkingChrome.background !== 'rgba(0, 0, 0, 0)' || thinkingChrome.border !== 'none') {
    throw new Error(`Thinking block should use plain gray text: ${JSON.stringify(thinkingChrome)}`);
  }

  // Trigger real extension_ui_request variants through fake Pi and answer them in React.
  async function triggerPrompt(message) {
    await reactPage.evaluate(async ({ taskName, prompt }) => {
      const sessions = await (await fetch('/api/live-sessions')).json();
      const session = sessions.sessions.find((item) => item.sessionName === taskName);
      await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'prompt', sessionId: session.id, message: prompt }),
      });
    }, { taskName: 'React 阶段四任务 A', prompt: message });
  }

  await triggerPrompt('基线-task');
  const selectDialog = reactPage.getByRole('dialog', { name: '选择分析范围' });
  await selectDialog.waitFor({ timeout: 10_000 });
  await selectDialog.getByRole('button', { name: /只看工作日/ }).click();
  await selectDialog.waitFor({ state: 'hidden' });
  await reactPage.locator('.tool-card', { hasText: '任务状态' }).waitFor({ timeout: 10_000 });
  await reactPage.locator('[data-testid="agent-status"][data-state="connected"]').waitFor();

  // Feature UI: task and map have their own floating views; files remain the
  // only right dock resource.
  await reactPage.getByRole('button', { name: '打开或关闭文件栏' }).click();
  await reactPage.locator('[data-testid="workspace-dock"].is-open').waitFor();
  await reactPage.locator('.workspace-file-list').waitFor();
  await reactPage.getByTestId('workspace-dock').getByRole('button', { name: '关闭文件栏', exact: true }).click();
  await reactPage.locator('[data-testid="workspace-dock"]:not(.is-open)').waitFor();
  await reactPage.getByRole('button', { name: '打开或关闭任务面板' }).click();
  await reactPage.locator('[data-testid="workspace-float-tasks"].is-open').waitFor();
  await reactPage.locator('.task-board-card', { hasText: '分析上海体育馆早高峰下车热点' }).waitFor();
  if (requestedUrls.some((url) => url.includes('geo-runtime-entry') || url.includes('maplibre'))) {
    throw new Error('Task feature loaded the Geo Runtime before the Geo workspace was activated');
  }

  await triggerPrompt('基线-geo');
  await reactPage.locator('.assistant-message', { hasText: '地图已发布，可在右侧地图面板查看。' }).waitFor({ timeout: 10_000 });
  const conversationTimeline = await reactPage.evaluate(() => Array.from(document.querySelectorAll('.conversation-thread > *')).map((node) => (node.textContent || '').trim()));
  const geoIntroIndex = conversationTimeline.findLastIndex((text) => text.includes('正在生成下车热点地图。'));
  const geoToolIndex = conversationTimeline.findLastIndex((text) => text.includes('present_visualization'));
  const geoFinalIndex = conversationTimeline.findLastIndex((text) => text.includes('地图已发布，可在右侧地图面板查看。'));
  if (!(geoIntroIndex < geoToolIndex && geoToolIndex < geoFinalIndex)) {
    throw new Error(`Tool card left its conversation turn: ${JSON.stringify(conversationTimeline.slice(-8))}`);
  }
  const emptyAssistantMessages = await reactPage.evaluate(() => Array.from(document.querySelectorAll('.assistant-message')).filter((node) => !(node.textContent || '').trim()).length);
  if (emptyAssistantMessages) throw new Error(`React rendered ${emptyAssistantMessages} empty assistant messages`);
  const responseProtocolErrors = await reactPage.locator('.runtime-notice', { hasText: 'Unknown RPC event type "response"' }).count();
  if (responseProtocolErrors) throw new Error('RPC response acknowledgement surfaced as a protocol error');
  const settledProtocolErrors = await reactPage.locator('.runtime-notice', { hasText: 'Unknown RPC event type "agent_settled"' }).count();
  if (settledProtocolErrors) throw new Error('agent_settled surfaced as a protocol error');
  await reactPage.locator('[data-testid="workspace-float-map"].is-open').waitFor({ timeout: 10_000 });
  await reactPage.locator('.geo-map').waitFor({ timeout: 10_000 });
  await reactPage.locator('.geo-layers', { hasText: '下车点' }).waitFor({ timeout: 10_000 });
  if (!requestedUrls.some((url) => url.includes('geo-runtime-entry') || url.includes('maplibre'))) {
    throw new Error('Geo workspace did not load its runtime on demand');
  }
  await reactPage.getByTestId('workspace-float-map')
    .getByRole('button', { name: '关闭地图视图', exact: true }).click();

  await triggerPrompt('React-dialog-confirm');
  const confirmDialog = reactPage.getByRole('dialog', { name: '确认发布报告' });
  await confirmDialog.waitFor();
  await confirmDialog.getByRole('button', { name: '是' }).click();
  await confirmDialog.waitFor({ state: 'hidden' });
  await reactPage.locator('[data-testid="agent-status"][data-state="connected"]').waitFor();

  await triggerPrompt('React-dialog-input');
  const inputDialog = reactPage.getByRole('dialog', { name: '输入路段名称' });
  await inputDialog.locator('input.extension-input').fill('漕溪北路');
  await inputDialog.getByRole('button', { name: '提交回答' }).click();
  await inputDialog.waitFor({ state: 'hidden' });
  await reactPage.locator('[data-testid="agent-status"][data-state="connected"]').waitFor();

  await triggerPrompt('React-dialog-editor');
  const editorDialog = reactPage.getByRole('dialog', { name: '补充分析约束' });
  await editorDialog.locator('textarea').fill('工作日 7:30—9:30');
  await editorDialog.getByRole('button', { name: '提交回答' }).click();
  await editorDialog.waitFor({ state: 'hidden' });
  await reactPage.locator('[data-testid="agent-status"][data-state="connected"]').waitFor();

  await triggerPrompt('React-dialog-notify');
  await reactPage.getByRole('status').filter({ hasText: '交通报告已经生成' }).waitFor();

  // Mobile drawers and Escape behavior.
  await reactPage.setViewportSize({ width: 390, height: 844 });
  await reactPage.keyboard.press('Escape');
  await reactPage.locator('[data-testid="session-sidebar"]:not(.is-open)').waitFor();
  await reactPage.getByRole('button', { name: '展开或收起会话侧栏' }).click();
  await reactPage.locator('[data-testid="session-sidebar"].is-open').waitFor();
  await reactPage.keyboard.press('Escape');
  await reactPage.locator('[data-testid="session-sidebar"]:not(.is-open)').waitFor();
  await reactPage.getByRole('button', { name: '打开或关闭文件栏' }).click();
  await reactPage.locator('[data-testid="workspace-dock"].is-open').waitFor();
  await reactPage.keyboard.press('Escape');
  await reactPage.locator('[data-testid="workspace-dock"]:not(.is-open)').waitFor();

  if (reactErrors.length) throw new Error(`React page errors:\n${reactErrors.join('\n')}`);

  console.log(`React phase 7 smoke passed: ${baseUrl}/ (theme=${selectedTheme}, sessions=2, conversation, task, geo, extension-ui=5-kinds, mobile=ok)`);
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 4_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
