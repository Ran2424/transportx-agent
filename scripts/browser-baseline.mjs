#!/usr/bin/env node
// browser-baseline — React 迁移阶段 0 的真实浏览器行为基线。
//
// 起 serve-with-fake-pi 线束（真实 server + fake-pi 回放协议一致的事件），
// 用 playwright + 系统 Chrome 驱动并断言核心行为，产出：
//   test/baselines/screenshots/*.png        6 主题 × 桌面/移动 截图（gitignore，只留 manifest.json 哈希清单）
//   test/baselines/perf-baseline.json       性能基线数字 + 环境信息（无硬阈值）
// 退出码非 0 表示基线失败。browser-smoke.mjs 保持不动。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINES_DIR = path.join(REPO_ROOT, 'test', 'baselines');
const SCREENSHOTS_DIR = path.join(BASELINES_DIR, 'screenshots');
const THEMES = ['night', 'dawn', 'midnight', 'clean', 'terracotta', 'sage'];

const HAPPY_FINAL_TEXT = '上海早高峰分析结果：内环高架拥堵指数 1.8，漕溪北路与中山南二路为主要瓶颈。';

const results = [];
const pageErrors = [];
let meta = null;
let serverChild = null;
let browser = null;
let failed = false;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[baseline] ${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

async function scenario(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : '');
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { message: `场景「${name}」失败：${error instanceof Error ? error.message : error}` });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---- 线束启动 ----
async function startHarness() {
  serverChild = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts', 'harness', 'serve-with-fake-pi.mjs')], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  serverChild.stdout.on('data', (chunk) => { stdout += chunk; });
  serverChild.stderr.on('data', (chunk) => process.stderr.write(`[harness] ${chunk}`));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (serverChild.exitCode !== null) throw new Error(`serve-with-fake-pi 提前退出（${serverChild.exitCode}）`);
    const line = stdout.split('\n').find((candidate) => candidate.startsWith('TAU_FAKE_READY '));
    if (line) return JSON.parse(line.slice('TAU_FAKE_READY '.length));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('serve-with-fake-pi 启动超时');
}

// ---- 页面辅助 ----
async function waitConnected(page) {
  await page.locator('#status-indicator.connected').waitFor({ timeout: 15000 });
}

async function createSessionViaUI(page, name) {
  await page.locator('#live-tab-add').click();
  await page.locator('#new-live-session-overlay:not(.hidden)').waitFor();
  await page.locator('#new-live-session-name').fill(name);
  await page.locator('#new-live-session-cwd').evaluate((element, value) => { element.value = value; }, meta.projectsDir);
  await page.locator('#new-live-session-submit').click();
  // 等待新会话成为活动标签（不能等 .live-tab.active —— 旧标签可能仍是 active）
  await page.waitForFunction(
    (expected) => document.querySelector('.live-tab.active .live-tab-title')?.textContent?.trim() === expected,
    name,
    { timeout: 15000 },
  );
  await page.waitForFunction(
    (expected) => document.querySelector('.live-tab.active .live-tab-title')?.textContent?.trim() === expected,
    name,
    { timeout: 15000 },
  );
  const title = (await page.locator('.live-tab.active .live-tab-title').textContent())?.trim();
  assert(title === name, `新会话标题应为「${name}」，实际「${title}」`);
}

async function sendPrompt(page, text) {
  await page.locator('#message-input').fill(text);
  await page.locator('#message-input').press('Enter');
}

async function waitStreamDone(page, timeout = 30000) {
  await page.locator('#send-btn:not(.hidden)').waitFor({ timeout });
}

function assistantTexts(page) {
  return page.locator('.message.assistant .message-content').allTextContents();
}

