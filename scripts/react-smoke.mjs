#!/usr/bin/env node
import net from 'node:net';
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
try {
  const { baseUrl } = await waitForReady(child, () => output);
  browser = await chromium.launch({ channel: process.env.TAU_BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="agent-status"][data-state="connected"]').waitFor();

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

  if (pageErrors.length) throw new Error(`Web scenario raised page errors: ${pageErrors.join('\n')}`);
  console.log('Web scenario passed: create traffic task, receive analysis, and publish map.');
} finally {
  await browser?.close();
  if (child.exitCode === null) child.kill('SIGTERM');
}
