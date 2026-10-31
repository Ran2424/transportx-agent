#!/usr/bin/env node
// A real corrupt catalog must leave diagnostics reachable without authorizing business writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { protocolHeaders } from './workspace-client.mjs';

const host = spawn(process.execPath, ['scripts/harness/serve-with-fake-pi.mjs', '--blocked-fixture'], { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', errors = '', browser;
host.stdout.on('data', (chunk) => output += chunk);
host.stderr.on('data', (chunk) => errors += chunk);
try {
  const deadline = Date.now() + 15000;
  while (!output.includes('TAU_FAKE_READY ')) {
    if (host.exitCode !== null || Date.now() > deadline) throw new Error(output + errors);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const ready = JSON.parse(output.match(/TAU_FAKE_READY (\{[^\n]+\})/)[1]);
  const catalog = path.join(ready.tempRoot, 'agent/workspaces.json');
  const original = fs.readFileSync(catalog);
  const health = await (await fetch(ready.baseUrl + '/api/health')).json();
  assert.equal(health.dataState, 'blocked');
  assert.equal(health.liveSessionCount, 0);
  assert.equal((await fetch(ready.baseUrl + '/api/workspaces')).status, 503);
  assert.equal((await fetch(ready.baseUrl + '/api/conversations', { method: 'POST', headers: { ...protocolHeaders, 'Content-Type': 'application/json' }, body: '{}' })).status, 503);
  const auth = await fetch(ready.baseUrl + '/api/rpc', { method: 'POST', headers: { ...protocolHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'get_auth' }) });
  assert.equal(auth.status, 200, 'authentication remains available with a blocked catalog');
  browser = await chromium.launch({ channel: process.env.TAU_BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ locale: 'zh-CN' });
  const requests = [], pageErrors = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let openedLogs = 0;
  await page.route('**/api/rpc', async (route) => {
    if (route.request().postDataJSON()?.type !== 'open_logs_directory') return route.continue();
    assert.equal(route.request().headers()['x-transportx-protocol'], '2');
    openedLogs++;
    await route.fulfill({ json: { success: true } }); // Exercise the UI command without opening Finder.
  });
  await page.goto(ready.baseUrl);
  await page.getByText('存储索引需要修复', { exact: true }).waitFor();
  await page.getByRole('button', { name: '打开迁移诊断', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '存储迁移诊断', exact: true });
  const logsResponse = page.waitForResponse((response) => response.url().endsWith('/api/rpc') && response.request().postDataJSON()?.type === 'open_logs_directory');
  await dialog.getByRole('button', { name: '打开日志目录', exact: true }).click();
  assert.equal((await logsResponse).status(), 200);
  assert.equal(openedLogs, 1);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(fs.readFileSync(catalog), original, 'diagnostics never reset corrupt metadata');
  const oldBusiness = requests.filter((url) => /^\/api\/(live-sessions|sessions|session-history|file|files)(?:\/|$)/.test(url));
  assert.deepEqual(oldBusiness, []);
  fs.mkdirSync('.plans/workspace-conversations', { recursive: true });
  fs.writeFileSync('.plans/workspace-conversations/blocked-network.json', JSON.stringify({ dataState: health.dataState, catalogPreserved: true, authenticationAccessible: true, logsAccessible: true, oldBusinessRequests: 0, paths: [...new Set(requests)].sort() }, null, 2));
  console.log('PASS: corrupt global catalog blocks business, preserves its bytes and keeps authenticated migration/log diagnostics reachable');
} catch (error) {
  console.error(output.slice(-3000), errors.slice(-3000));
  throw error;
} finally {
  await browser?.close();
  host.kill('SIGTERM');
  await new Promise((resolve) => host.exitCode !== null ? resolve() : host.once('exit', resolve));
}