async function main() {
  meta = await startHarness();
  const baseUrl = meta.baseUrl;
  browser = await chromium.launch({ channel: process.env.TAU_BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => void dialog.accept());
  const requestedUrls = [];
  page.on('request', (request) => requestedUrls.push(request.url()));

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await waitConnected(page);

  // ── 核心场景：create / switch / streaming / abort / resume / close ──
  await scenario('create：通过 UI 创建会话', async () => {
    await createSessionViaUI(page, '基线-A');
    await createSessionViaUI(page, '基线-B');
    const tabs = await page.locator('.live-tab').count();
    assert(tabs === 2, `应有 2 个 live tab，实际 ${tabs}`);
  });

  await scenario('switch：切换会话标签', async () => {
    await page.locator('.live-tab').first().click();
    const active = (await page.locator('.live-tab.active .live-tab-title').textContent())?.trim();
    assert(active === '基线-A', `切换后活动标签应为「基线-A」，实际「${active}」`);
  });

  await scenario('streaming：delta 增量渲染且结束后内容完整', async () => {
    await sendPrompt(page, '基线-happy');
    await page.locator('#abort-btn:not(.hidden)').waitFor({ timeout: 5000 });
    const streamingContent = page.locator('.message-content.streaming');
    await streamingContent.waitFor({ timeout: 5000 });
    const first = (await streamingContent.textContent()) || '';
    await page.waitForTimeout(150);
    const second = (await streamingContent.textContent()) || '';
    assert(second.length > first.length, `流式文本应增量增长（${first.length} → ${second.length}）`);
    await waitStreamDone(page);
    const final = await page.locator('.message.assistant').last().textContent();
    assert(final.includes(HAPPY_FINAL_TEXT), `结束后内容不完整：${final?.slice(0, 80)}`);
  });

  await scenario('abort：流式中停止，UI 恢复可输入且消息无重复', async () => {
    await sendPrompt(page, '基线-abort');
    await page.locator('#abort-btn:not(.hidden)').waitFor({ timeout: 5000 });
    // 等部分内容真正流出再中止，避免在第一个 delta 之前 abort（内容为空无法判重）
    await page.waitForFunction(
      () => document.querySelector('.message-content.streaming')?.textContent?.includes('路段分析报告'),
      null,
      { timeout: 10000 },
    );
    await page.locator('#abort-btn').click();
    await waitStreamDone(page, 10000);
    assert(await page.locator('#message-input').isEnabled(), 'abort 后输入框应可用');
    const matches = (await assistantTexts(page)).filter((text) => text.includes('路段分析报告'));
    assert(matches.length === 1, `abort 后部分消息应只出现一次，实际 ${matches.length} 次`);
  });

  let resumeTabTitle = '';
  await scenario('resume：恢复预置 JSONL 会话并渲染历史', async () => {
    const resumed = await page.evaluate(async (filePath) => {
      const response = await fetch('/api/live-sessions/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      return response.json();
    }, meta.resumeFile);
    assert(resumed.session?.id, `resume 失败：${JSON.stringify(resumed)}`);
    resumeTabTitle = resumed.session.sessionName;
    await page.locator(`.live-tab[data-session-id="${resumed.session.id}"]`).waitFor({ timeout: 10000 });
    await page.locator(`.live-tab[data-session-id="${resumed.session.id}"]`).click();
    await page.locator('.message.assistant').first().waitFor({ timeout: 10000 });
    const body = await page.locator('#messages').textContent();
    assert(body.includes('漕溪北路与中山南二路路口'), '历史内容未渲染');
    const occurrences = body.split('晚高峰（17:30-19:00）同一区域同样拥堵').length - 1;
    assert(occurrences === 1, `重连/恢复后内容不得重复追加，实际出现 ${occurrences} 次`);
    return `sessionName=${resumeTabTitle}`;
  });

  await scenario('close：关闭会话标签', async () => {
    const before = await page.locator('.live-tab').count();
    await page.locator('.live-tab', { hasText: '基线-B' }).locator('.live-tab-close').click();
    await page.waitForFunction((count) => document.querySelectorAll('.live-tab').length === count, before - 1, { timeout: 10000 });
    const titles = await page.locator('.live-tab .live-tab-title').allTextContents();
    assert(!titles.includes('基线-B'), '基线-B 标签应已移除');
  });

  // ── Task Dialog / Task 面板 ──
  await scenario('task：extension_ui_request 对话框与 tau_task 任务面板', async () => {
    await page.locator('.live-tab', { hasText: '基线-A' }).click();
    await sendPrompt(page, '基线-task');
    const dialog = page.locator('#dialog-container:not(.hidden) .dialog--choice');
    try {
      await dialog.waitFor({ timeout: 10000 });
      await dialog.locator('.dialog-option').first().click();
      // 注意不能用 locator('#dialog-container.hidden').waitFor()：
      // display:none 的元素永远不满足 playwright 默认的 visible 状态。
      await page.waitForFunction(() => document.getElementById('dialog-container').classList.contains('hidden'), null, { timeout: 5000 });
      await waitStreamDone(page);
      // 用 DOM click 而非坐标点击：agent_end 后 context pill 更新会改变 header 布局，
      // 坐标点击可能落在旧位置上（flaky）。
      await page.evaluate(() => document.getElementById('task-panel-toggle').click());
      await page.locator('#task-board:not(.collapsed)').waitFor({ timeout: 5000 });
    } catch (error) {
      // 失败时 dump 关键 UI 状态，便于定位
      const debug = await page.evaluate(() => ({
        activeTab: document.querySelector('.live-tab.active .live-tab-title')?.textContent,
        dialogClass: document.getElementById('dialog-container')?.className,
        sendClass: document.getElementById('send-btn')?.className,
        boardClass: document.getElementById('task-board')?.className,
        boardContent: document.getElementById('task-board-content')?.textContent?.slice(0, 100),
      }));
      console.log('[baseline] task 场景失败时 UI 状态：', JSON.stringify(debug));
      throw error;
    }
    const content = await page.locator('#task-board-content').textContent();
    assert(content.includes('分析上海体育馆早高峰下车热点'), `任务面板缺少任务标题：${content?.slice(0, 80)}`);
    await page.evaluate(() => document.getElementById('task-board-close').click());
  });

  // ── 非 Geo 页面不得请求 geo-runtime.js（在 geo 场景之前断言） ──
  await scenario('lazy-geo：非 Geo 页面不请求 geo-runtime.js', async () => {
    const hits = requestedUrls.filter((url) => url.includes('geo-runtime.js'));
    assert(hits.length === 0, `geo 场景前不应请求 geo-runtime.js：${hits.join(', ')}`);
  });

  // ── Geo Workspace ──
  let webgl = false;
  await scenario('geo：present_visualization 打开可视化工作区', async () => {
    webgl = await page.evaluate(() => {
      try { return !!document.createElement('canvas').getContext('webgl2') || !!document.createElement('canvas').getContext('webgl'); }
      catch { return false; }
    });
    await sendPrompt(page, '基线-geo');
    // 直接等完成态，与中间态无关（短流下 #abort-btn 的出现窗口可能只有几百毫秒，容易漏检）
    try {
      await page.waitForFunction(() => {
        const texts = Array.from(document.querySelectorAll('.message.assistant .message-content')).map((el) => el.textContent || '');
        return texts.some((text) => text.includes('地图已发布'));
      }, null, { timeout: 30000 });
      await page.waitForFunction(() => document.body.classList.contains('has-visualizations'), null, { timeout: 10000 });
    } catch (error) {
      const debug = await page.evaluate(() => ({
        sendClass: document.getElementById('send-btn')?.className,
        abortClass: document.getElementById('abort-btn')?.className,
        queued: document.getElementById('queued-messages')?.textContent,
        bodyClass: document.body.className,
        lastMessages: document.getElementById('messages')?.textContent?.slice(-120),
      }));
      console.log('[baseline] geo 场景失败时 UI 状态：', JSON.stringify(debug));
      throw error;
    }
    await page.locator('#file-sidebar:not(.collapsed)').waitFor({ timeout: 10000 });
    await page.locator('#geo-panel:not(.hidden)').waitFor({ timeout: 5000 });
    const title = (await page.locator('#geo-panel-title').textContent())?.trim();
    assert(title === '下车热点热力图', `地图标题应为「下车热点热力图」，实际「${title}」`);
    const layers = await page.locator('#geo-layer-list').textContent();
    assert(layers.includes('下车点'), `图层列表缺少「下车点」：${layers?.slice(0, 80)}`);
    const status = await page.locator('#geo-panel-status').textContent();
    return `WebGL=${webgl}，状态=「${status?.trim()}」`;
  });

  // ── 截图基线：6 主题 × 桌面/移动 ──
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  const manifest = { generatedAt: new Date().toISOString(), note: 'PNG 不入库（.gitignore），本清单记录哈希用于人工比对', files: [] };
  await scenario('screenshots：6 主题 × 桌面/移动', async () => {
    for (const theme of THEMES) {
      await page.evaluate((id) => {
        localStorage.setItem('tau-theme', id);
        document.documentElement.setAttribute('data-theme', id);
      }, theme);
      await page.waitForTimeout(250);
      const desktopFile = `${theme}-desktop.png`;
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, desktopFile) });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitConnected(page);
      await page.locator('.live-tab.active').waitFor({ timeout: 15000 });
      await page.locator('.message.assistant').first().waitFor({ timeout: 15000 });
      const mobileFile = `${theme}-mobile.png`;
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, mobileFile) });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitConnected(page);
      await page.locator('.live-tab.active').waitFor({ timeout: 15000 });
    }
    for (const file of fs.readdirSync(SCREENSHOTS_DIR).filter((name) => name.endsWith('.png')).sort()) {
      const buffer = fs.readFileSync(path.join(SCREENSHOTS_DIR, file));
      manifest.files.push({ file, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
    }
    fs.writeFileSync(path.join(SCREENSHOTS_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return `${manifest.files.length} 张截图`;
  });

  // ── 性能基线（只记录，不设阈值） ──
  const perf = { generatedAt: new Date().toISOString(), environment: {}, measurements: {}, notes: [] };
  await scenario('perf：性能基线采集', async () => {
    // 长 streaming（500 delta）渲染耗时
    await page.locator('.live-tab', { hasText: '基线-A' }).click();
    const streamT0 = await page.evaluate(() => performance.now());
    await sendPrompt(page, '基线-perf');
    await page.locator('.message-content.streaming').waitFor({ timeout: 10000 });
    await waitStreamDone(page, 90000);
    const streamT1 = await page.evaluate(() => performance.now());
    const perfText = (await assistantTexts(page)).find((text) => text.includes('路段早高峰'));
    perf.measurements.longStreaming = {
      deltas: 500,
      wallMs: Math.round(streamT1 - streamT0),
      renderedChars: perfText?.length || 0,
    };

    // 长会话（200 条消息历史）首次渲染耗时
    const resumed = await page.evaluate(async (filePath) => {
      const response = await fetch('/api/live-sessions/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      return response.json();
    }, meta.longHistoryFile);
    assert(resumed.session?.id, `长会话 resume 失败：${JSON.stringify(resumed)}`);
    const tab = page.locator(`.live-tab[data-session-id="${resumed.session.id}"]`);
    await tab.waitFor({ timeout: 10000 });
    const historyT0 = await page.evaluate(() => performance.now());
    await tab.click();
    await page.waitForFunction(() => document.querySelectorAll('#messages .message').length >= 200, null, { timeout: 30000 });
    const historyT1 = await page.evaluate(() => performance.now());
    perf.measurements.longHistoryFirstRender = {
      messages: 200,
      wallMs: Math.round(historyT1 - historyT0),
    };

    perf.environment = {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      chrome: browser.version(),
      webgl,
      viewport: '1440x900',
      headless: true,
    };
    perf.notes.push('只记录数字与环境，不设硬阈值；阈值在后续阶段确定。');
    if (!webgl) perf.notes.push('headless Chrome 无 WebGL：geo 场景只断言了面板/DOM 挂载，未验证地图渲染。');
    fs.mkdirSync(BASELINES_DIR, { recursive: true });
    fs.writeFileSync(path.join(BASELINES_DIR, 'perf-baseline.json'), JSON.stringify(perf, null, 2) + '\n');
    return `streaming=${perf.measurements.longStreaming.wallMs}ms，history=${perf.measurements.longHistoryFirstRender.wallMs}ms`;
  });
}

try {
  await main();
} catch (error) {
  if (!results.some((entry) => !entry.ok)) record('fatal', false, error.message);
  else console.error(`[baseline] ${error.message}`);
} finally {
  await browser?.close().catch(() => {});
  if (serverChild && serverChild.exitCode === null) serverChild.kill('SIGTERM');
  if (serverChild) {
    await Promise.race([
      new Promise((resolve) => serverChild.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
    if (serverChild.exitCode === null) serverChild.kill('SIGKILL');
  }
}

if (pageErrors.length) {
  console.error(`[baseline] 页面错误：\n${pageErrors.join('\n')}`);
  failed = true;
}
console.log(`[baseline] ${results.filter((entry) => entry.ok).length}/${results.length} 场景通过`);
process.exit(failed ? 1 : 0);
