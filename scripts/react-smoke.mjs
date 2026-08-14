#!/usr/bin/env node
// Phase 6 React adapter smoke: real Node server + fake Pi, covering Shell,
// Conversation, feature hydration, Task Board, lazy Geo Runtime, dialogs and responsive drawers.
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
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
  await context.addInitScript(() => window.localStorage.setItem('tau-locale', 'zh-CN'));

  const reactPage = await context.newPage();
  const reactErrors = [];
  const requestedUrls = [];
  reactPage.on('pageerror', (error) => reactErrors.push(error.message));
  reactPage.on('request', (request) => requestedUrls.push(request.url()));

  async function measureMotion(triggerSelector, targetSelector, metric, duration) {
    const samples = await reactPage.evaluate(async ({ triggerSelector, targetSelector, metric, duration }) => {
      const trigger = document.querySelector(triggerSelector);
      const target = document.querySelector(targetSelector);
      if (!(trigger instanceof HTMLElement) || !(target instanceof HTMLElement)) {
        throw new Error(`Motion target unavailable: ${triggerSelector} -> ${targetSelector}`);
      }
      const read = () => {
        const rect = target.getBoundingClientRect();
        return metric === 'width' ? rect.width : rect.left;
      };
      const startedAt = performance.now();
      const values = [{ time: 0, value: read() }];
      trigger.click();
      await new Promise((resolve) => {
        const sample = (now) => {
          values.push({ time: now - startedAt, value: read() });
          if (now - startedAt >= duration) resolve();
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      return values;
    }, { triggerSelector, targetSelector, metric, duration });
    return { duration, samples };
  }

  function assertSmoothMotion({ duration, samples }, direction, label) {
    const first = samples[0].value;
    const last = samples.at(-1).value;
    const delta = last - first;
    if ((direction === 'increasing' && delta < 20) || (direction === 'decreasing' && delta > -20)) {
      throw new Error(`${label} did not travel in the expected direction: ${JSON.stringify({ first, last })}`);
    }
    for (let index = 1; index < samples.length; index += 1) {
      const step = samples[index].value - samples[index - 1].value;
      if ((direction === 'increasing' && step < -1) || (direction === 'decreasing' && step > 1)) {
        throw new Error(`${label} reversed direction during its transition: ${JSON.stringify(samples.slice(Math.max(0, index - 2), index + 2))}`);
      }
    }
    const settled = samples.filter((sample) => sample.time >= duration - 80).map((sample) => sample.value);
    if (Math.max(...settled) - Math.min(...settled) > 1) {
      throw new Error(`${label} did not settle cleanly: ${JSON.stringify(settled)}`);
    }
  }

  await reactPage.goto(baseUrl, { waitUntil: 'networkidle' });
  await reactPage.locator('[data-testid="react-shell"]').waitFor({ timeout: 10_000 });
  await reactPage.locator('[data-testid="agent-status"][data-state="connected"]').waitFor({ timeout: 10_000 });
  await reactPage.getByRole('heading', { name: /从一个清晰的/ }).waitFor();

  // Settings: categories replace the workspace, theme applies, and Esc returns.
  const settingsButton = reactPage.getByRole('button', { name: '打开设置' });
  await settingsButton.click();
  const settings = reactPage.getByTestId('settings-workspace');
  await settings.waitFor();
  await settings.getByRole('heading', { name: '常规', exact: true }).waitFor();
  if (await reactPage.locator('html').getAttribute('lang') !== 'zh-CN') throw new Error('Chinese locale was not applied to the document');
  await settings.locator('label.settings-language-option', { hasText: 'English' }).click();
  await settings.getByRole('heading', { name: 'General', exact: true }).waitFor();
  if (await reactPage.locator('html').getAttribute('lang') !== 'en-US') throw new Error('English locale was not applied to the document');
  if (await reactPage.evaluate(() => window.localStorage.getItem('tau-locale')) !== 'en-US') throw new Error('English locale preference was not persisted');
  await settings.locator('label.settings-language-option', { hasText: '简体中文' }).click();
  await settings.getByRole('heading', { name: '常规', exact: true }).waitFor();
  await settings.getByText(ready.tempRoot, { exact: false }).first().waitFor();
  await settings.getByRole('button', { name: '模块', exact: true }).click();
  await settings.getByLabel('模块包路径').waitFor();
  await settings.getByText('耗时统计', { exact: true }).waitFor();
  await settings.getByRole('button', { name: '常规', exact: true }).click();
  await settings.locator('[role="radio"][aria-checked="false"]').first().click();
  const selectedTheme = await reactPage.evaluate(() => document.documentElement.dataset.theme);
  await reactPage.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });
  const mainWidthAfterSettings = await reactPage.locator('.agent-main-column').evaluate((node) => node.getBoundingClientRect().width);
  if (mainWidthAfterSettings < 600) throw new Error(`Workspace width was not restored after settings (${mainWidthAfterSettings}px)`);

  await settingsButton.click();
  await settings.getByRole('button', { name: 'Agent', exact: true }).click();
  await settings.getByText('kimi-coding', { exact: true }).waitFor();
  await settings.getByRole('button', { name: '添加模型' }).click();
  const addModel = reactPage.getByRole('dialog', { name: '添加 Pi 模型' });
  await addModel.getByLabel('Provider ID').fill('smoke-provider');
  await addModel.getByLabel('Model ID').fill('smoke-model');
  await addModel.getByLabel('API Base URL').fill('http://127.0.0.1:1/v1');
  await addModel.getByLabel('API Key').fill('smoke-key');
  await addModel.getByRole('button', { name: '保存模型' }).click();
  await settings.waitFor();
  await reactPage.keyboard.press('Escape');

  // Command palette keyboard path.
  await reactPage.keyboard.press('Control+k');
  await reactPage.getByRole('dialog', { name: '命令' }).waitFor();
  await reactPage.getByRole('option', { name: /工作台设置/ }).waitFor();
  await reactPage.keyboard.press('Escape');

  async function createTask(name = '') {
    const previousCount = await reactPage.locator('.live-tab-select').count();
    await reactPage.getByRole('button', { name: '新建交通任务' }).first().click();
    const dialog = reactPage.getByRole('dialog', { name: '新建交通任务' });
    if (await dialog.getByText('任务类型', { exact: true }).count() || await dialog.getByText('预期交付', { exact: true }).count()) {
      throw new Error('New task dialog should not expose task type or expected output fields');
    }
    if (name) await dialog.getByLabel('任务名称（可选）').fill(name);
    await dialog.getByText('模型', { exact: true }).locator('..').locator('.menu-select-trigger').click();
    await dialog.getByRole('option', { name: /kimi-coding\/k2p7/ }).click();
    await dialog.getByRole('button', { name: '创建任务' }).click();
    await reactPage.locator('.live-tab-select').nth(previousCount).waitFor({ timeout: 10_000 });
    return reactPage.evaluate(async () => {
      const sessions = await (await fetch('/api/live-sessions')).json();
      return sessions.sessions.at(-1);
    });
  }

  const primaryTask = await createTask();
  if (!/^\d{8}-\d{6}(?:-\d+)?$/.test(path.basename(primaryTask.cwd))) {
    throw new Error(`Unnamed task workspace should use only its creation timestamp: ${primaryTask.cwd}`);
  }
  await reactPage.getByRole('button', { name: '新建交通任务' }).last().click();
  const secondDialog = reactPage.getByRole('dialog', { name: '新建交通任务' });
  await secondDialog.getByLabel('任务名称（可选）').fill('Smoke task 2');
  await secondDialog.getByText('模型', { exact: true }).locator('..').locator('.menu-select-trigger').click();
  await secondDialog.getByRole('option', { name: /kimi-coding\/k2p7/ }).click();
  await secondDialog.getByRole('button', { name: '创建任务' }).click();
  await reactPage.locator('.live-tab-select').nth(1).waitFor({ timeout: 10_000 });
  await reactPage.getByTitle(primaryTask.cwd, { exact: true }).click();
  if (!await reactPage.getByTitle(primaryTask.cwd, { exact: true }).evaluate((node) => node.closest('.live-tab')?.classList.contains('is-active'))) {
    throw new Error('Primary timestamped task did not become active');
  }
  await settingsButton.click();
  await settings.waitFor();
  await reactPage.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });
  const activeWorkspaceWidth = await reactPage.locator('.agent-main-column').evaluate((node) => node.getBoundingClientRect().width);
  if (activeWorkspaceWidth < 600) throw new Error(`Active workspace width was not restored after settings (${activeWorkspaceWidth}px)`);

  const sidebarClosedMotion = await measureMotion('button[aria-label="展开或收起会话侧栏"]', '.agent-main-column', 'left', 460);
  assertSmoothMotion(sidebarClosedMotion, 'decreasing', 'Desktop sidebar close');
  await reactPage.locator('[data-testid="session-sidebar"]:not(.is-open)').waitFor();
  const sidebarOpenedMotion = await measureMotion('button[aria-label="展开或收起会话侧栏"]', '.agent-main-column', 'left', 460);
  assertSmoothMotion(sidebarOpenedMotion, 'increasing', 'Desktop sidebar open');
  await reactPage.locator('[data-testid="session-sidebar"].is-open').waitFor();

  // Conversation: React composer sends through the command port; optimistic
  // user message and streaming/final assistant rendering share the Kernel.
  const composer = reactPage.getByLabel('消息输入');
  await composer.fill('基线-happy');
  await composer.press('Enter');
  await reactPage.locator('.user-message', { hasText: '基线-happy' }).waitFor();
  await reactPage.locator('.live-tab-select', { hasText: '基线-happy' }).waitFor({ timeout: 10_000 });
  const activeThinking = reactPage.locator('.assistant-message.is-streaming .thinking-toggle', { hasText: '正在思考中' });
  await activeThinking.waitFor({ timeout: 10_000 });
  const clockSamples = await activeThinking.evaluate((node) => new Promise((resolve) => {
    const values = [];
    const startedAt = performance.now();
    const sample = (now) => {
      values.push(node.textContent?.trim() || '');
      if (now - startedAt >= 220) resolve(values);
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));
  const visibleClockSamples = clockSamples.filter((value) => value.startsWith('正在思考中（'));
  if (!visibleClockSamples.length || visibleClockSamples.some((value) => !/^正在思考中（\d+\.\d 秒）$/.test(value))) {
    throw new Error(`Live thinking clock should always show one decimal place: ${JSON.stringify(clockSamples)}`);
  }
  if (new Set(visibleClockSamples).size < 2) throw new Error(`Live thinking clock did not update within 220ms: ${JSON.stringify(clockSamples)}`);
  const baselineMessage = reactPage.locator('.assistant-message', { hasText: '上海早高峰分析结果' }).last();
  await baselineMessage.waitFor({ timeout: 10_000 });
  const thinkingToggle = baselineMessage.locator('.thinking-toggle', { hasText: '已思考' });
  await thinkingToggle.waitFor();
  if (await thinkingToggle.getAttribute('aria-expanded') !== 'true') throw new Error('Thinking block should be expanded by default');
  const thinkingChrome = await reactPage.locator('.thinking-block pre').evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, border: style.borderTopStyle };
  });
  if (thinkingChrome.background !== 'rgba(0, 0, 0, 0)' || thinkingChrome.border !== 'none') {
    throw new Error(`Thinking block should use plain gray text: ${JSON.stringify(thinkingChrome)}`);
  }
  await reactPage.getByRole('button', { name: '发送消息', exact: true }).waitFor({ timeout: 10_000 });

  await settingsButton.click();
  await settings.getByRole('button', { name: '常规', exact: true }).click();
  const expandThinkingSwitch = settings.getByRole('switch', { name: '默认展开思考内容' });
  if (await expandThinkingSwitch.getAttribute('aria-checked') !== 'true') throw new Error('Thinking content should default to expanded');
  await expandThinkingSwitch.click();
  if (await reactPage.evaluate(() => window.localStorage.getItem('tau-expand-thinking')) !== 'false') throw new Error('Collapsed thinking preference was not persisted');
  await reactPage.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });

  await composer.fill('基线-happy-collapsed');
  await composer.press('Enter');
  await reactPage.locator('.assistant-message.is-streaming .thinking-toggle', { hasText: '正在思考中' }).waitFor({ timeout: 10_000 });
  const collapsedMessage = reactPage.locator('.assistant-message', { hasText: '上海早高峰分析结果' }).last();
  await collapsedMessage.waitFor({ timeout: 10_000 });
  const collapsedThinking = collapsedMessage.locator('.thinking-toggle');
  if (await collapsedThinking.getAttribute('aria-expanded') !== 'false') throw new Error('Thinking block should honor the collapsed preference');
  if (!/^已思考（\d+\.\d 秒）$/.test((await collapsedThinking.textContent())?.trim() || '')) throw new Error(`Completed thinking duration was not shown with one decimal place: ${await collapsedThinking.textContent()}`);
  if (await collapsedMessage.locator('.thinking-block pre').count()) throw new Error('Collapsed thinking text should not be rendered');
  await collapsedThinking.click();
  await collapsedMessage.locator('.thinking-block pre', { hasText: '用户在请求基线 happy path' }).waitFor();
  await reactPage.getByRole('button', { name: '发送消息', exact: true }).waitFor({ timeout: 10_000 });

  await reactPage.getByLabel('消息输入').fill('基线-citation-document');
  await reactPage.getByLabel('消息输入').press('Enter');
  const citedMessage = reactPage.locator('.assistant-message', { hasText: '入口存在拥堵风险' }).last();
  await citedMessage.locator('.message-artifacts', { hasText: '本次产出' }).waitFor({ timeout: 10_000 });
  if (await citedMessage.locator('.citation-marker').count() || await citedMessage.locator('.citation-footer').count()) {
    throw new Error('Session artifact was rendered as numbered evidence');
  }
  await citedMessage.getByRole('button', { name: /引用报告/ }).click();
  const citationPreview = reactPage.locator('.file-preview-card', { hasText: '引用报告' });
  await citationPreview.waitFor();
  await citationPreview.locator('.file-preview-report', { hasText: '入口拥堵' }).waitFor();
  const reportImage = citationPreview.locator('.file-preview-report img[alt="报告图表"]');
  await reportImage.waitFor();
  await reportImage.evaluate((image) => new Promise((resolve) => {
    if (image.complete) return resolve(true);
    image.addEventListener('load', () => resolve(true), { once: true });
    image.addEventListener('error', () => resolve(true), { once: true });
  }));
  const reportImageState = await reportImage.evaluate((image) => ({ src: image.src, naturalWidth: image.naturalWidth }));
  if (!reportImageState.naturalWidth) {
    const imageResponse = await reactPage.request.get(reportImageState.src);
    throw new Error(`Relative Markdown report image is invalid (${imageResponse.status()} ${reportImageState.src}): ${(await imageResponse.text()).slice(0, 300)}`);
  }
  if (!(await reportImage.getAttribute('src'))?.includes('/api/file/preview?')) {
    throw new Error('Relative Markdown report image did not use the session-scoped preview route');
  }
  const pdfDownloadPromise = reactPage.waitForEvent('download');
  await citationPreview.getByRole('button', { name: '下载 PDF' }).click();
  const reportDownload = await pdfDownloadPromise;
  const reportPdfPath = await reportDownload.path();
  if (!reportPdfPath || fs.readFileSync(reportPdfPath).subarray(0, 4).toString() !== '%PDF') {
    throw new Error('Markdown report PDF download is invalid');
  }
  if (!reportDownload.suggestedFilename().endsWith('.pdf')) throw new Error(`Unexpected PDF filename: ${reportDownload.suggestedFilename()}`);
  if (process.env.TAU_SMOKE_PDF) fs.copyFileSync(reportPdfPath, process.env.TAU_SMOKE_PDF);
  await citationPreview.getByRole('button', { name: '关闭文件预览' }).click();

  await reactPage.getByLabel('消息输入').fill('基线-citation-pdf');
  await reactPage.getByLabel('消息输入').press('Enter');
  const pdfCitationMessage = reactPage.locator('.assistant-message', { hasText: '发现人员聚集后应及时组织疏导' }).last();
  await pdfCitationMessage.locator('.citation-footer', { hasText: '标准规范' }).waitFor({ timeout: 10_000 });
  await pdfCitationMessage.locator('.citation-locator').hover();
  const pdfPageImage = reactPage.locator('.citation-evidence-peek img');
  await pdfPageImage.waitFor();
  const pdfImageLoaded = await pdfPageImage.evaluate((image) => new Promise((resolve) => {
    const target = image;
    if (target.complete && target.naturalWidth > 0) return resolve(true);
    if (target.complete) return resolve(false);
    target.addEventListener('load', () => resolve(true), { once: true });
    target.addEventListener('error', () => resolve(false), { once: true });
  }));
  if (!pdfImageLoaded) {
    const src = await pdfPageImage.getAttribute('src');
    const response = await reactPage.request.get(new URL(src, baseUrl).href);
    throw new Error(`PDF citation page image failed to load (${response.status()}): ${(await response.text()).slice(0, 300)}`);
  }
  if (process.env.TAU_SMOKE_SCREENSHOT) await reactPage.screenshot({ path: process.env.TAU_SMOKE_SCREENSHOT, fullPage: true });
  await pdfCitationMessage.getByRole('button', { name: /大型活动安全要求/ }).click();
  const pdfPreview = reactPage.locator('.file-preview-card', { hasText: '大型活动安全要求' });
  await pdfPreview.waitFor();
  const pdfPreviewSrc = await pdfPreview.locator('iframe').getAttribute('src');
  if (!pdfPreviewSrc?.includes('#page=1')) throw new Error(`PDF preview did not open at cited page: ${pdfPreviewSrc}`);
  await pdfPreview.getByRole('button', { name: '关闭文件预览' }).click();

  // Task mode is a silent control action: it changes state without adding a
  // slash-command bubble or extension notification to the conversation.
  const taskToggle = reactPage.getByRole('switch', { name: '开启任务模式' });
  const userMessageCount = await reactPage.locator('.user-message').count();
  await taskToggle.click();
  await reactPage.getByRole('switch', { name: '关闭任务模式' }).waitFor();
  if (await reactPage.locator('.user-message').count() !== userMessageCount) {
    throw new Error('Enabling task mode added a visible user message');
  }
  if (await reactPage.getByText('/task on', { exact: true }).count() || await reactPage.getByText('任务模式已开启', { exact: true }).count()) {
    throw new Error('Enabling task mode exposed its internal command or notification');
  }
  await reactPage.getByRole('switch', { name: '关闭任务模式' }).click();
  await reactPage.getByRole('switch', { name: '开启任务模式' }).waitFor();
  if (await reactPage.locator('.user-message').count() !== userMessageCount) {
    throw new Error('Disabling task mode added a visible user message');
  }
  if (await reactPage.getByText('/task off', { exact: true }).count() || await reactPage.getByText('任务模式已关闭', { exact: true }).count()) {
    throw new Error('Disabling task mode exposed its internal command or notification');
  }

  // Streaming composer keeps only the steer and abort actions.
  await composer.fill('基线-abort');
  await composer.press('Enter');
  const streamActions = reactPage.locator('.composer-stream-actions');
  await streamActions.getByRole('button', { name: '发送引导', exact: true }).waitFor();
  await streamActions.getByRole('button', { name: '终止当前任务', exact: true }).waitFor();
  if (await streamActions.locator(':scope > button').count() !== 2) throw new Error('Streaming composer should expose exactly two actions');
  if (await reactPage.getByRole('button', { name: '后续问题', exact: true }).count()) throw new Error('Streaming composer should not expose a separate follow-up action');
  await streamActions.getByRole('button', { name: '终止当前任务', exact: true }).click();
  await reactPage.getByRole('button', { name: '发送消息', exact: true }).waitFor({ timeout: 10_000 });

  // Running tools stay inspectable, then collapse when they reach a terminal
  // state.
  await composer.fill('基线-tool-collapse');
  await composer.press('Enter');
  const runningTool = reactPage.locator('.tool-card', { hasText: 'traffic-summary.json' });
  await runningTool.locator('.tool-status.running').waitFor({ timeout: 10_000 });
  const toolToggle = runningTool.locator('.tool-card-toggle');
  if (await toolToggle.getAttribute('aria-expanded') !== 'true') throw new Error('Running tool should be expanded');
  await runningTool.locator('.tool-status.completed').waitFor({ timeout: 10_000 });
  if (await toolToggle.getAttribute('aria-expanded') !== 'false') throw new Error('Completed tool should collapse automatically');
  const toolDuration = (await runningTool.locator('.tool-duration').textContent())?.trim() || '';
  if (!/^\d+\.\d 秒$/.test(toolDuration)) throw new Error(`Completed tool duration was not shown with one decimal place: ${toolDuration}`);
  const timingSnapshot = await reactPage.evaluate(async (sessionId) => (await fetch(`/api/live-sessions/${sessionId}/snapshot`)).json(), primaryTask.id);
  const timedThinking = timingSnapshot.entries.find((entry) => entry.message?.role === 'assistant' && entry.message.content?.some?.((block) => block.type === 'thinking' && typeof block.durationMs === 'number'));
  const timedTool = timingSnapshot.entries.find((entry) => entry.message?.role === 'toolResult' && entry.message.toolName === 'read' && typeof entry.message.durationMs === 'number');
  if (!timedThinking || !timedTool) throw new Error('Persisted timing metadata was not merged into the live snapshot');
  if (!fs.existsSync(path.join(primaryTask.cwd, '.tau', 'timing-metrics.v1.json'))) throw new Error('Timing metadata sidecar was not persisted');
  await reactPage.evaluate(() => { document.documentElement.dataset.theme = 'sand'; });
  const toolChrome = await runningTool.evaluate((node) => {
    const card = getComputedStyle(node);
    const header = getComputedStyle(node.querySelector('header'));
    const label = getComputedStyle(node.querySelector('.tool-card-toggle strong'));
    const preview = getComputedStyle(node.querySelector('.tool-card-toggle small'));
    const marker = getComputedStyle(node.querySelector('.tool-status.completed'));
    return {
      width: Number.parseFloat(card.width),
      radius: Number.parseFloat(card.borderTopLeftRadius),
      cardBackground: card.backgroundColor,
      cardBorder: card.borderTopStyle,
      headerHeight: Number.parseFloat(header.height),
      labelFontSize: Number.parseFloat(label.fontSize),
      previewFontSize: Number.parseFloat(preview.fontSize),
      previewFlexGrow: Number.parseFloat(preview.flexGrow),
      previewMaxWidth: preview.maxWidth,
      previewMinWidth: preview.minWidth,
      labelColor: label.color,
      bodyColor: getComputedStyle(document.body).color,
      labelBackground: label.backgroundColor,
      labelBorder: label.borderTopStyle,
      markerBackground: marker.backgroundColor,
      markerRadius: marker.borderTopLeftRadius,
    };
  });
  if (toolChrome.width < 719 || toolChrome.width > 721 || toolChrome.radius !== 0 || toolChrome.headerHeight < 40 || toolChrome.labelFontSize !== 12 || toolChrome.previewFontSize !== 12 || toolChrome.previewFlexGrow !== 1 || toolChrome.previewMaxWidth !== 'none' || toolChrome.previewMinWidth !== '0px') {
    throw new Error(`Collapsed tool proportions are outside the timeline design: ${JSON.stringify(toolChrome)}`);
  }
  await toolToggle.click();
  const expandedToolChrome = await runningTool.evaluate((node) => ({
    width: Number.parseFloat(getComputedStyle(node).width),
    argsFontSize: Number.parseFloat(getComputedStyle(node.querySelector('.tool-args')).fontSize),
    outputFontSize: Number.parseFloat(getComputedStyle(node.querySelector('.tool-output')).fontSize),
    outputLabelFontSize: Number.parseFloat(getComputedStyle(node.querySelector('.tool-output-actions')).fontSize),
    copyFontSize: Number.parseFloat(getComputedStyle(node.querySelector('.tool-output-actions button')).fontSize),
  }));
  await toolToggle.click();
  if (Math.abs(expandedToolChrome.width - toolChrome.width) > 1) {
    throw new Error(`Collapsed and expanded tools should share one width: ${JSON.stringify({ collapsed: toolChrome.width, expanded: expandedToolChrome.width })}`);
  }
  if (expandedToolChrome.argsFontSize !== 12.5 || expandedToolChrome.outputFontSize !== 12.5 || expandedToolChrome.outputLabelFontSize !== 11 || expandedToolChrome.copyFontSize !== 11) {
    throw new Error(`Expanded tool typography is not using the larger scale: ${JSON.stringify(expandedToolChrome)}`);
  }
  if (toolChrome.cardBackground !== 'rgba(0, 0, 0, 0)' || toolChrome.cardBorder !== 'none' || toolChrome.labelColor !== toolChrome.bodyColor || toolChrome.labelBackground !== 'rgba(0, 0, 0, 0)' || toolChrome.labelBorder !== 'none') {
    throw new Error(`Tool history should be borderless with a plain text label: ${JSON.stringify(toolChrome)}`);
  }
  if (toolChrome.markerBackground !== 'rgb(185, 109, 76)' || toolChrome.markerRadius !== '50%') {
    throw new Error(`Sand completion marker should carry the timeline accent: ${JSON.stringify(toolChrome)}`);
  }
  await reactPage.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, selectedTheme);

  // Tool glyphs communicate command, task, Geo, read, write, and fallback
  // semantics without relying on the text label.
  await composer.fill('基线-tool-icons');
  await composer.press('Enter');
  const expectedToolKinds = ['command', 'task', 'map', 'file', 'write', 'tool'];
  for (const kind of expectedToolKinds) {
    await reactPage.locator(`.tool-status[data-tool-kind="${kind}"]`).last().waitFor({ timeout: 10_000 });
  }
  const allToolLabels = await reactPage.locator('.tool-card-toggle strong').evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() || ''));
  const localizedToolLabels = allToolLabels.slice(-6);
  const expectedToolLabels = ['命令执行', '任务执行', '地图展示', '文件读取', '文件写入', '通用工具'];
  if (JSON.stringify(localizedToolLabels) !== JSON.stringify(expectedToolLabels) || allToolLabels.some((label) => !/^[\p{Script=Han}]{1,4}$/u.test(label))) {
    throw new Error(`Tool labels should use unified Chinese names of at most four characters: ${JSON.stringify(allToolLabels)}`);
  }
  if (await reactPage.locator('.tool-card-toggle .tool-kind-icon').count()) throw new Error('Tool glyph should replace the timeline status mark, not appear beside the label');
  const fallbackToolIcon = reactPage.locator('.tool-status[data-tool-kind="tool"]').last();
  const iconChrome = await fallbackToolIcon.evaluate((node) => {
    const icon = node.querySelector('svg');
    const style = getComputedStyle(node);
    const iconStyle = icon ? getComputedStyle(icon) : null;
    return { width: Number.parseFloat(style.width), height: Number.parseFloat(style.height), iconWidth: iconStyle ? Number.parseFloat(iconStyle.width) : 0 };
  });
  if (iconChrome.width !== 20 || iconChrome.height !== 20 || iconChrome.iconWidth !== 12) {
    throw new Error(`Tool glyph proportions changed: ${JSON.stringify(iconChrome)}`);
  }
  await fallbackToolIcon.evaluate((node) => node.closest('.tool-card')?.querySelector('button')?.click());
  const expandedIconTransform = await fallbackToolIcon.locator('svg').evaluate((node) => getComputedStyle(node).transform);
  if (expandedIconTransform !== 'none') throw new Error(`Tool glyph should not rotate with the disclosure chevron: ${expandedIconTransform}`);
  await fallbackToolIcon.evaluate((node) => node.closest('.tool-card')?.querySelector('button')?.click());

  // Trigger real extension_ui_request variants through fake Pi and answer them in React.
  async function triggerPrompt(message) {
    await reactPage.evaluate(async ({ sessionId, prompt }) => {
      await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'prompt', sessionId, message: prompt }),
      });
    }, { sessionId: primaryTask.id, prompt: message });
  }

  await triggerPrompt('基线-task');
  const selectDialog = reactPage.getByRole('dialog', { name: '选择分析范围' });
  await selectDialog.waitFor({ timeout: 10_000 });
  await selectDialog.getByRole('button', { name: /只看工作日/ }).click();
  await selectDialog.waitFor({ state: 'hidden' });
  await reactPage.locator('.tool-card', { hasText: '任务状态' }).waitFor({ timeout: 10_000 });
  await reactPage.locator('[data-testid="agent-status"][data-state="connected"]').waitFor();

  // The first task opens its flat progress surface automatically. Task and map
  // keep their own floating views; files remain the only right dock resource.
  const taskPanel = reactPage.getByTestId('workspace-float-tasks');
  await taskPanel.locator('.task-board-card', { hasText: '分析上海体育馆早高峰下车热点' }).waitFor({ timeout: 10_000 });
  await reactPage.waitForTimeout(250);
  const taskPanelBeforeDrag = await taskPanel.boundingBox();
  const taskHeader = taskPanel.locator('.workspace-float-header');
  const taskHeaderBox = await taskHeader.boundingBox();
  const taskPanelWidth = await taskPanel.evaluate((node) => Number.parseFloat(getComputedStyle(node).width));
  if (!taskPanelBeforeDrag || !taskHeaderBox) throw new Error('Task panel drag geometry is unavailable');
  if (taskPanelWidth !== 320 || await taskHeader.evaluate((node) => getComputedStyle(node).cursor) !== 'grab') {
    throw new Error(`Task panel should use the narrower draggable treatment: ${JSON.stringify(taskPanelBeforeDrag)}`);
  }
  await reactPage.mouse.move(taskHeaderBox.x + 32, taskHeaderBox.y + taskHeaderBox.height / 2);
  await reactPage.mouse.down();
  await taskPanel.locator('.workspace-float-header').evaluate((node) => {
    if (!node.closest('.workspace-float')?.classList.contains('is-dragging') || getComputedStyle(node).cursor !== 'grabbing') throw new Error('Task panel did not enter its dragging state');
  });
  await reactPage.mouse.move(taskHeaderBox.x - 48, taskHeaderBox.y + taskHeaderBox.height / 2 + 56, { steps: 4 });
  await reactPage.mouse.up();
  const taskPanelAfterDrag = await taskPanel.boundingBox();
  if (!taskPanelAfterDrag || Math.abs(taskPanelAfterDrag.x - (taskPanelBeforeDrag.x - 80)) > 2 || Math.abs(taskPanelAfterDrag.y - (taskPanelBeforeDrag.y + 56)) > 2) {
    throw new Error(`Task panel did not follow the drag gesture: ${JSON.stringify({ before: taskPanelBeforeDrag, after: taskPanelAfterDrag })}`);
  }
  const mainBounds = await reactPage.locator('.agent-main-column').boundingBox();
  if (!mainBounds || taskPanelAfterDrag.x < mainBounds.x || taskPanelAfterDrag.y < mainBounds.y || taskPanelAfterDrag.x + taskPanelAfterDrag.width > mainBounds.x + mainBounds.width || taskPanelAfterDrag.y + taskPanelAfterDrag.height > mainBounds.y + mainBounds.height) {
    throw new Error(`Dragged task panel escaped the main workspace: ${JSON.stringify({ main: mainBounds, panel: taskPanelAfterDrag })}`);
  }
  await taskPanel.locator('.task-board-card').evaluate((node) => {
    const style = getComputedStyle(node);
    if (Number.parseFloat(style.borderTopWidth) !== 0 || style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
      throw new Error(`Task content should be flat inside the floating panel: ${JSON.stringify({ border: style.borderTopWidth, background: style.backgroundColor })}`);
    }
    if ((node.textContent || '').includes('PI TASK')) throw new Error('Task content still exposes the retired PI TASK label');
  });
  const filesOpenedMotion = await measureMotion('button[aria-label="打开或关闭文件栏"]', '.agent-main-column', 'width', 460);
  assertSmoothMotion(filesOpenedMotion, 'decreasing', 'Desktop file panel open');
  await reactPage.locator('[data-testid="workspace-dock"].is-open').waitFor();
  await reactPage.locator('.workspace-file-list').waitFor();
  const filesClosedMotion = await measureMotion('[data-testid="workspace-dock"] button[aria-label="关闭文件栏"]', '.agent-main-column', 'width', 460);
  assertSmoothMotion(filesClosedMotion, 'increasing', 'Desktop file panel close');
  await reactPage.locator('[data-testid="workspace-dock"]:not(.is-open)').waitFor();
  if (requestedUrls.some((url) => url.includes('geo-runtime-entry') || url.includes('maplibre'))) {
    throw new Error('Task feature loaded the Geo Runtime before the Geo workspace was activated');
  }
  await reactPage.getByTestId('workspace-float-tasks').getByRole('button', { name: '关闭任务面板', exact: true }).click();
  await reactPage.locator('[data-testid="workspace-float-tasks"]:not(.is-open)').waitFor();

  // A later task starts again at revision 1 and must replace the completed
  // higher-revision task before the overall agent response finishes.
  await triggerPrompt('连续任务切换');
  await reactPage.getByRole('button', { name: '打开或关闭任务面板' }).click();
  const taskFloat = reactPage.getByTestId('workspace-float-tasks');
  await taskFloat.getByText('第一项任务', { exact: true }).waitFor({ timeout: 10_000 });
  await taskFloat.getByText('第二项任务', { exact: true }).waitFor({ timeout: 10_000 });
  await reactPage.getByRole('button', { name: '发送引导', exact: true }).waitFor();
  await reactPage.locator('[data-testid="agent-status"][data-state="connected"]').waitFor({ timeout: 10_000 });
  await taskFloat.getByRole('button', { name: '关闭任务面板', exact: true }).click();

  await triggerPrompt('基线-geo');
  await reactPage.locator('.assistant-message', { hasText: '地图已发布，可在右侧地图面板查看。' }).waitFor({ timeout: 10_000 });
  const conversationTimeline = await reactPage.evaluate(() => Array.from(document.querySelectorAll('.conversation-thread > *')).map((node) => (node.textContent || '').trim()));
  const geoIntroIndex = conversationTimeline.findLastIndex((text) => text.includes('正在生成下车热点地图。'));
  const geoToolIndex = conversationTimeline.findLastIndex((text) => text.includes('地图展示'));
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
  const retryProtocolErrors = await reactPage.locator('.runtime-notice', { hasText: /Unknown RPC event type "auto_retry_(?:start|end)"/ }).count();
  if (retryProtocolErrors) throw new Error('automatic retry lifecycle surfaced as a protocol error');
  await reactPage.locator('[data-testid="workspace-float-map"].is-open').waitFor({ timeout: 10_000 });
  await reactPage.locator('.geo-map').waitFor({ timeout: 10_000 });
  await reactPage.locator('.geo-layers', { hasText: '下车点' }).waitFor({ timeout: 10_000 });
  const geoView = reactPage.getByTestId('workspace-float-map');
  const geoCanvas = geoView.locator('canvas.maplibregl-canvas');
  await geoCanvas.waitFor({ timeout: 10_000 });
  await geoCanvas.evaluate((node) => { node.dataset.smokePersistentMap = 'true'; });
  const geoLayerLayout = await geoView.locator('.geo-layers').evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      columns: style.gridTemplateColumns.split(/\s+/).filter(Boolean).length,
      height: Number.parseFloat(style.height),
      maxHeight: Number.parseFloat(style.maxHeight),
      overflowY: style.overflowY,
    };
  });
  if (geoLayerLayout.columns !== 3 || geoLayerLayout.maxHeight !== 96 || geoLayerLayout.height >= geoLayerLayout.maxHeight || geoLayerLayout.overflowY !== 'auto') {
    throw new Error(`Geo layer panel is not a content-sized three-column scroller: ${JSON.stringify(geoLayerLayout)}`);
  }
  const geoDescriptionLayout = await geoView.locator('.geo-description').evaluate((node) => {
    const style = getComputedStyle(node);
    const chrome = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
      + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
    return {
      height: Number.parseFloat(style.height),
      maxHeight: Number.parseFloat(style.maxHeight),
      maxLines: (Number.parseFloat(style.maxHeight) - chrome) / Number.parseFloat(style.lineHeight),
      overflowY: style.overflowY,
    };
  });
  if (Math.abs(geoDescriptionLayout.maxLines - 4) > 0.05 || geoDescriptionLayout.height >= geoDescriptionLayout.maxHeight || geoDescriptionLayout.overflowY !== 'auto') {
    throw new Error(`Geo description is not a content-sized four-line scroller: ${JSON.stringify(geoDescriptionLayout)}`);
  }
  await geoView.getByRole('button', { name: '回到范围' }).click();
  const dropoffLayerToggle = geoView.locator('.geo-layers label', { hasText: '下车点' }).locator('input');
  await dropoffLayerToggle.uncheck();
  await triggerPrompt('更新-geo');
  await geoView.locator('.geo-toolbar', { hasText: 'revision 2' }).waitFor({ timeout: 10_000 });
  if (await geoView.locator('canvas[data-smoke-persistent-map="true"]').count() !== 1) {
    throw new Error('Geo revision update rebuilt the MapLibre canvas');
  }
  if (await dropoffLayerToggle.isChecked()) {
    throw new Error('Geo revision update discarded the local layer visibility override');
  }
  if (!requestedUrls.some((url) => url.includes('geo-runtime-entry') || url.includes('maplibre'))) {
    throw new Error('Geo workspace did not load its runtime on demand');
  }
  const mapClosedMotion = await measureMotion('[data-testid="workspace-float-map"] button[aria-label="关闭地图视图"]', '.conversation-pane', 'left', 540);
  assertSmoothMotion(mapClosedMotion, 'decreasing', 'Desktop map close');
  await reactPage.locator('.agent-main-column:not(.is-map-focused)').waitFor();

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
