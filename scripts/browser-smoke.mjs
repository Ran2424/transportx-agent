// Real browser smoke test; intentionally kept outside test/ so npm test stays hermetic.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, diagnostics) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Tau exited during startup (${child.exitCode}).\n${diagnostics()}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Tau health check timed out.\n${diagnostics()}`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-browser-smoke-'));
const agentDir = path.join(tempRoot, 'agent');
const projectDir = path.join(tempRoot, 'project');
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
let serverOutput = '';
const child = spawn(process.execPath, ['bin/tau.js', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: path.join(agentDir, 'sessions'),
    TAU_PROJECTS_DIR: tempRoot,
    TAU_STATIC_DIR: path.resolve('public'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => { serverOutput += chunk; });
child.stderr.on('data', (chunk) => { serverOutput += chunk; });

let browser;
try {
  await waitForHealth(baseUrl, child, () => serverOutput);
  browser = await chromium.launch({ channel: process.env.TAU_BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/legacy/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#status-indicator.connected').waitFor({ timeout: 10_000 });
  await page.locator('#live-tab-add').click();
  await page.locator('#new-live-session-overlay:not(.hidden)').waitFor();
  await page.locator('#new-live-session-name').fill('Browser Smoke');
  await page.locator('#new-live-session-cwd').evaluate((element, value) => { element.value = value; }, projectDir);
  await page.locator('#new-live-session-submit').click();
  await page.locator('.live-tab.active').waitFor({ timeout: 15_000 });
  const title = await page.locator('.live-tab.active .live-tab-title').textContent();
  if (title?.trim() !== 'Browser Smoke') throw new Error(`Unexpected active session title: ${title}`);
  if (pageErrors.length) throw new Error(`Browser page errors:\n${pageErrors.join('\n')}`);
  console.log(`Legacy fallback smoke passed: ${baseUrl}/legacy/, active session “${title?.trim()}”`);
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 4_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
