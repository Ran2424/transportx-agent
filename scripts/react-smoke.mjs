#!/usr/bin/env node
// React/Vite foundation smoke test: verifies the independent /react/ shell,
// the lazy chunk, theme tokens, legacy default entry, and Geo lazy boundary.
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

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-react-smoke-'));
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
    TAU_REACT_STATIC_DIR: path.resolve('dist/web'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => { serverOutput += chunk; });
child.stderr.on('data', (chunk) => { serverOutput += chunk; });

let browser;
try {
  await waitForHealth(baseUrl, child, () => serverOutput);
  browser = await chromium.launch({ channel: process.env.TAU_BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  const legacyPage = await context.newPage();
  const legacyErrors = [];
  legacyPage.on('pageerror', (error) => legacyErrors.push(error.message));
  await legacyPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await legacyPage.locator('#status-indicator.connected').waitFor({ timeout: 10_000 });
  if (legacyErrors.length) throw new Error(`Legacy page errors:\n${legacyErrors.join('\n')}`);

  const reactPage = await context.newPage();
  const reactErrors = [];
  const requestedUrls = [];
  reactPage.on('pageerror', (error) => reactErrors.push(error.message));
  reactPage.on('request', (request) => requestedUrls.push(request.url()));
  await reactPage.goto(`${baseUrl}/react/`, { waitUntil: 'networkidle' });
  await reactPage.locator('[data-testid="react-shell"]').waitFor({ timeout: 10_000 });
  await reactPage.locator('[data-testid="lazy-note"]').waitFor({ timeout: 10_000 });

  const title = await reactPage.locator('#react-hero-title').textContent();
  if (!title?.includes('可回放的工作流')) throw new Error(`Unexpected React shell title: ${title}`);
  const legacyHref = await reactPage.locator('[data-testid="legacy-link"]').getAttribute('href');
  if (legacyHref !== '/') throw new Error(`Legacy fallback link should be /, got ${legacyHref}`);

  await reactPage.locator('.theme-chip[aria-pressed="false"]').first().click();
  const selectedTheme = await reactPage.evaluate(() => document.documentElement.dataset.theme);
  if (!selectedTheme) throw new Error('React theme token was not applied');
  if (requestedUrls.some((url) => url.includes('geo-runtime.js'))) {
    throw new Error('React shell must not request geo-runtime.js');
  }
  if (reactErrors.length) throw new Error(`React page errors:\n${reactErrors.join('\n')}`);

  console.log(`React smoke passed: ${baseUrl}/react/ (theme=${selectedTheme}, legacy=/)`);
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
