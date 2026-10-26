#!/usr/bin/env node
// Real Host and browser against test-owned 29 healthy + 1 corrupt legacy workspaces.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { browserJson } from './workspace-client.mjs';

const host = spawn(process.execPath, ['scripts/harness/serve-with-fake-pi.mjs', '--upgrade-fixture'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', browser;
host.stdout.on('data', (chunk) => { output += chunk; }); host.stderr.on('data', (chunk) => { output += chunk; });
async function until(check, label) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; if (host.exitCode !== null) throw new Error(output); await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}\n${output.slice(-4000)}`);
}
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  const ready = await until(() => { const line = output.match(/TAU_FAKE_READY (\{[^\n]+\})/); return line && JSON.parse(line[1]); }, 'inventory address');
  const originals = new Map([ready.resumeFile, ready.longHistoryFile, ...ready.upgradeFixtures.map(({ file }) => file)].map((file) => [file, digest(file)]));
  browser = await chromium.launch({ channel: process.env.TAU_BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
  const json = (pathname, body) => browserJson(page, ready.baseUrl, pathname, body);
  const index = await until(async () => { const value = await json('/api/workspaces'); return value.workspaces.filter((item) => item.availability === 'ready').length === 29 && value; }, '29 independently ready workspaces');
  assert.equal(index.workspaces.length, 30);
  const bad = index.workspaces.find((item) => item.availability !== 'ready'); assert.equal(bad.availability, 'blocked');
  const healthyIds = index.workspaces.filter((item) => item.availability === 'ready').map((item) => item.id).sort();
  assert.equal((await json('/api/health')).dataState, 'ready'); assert.notEqual(index.migration.phase, 'complete');
  for (const [file, original] of originals) assert.equal(digest(file), original, 'conversion preserves all Native bytes');
  const urls = [], errors = []; page.on('request', (request) => urls.push(request.url())); page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(ready.baseUrl, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '打开工作区', exact: true }).click();
  const form = page.getByRole('dialog', { name: '打开工作区', exact: true });
  await form.getByRole('button', { name: '创建新文件夹', exact: true }).click();
  await form.locator('.workspace-advanced > summary').click();
  await form.getByLabel('工作区名称', { exact: true }).fill('异常源并存的新工作区');
  await form.getByLabel('会话名称（可选）', { exact: true }).fill('仍可工作的新会话');
  await form.getByRole('button', { name: '进入工作区', exact: true }).click();
  await page.getByLabel('消息输入').waitFor();
  const conversationId = await page.evaluate(() => localStorage.getItem('tau-active-conversation-id'));
  assert.ok(conversationId); assert.equal((await json('/api/health')).liveSessionCount, 0);
  await page.getByLabel('消息输入').fill('基线-happy'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.assistant-message', { hasText: '上海早高峰分析结果' }).waitFor();
  const saved = await json(`/api/conversations/${conversationId}/snapshot`);
  const broken = ready.upgradeFixtures.find((item) => item.corrupt);
  fs.writeFileSync(path.join(broken.cwd, '.tau/canvas-contexts.json'), JSON.stringify([]));
  const report = await json(`/api/migration/items/${bad.migrationItemId}`);
  await json('/api/migration/resolve', { itemId: report.item.id, requestId: crypto.randomUUID(), expectedRevision: report.item.revision, reportDigest: report.reportDigest, action: 'retry' });
  await json('/api/migration/resume', {});
  const repaired = await until(async () => { const value = await json('/api/workspaces'); return value.workspaces.find((item) => item.id === bad.id)?.availability === 'ready' && value; }, 'only the repaired source becomes ready');
  assert.equal(repaired.workspaces.length, 31); assert.equal(repaired.workspaces.filter((item) => healthyIds.includes(item.id)).length, 29);
  assert.equal((await json(`/api/conversations/${conversationId}/snapshot`)).conversation.id, saved.conversation.id, 'source retry keeps the newly created conversation');
  assert.deepEqual(errors, []);
  const oldBusiness = urls.filter((value) => /^\/api\/(live-sessions|sessions|session-history|file|files)(?:\/|$)/.test(new URL(value).pathname));
  assert.deepEqual(oldBusiness, []);
  fs.mkdirSync('.plans/workspace-conversations', { recursive: true });
  fs.writeFileSync('.plans/workspace-conversations/upgrade-network.json', JSON.stringify({ healthy: 29, corrupt: 1, repaired: true, newConversationPreserved: true, oldBusinessRequests: oldBusiness.length, requests: urls.map((value) => new URL(value).pathname) }, null, 2));
  console.log('PASS: 29 healthy + 1 corrupt upgrade, unrelated browser creation/activation/prompt, Native preservation, source-local retry and zero old business requests');
} finally {
  await browser?.close(); host.kill('SIGTERM'); await new Promise((resolve) => host.exitCode !== null ? resolve() : host.once('exit', resolve));
}
