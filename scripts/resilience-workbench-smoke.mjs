import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';
import { protocolHeaders } from './harness/workspace-client.mjs';

// Runs the actual Electron renderer, Agent Host and Pi. The model endpoint is a
// tripwire: the fixed slash command must complete without any provider calls.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-resilience-smoke-'));
const profile = path.join(temp, 'profile');
const evidence = process.argv[2] ? path.resolve(process.argv[2]) : path.join(temp, 'evidence');
fs.mkdirSync(evidence, { recursive: true });
const modelRequests = [];
const model = http.createServer((req, res) => {
  modelRequests.push({ method: req.method, url: req.url });
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Unexpected model request in deterministic demo' } }));
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
let app;
try {
  const executablePath = process.env.TRANSPORTX_RESILIENCE_SMOKE_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath } : { args: ['.'], cwd: process.cwd() }),
    env: { ...process.env, HOME: temp, TAU_USER_DATA_DIR: profile }, timeout: 45_000 });
  const window = await app.firstWindow({ timeout: 45_000 });
  await window.waitForSelector('.workspace-brand', { timeout: 45_000 });
  await window.evaluate(() => localStorage.setItem('tau-locale', 'zh-CN'));
  await window.reload();
  await window.waitForSelector('.workspace-brand', { timeout: 45_000 });
  const origin = new URL(window.url()).origin;
  const healthUrl = origin + '/api/health';
  let health;
  const readyDeadline = Date.now() + 30_000;
  do { health = await (await fetch(healthUrl)).json(); if (health.dataState === 'ready') break; await delay(100); } while (Date.now() < readyDeadline);
  assert.equal(health.dataState, 'ready', JSON.stringify(health));
  const rpc = async body => (await (await fetch(origin + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', ...protocolHeaders }, body: JSON.stringify(body) })).json());
  const added = await rpc({ type: 'add_model', provider: 'resilience-smoke', modelId: 'tripwire', name: 'Resilience smoke tripwire', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, api: 'openai-completions', apiKey: 'test-only-key', contextWindow: 8192, maxTokens: 1024 });
  assert.ok(added.success, JSON.stringify(added));
  const open = window.getByRole('button', { name: '打开工作区', exact: true }).first();
  if (!await open.isVisible()) await window.getByRole('button', { name: '展开或收起会话侧栏', exact: true }).click();
  await open.click();
  const dialog = window.getByRole('dialog', { name: '打开工作区' });
  await dialog.getByRole('button', { name: '创建新文件夹', exact: true }).click();
  await dialog.locator('.workspace-advanced > summary').click();
  await dialog.getByLabel('工作区名称', { exact: true }).fill('Resilience smoke workspace');
  const row = dialog.locator('.session-module-row').filter({ has: window.locator('[title="com.transportx.service-resilience"]') });
  await row.getByText('城市服务韧性', { exact: true }).waitFor({ timeout: 20_000 });
  await row.locator('input[type=checkbox]').check();
  const moduleManifest = JSON.parse(fs.readFileSync('modules/capabilities/service-resilience/manifest.json', 'utf8'));
  assert.equal(await row.locator('select').inputValue(), moduleManifest.version);
  await dialog.getByRole('button', { name: '进入工作区', exact: true }).click();
  const input = window.getByLabel('消息输入');
  await input.waitFor();
  const conversationId = await window.evaluate(() => localStorage.getItem('tau-active-conversation-id'));
  assert.ok(conversationId);
  await input.fill('/resilience-demo');
  await window.getByRole('button', { name: '发送消息', exact: true }).click();
  const snapshotUrl = origin + `/api/conversations/${conversationId}/snapshot`;
  let snapshot, reportPath;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const response = await fetch(snapshotUrl);
    if (response.ok) {
      snapshot = await response.json();
      if (snapshot.runtime?.cwd && fs.existsSync(snapshot.runtime.cwd)) {
        const report = fs.readdirSync(snapshot.runtime.cwd).find(name => /^resilience-.*-report\.md$/.test(name));
        if (report) {
          const candidate = report.slice(0, -'-report.md'.length);
          if (['-report.md', '-pressure.json', '-investigation.json', '-comparison.csv', '-map.geojson'].every(suffix => {
            const file = path.join(snapshot.runtime.cwd, candidate + suffix);
            return fs.existsSync(file) && fs.statSync(file).size > 0;
          })) { reportPath = path.join(snapshot.runtime.cwd, report); break; }
        }
      }
    }
    await delay(250);
  }
  assert.ok(snapshot?.runtime?.id && snapshot.runtime.id !== conversationId, 'Actual Pi runtime was not activated');
  assert.ok(reportPath, 'The real Pi slash command did not write a report; snapshot=' + JSON.stringify(snapshot));
  const stem = path.basename(reportPath).slice(0, -'-report.md'.length);
  assert.match(stem, /^resilience-[0-9a-f]{20}$/);
  const outputs = ['-report.md', '-pressure.json', '-investigation.json', '-comparison.csv', '-map.geojson', '-manifest.json', '-case.json'].map(suffix => path.join(snapshot.runtime.cwd, stem + suffix));
  for (const file of outputs) assert.ok(fs.existsSync(file) && fs.statSync(file).size > 0, `Missing or empty output: ${file}`);
  assert.match(fs.readFileSync(reportPath, 'utf8'), /城市服务中断压力测试/);
  for (const file of outputs.filter(name => name.endsWith('.json') || name.endsWith('.geojson'))) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')), file);
  const reportHeadings = window.getByRole('heading', { name: '城市服务中断压力测试', exact: true });
  await reportHeadings.first().waitFor({ timeout: 30_000 });
  assert.equal(await reportHeadings.count(), 1, 'Live result was duplicated');
  await window.reload();
  await reportHeadings.first().waitFor({ timeout: 30_000 });
  assert.equal(await reportHeadings.count(), 1, 'Stored result was duplicated after reload');
  const dock = window.getByTestId('workspace-dock');
  if (!(await dock.getAttribute('class')).includes('is-open')) await window.getByRole('button', { name: '打开或关闭文件栏', exact: true }).click();
  await dock.getByRole('button', { name: '刷新文件', exact: true }).click();
  await dock.getByRole('button', { name: new RegExp(stem + '-report\\.md') }).click();
  const panel = window.locator('.canvas-panel:not([hidden])');
  await panel.getByText('城市服务中断压力测试', { exact: false }).first().waitFor({ timeout: 30_000 });
  await window.screenshot({ path: path.join(evidence, 'resilience-workbench.png') });
  const downloads = path.join(temp, 'downloads');
  fs.mkdirSync(downloads);
  await app.evaluate(({ app }, directory) => app.setPath('downloads', directory), downloads);
  await panel.getByRole('button', { name: '生成并下载 PDF', exact: true }).click();
  let pdf;
  const pdfDeadline = Date.now() + 45_000;
  while (Date.now() < pdfDeadline) {
    pdf = fs.readdirSync(downloads).find(name => name.toLowerCase().endsWith('.pdf'));
    if (pdf && fs.readFileSync(path.join(downloads, pdf)).subarray(0, 4).toString() === '%PDF') break;
    await delay(250);
  }
  assert.ok(pdf && fs.readFileSync(path.join(downloads, pdf)).subarray(0, 4).toString() === '%PDF', 'PDF export did not complete');
  fs.copyFileSync(path.join(downloads, pdf), path.join(evidence, pdf));
  for (const file of outputs) fs.copyFileSync(file, path.join(evidence, path.basename(file)));
  assert.deepEqual(modelRequests, [], 'Fixed demo unexpectedly called a model provider');
  const pressure = JSON.parse(fs.readFileSync(path.join(snapshot.runtime.cwd, stem + '-pressure.json'), 'utf8'));
  const findScenario = (state, plan) => pressure.scenarios.find(item => item.stateId === state && item.planId === plan);
  for (const [state, plan, shortage, priorityShortage] of [['bridge-and-power-ready', 'shuttle', 0, 0], ['bridge-delayed', 'shuttle', 140, 80], ['bridge-delayed', 'temporary-care', 80, 20]]) {
    const actual = findScenario(state, plan);
    assert.ok(actual, `Missing scenario ${state}/${plan}`);
    assert.deepEqual([actual.shortage, actual.priorityShortage], [shortage, priorityShortage]);
  }
  const investigation = JSON.parse(fs.readFileSync(path.join(snapshot.runtime.cwd, stem + '-investigation.json'), 'utf8'));
  assert.equal(investigation.beforeObservation.recommendedPlanId, 'temporary-care');
  assert.ok(investigation.investigations.find(item => item.investigationId === 'bridge-and-site').improvement.priorityShortage > 0);
  assert.equal(investigation.investigations.find(item => item.investigationId === 'late-inspection').timely, false);
  await input.fill('/resilience-run missing-resilience-case.json');
  await window.getByRole('button', { name: '发送消息', exact: true }).click();
  await window.getByText('城市服务韧性 ·', { exact: false }).first().waitFor({ timeout: 30_000 });
  assert.deepEqual(modelRequests, [], 'Invalid case unexpectedly called a model provider');
  const headingCount = await reportHeadings.count();
  await input.fill('/resilience-run ' + stem + '-case.json');
  await window.getByRole('button', { name: '发送消息', exact: true }).click();
  await window.waitForFunction(({ selector, previous }) => [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(node => node.textContent.trim() === selector).length > previous, { selector: '城市服务中断压力测试', previous: headingCount }, { timeout: 30_000 });
  assert.equal(await reportHeadings.count(), headingCount + 1, 'Valid case run did not produce exactly one new result');
  assert.deepEqual(modelRequests, [], 'Fixed case run unexpectedly called a model provider');
  const beforeWorkflow = new Set(fs.readdirSync(snapshot.runtime.cwd));
  await input.fill('/resilience-workflow');
  await window.getByRole('button', { name: '发送消息', exact: true }).click();
  const workflowHeading = window.getByRole('heading', { name: '城市服务韧性 · 证据到复核', exact: true });
  await workflowHeading.first().waitFor({ timeout: 90_000 });
  let workflowReport, workflowManifest;
  const workflowDeadline = Date.now() + 30_000;
  while (Date.now() < workflowDeadline) {
    const newFiles = fs.readdirSync(snapshot.runtime.cwd).filter(name => !beforeWorkflow.has(name));
    workflowReport = newFiles.find(name => /^resilience-.*-workflow-report\.md$/.test(name));
    workflowManifest = newFiles.find(name => /^resilience-.*-workflow-manifest\.json$/.test(name));
    if (workflowReport && workflowManifest) break;
    await delay(250);
  }
  assert.ok(workflowReport && workflowManifest, 'Workflow did not produce a report and manifest');
  await window.getByText(workflowReport, { exact: false }).first().waitFor({ timeout: 30_000 });
  await window.getByText(workflowManifest, { exact: false }).first().waitFor({ timeout: 30_000 });
  const manifestPath = path.join(snapshot.runtime.cwd, workflowManifest);
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.ok(manifest.provenance && typeof manifest.provenance === 'object', 'Workflow must retain case provenance');
  assert.ok(manifest.inputs && typeof manifest.inputs === 'object', 'Workflow must identify its input provenance');
  const expectedView = { stateId: 'east-closed', planId: 'boost-west', periodId: 'peak' };
  assert.deepEqual(manifest.inputs.view, expectedView);
  for (const key of ['confirmedEvents', 'pendingRows', 'accessLostCohorts', 'sensitivityPoints', 'jointInteractions']) {
    assert.ok(Number.isFinite(manifest.summary?.[key]) && manifest.summary[key] >= 0, `Invalid workflow summary ${key}`);
  }
  assert.ok(manifest.summary.confirmedEvents > 0 && manifest.summary.pendingRows > 0, 'Demo must demonstrate both confirmed and pending evidence');
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  const workflowFiles = ['alignment', 'definition', 'comparison', 'case', 'pressure', 'capacityReport', 'map', 'accessibility', 'routes', 'sensitivity', 'investigation', 'report'];
  for (const key of workflowFiles) {
    const artifact = manifest.files?.[key];
    assert.ok(artifact && typeof artifact.path === 'string' && /^[a-f0-9]{64}$/.test(artifact.sha256), `Invalid ${key} manifest entry`);
    assert.equal(path.basename(artifact.path), artifact.path, `Unexpected workspace artifact path: ${artifact.path}`);
    const file = path.join(snapshot.runtime.cwd, artifact.path);
    const bytes = fs.readFileSync(file);
    assert.ok(bytes.length, `Empty workflow artifact: ${key}`);
    assert.equal(sha256(bytes), artifact.sha256, `Incorrect ${key} digest`);
    if (file.endsWith('.json') || file.endsWith('.geojson')) assert.doesNotThrow(() => JSON.parse(bytes.toString('utf8')), key);
    fs.copyFileSync(file, path.join(evidence, path.basename(file)));
  }
  assert.equal(manifest.files.report.path, workflowReport);
  const readWorkflowJson = key => JSON.parse(fs.readFileSync(path.join(snapshot.runtime.cwd, manifest.files[key].path), 'utf8'));
  const definition = readWorkflowJson('definition');
  const accessibility = readWorkflowJson('accessibility');
  const map = readWorkflowJson('map');
  assert.equal(definition.derived.sha256, manifest.files.case.sha256, 'Workflow did not select the compared case content');
  assert.equal(accessibility.inputs[0].path, manifest.files.case.path, 'Accessibility did not use the compared case');
  assert.deepEqual(accessibility.view, expectedView);
  assert.ok(accessibility.rows.length > 0, 'Accessibility must include cohort results');
  assert.ok(map.features.length > 0, 'Pressure map must include features');
  for (const feature of map.features) assert.deepEqual(
    [feature.properties.state_id, feature.properties.plan_id, feature.properties.period_id],
    [expectedView.stateId, expectedView.planId, expectedView.periodId], 'Map feature has the wrong comparison view');
  const workflowMarkdown = fs.readFileSync(path.join(snapshot.runtime.cwd, workflowReport), 'utf8');
  assert.match(workflowMarkdown, /城市服务韧性\s*·\s*证据到复核/);
  for (const section of ['事件与时段对齐', '方案比较与容量缺口', '网络可达性', '联合敏感性与调查线索']) {
    assert.ok(workflowMarkdown.includes(section), `Missing workflow section: ${section}`);
  }
  fs.copyFileSync(manifestPath, path.join(evidence, workflowManifest));
  assert.equal(await workflowHeading.count(), 1, 'Workflow output was duplicated');
  await window.reload();
  await workflowHeading.first().waitFor({ timeout: 30_000 });
  assert.equal(await workflowHeading.count(), 1, 'Workflow result was duplicated after reload');
  if (!(await dock.getAttribute('class')).includes('is-open')) await window.getByRole('button', { name: '打开或关闭文件栏', exact: true }).click();
  await dock.getByRole('button', { name: '刷新文件', exact: true }).click();
  await dock.getByRole('button', { name: workflowReport, exact: false }).click();
  await panel.getByText('城市服务韧性 · 证据到复核', { exact: false }).first().waitFor({ timeout: 30_000 });
  await window.screenshot({ path: path.join(evidence, 'resilience-workflow-workbench.png') });
  const oldDownloads = new Set(fs.readdirSync(downloads));
  await panel.getByRole('button', { name: '生成并下载 PDF', exact: true }).click();
  let workflowPdf;
  const workflowPdfDeadline = Date.now() + 45_000;
  while (Date.now() < workflowPdfDeadline) {
    workflowPdf = fs.readdirSync(downloads).find(name => !oldDownloads.has(name) && name.toLowerCase().endsWith('.pdf'));
    if (workflowPdf && fs.readFileSync(path.join(downloads, workflowPdf)).subarray(0, 4).toString() === '%PDF') break;
    await delay(250);
  }
  assert.ok(workflowPdf && fs.readFileSync(path.join(downloads, workflowPdf)).subarray(0, 4).toString() === '%PDF', 'Workflow PDF export did not complete');
  fs.copyFileSync(path.join(downloads, workflowPdf), path.join(evidence, workflowPdf));
  const priorWorkflowHeadings = await workflowHeading.count();
  await input.fill('/resilience-workflow');
  await window.getByRole('button', { name: '发送消息', exact: true }).click();
  await window.waitForFunction(({ previous }) => [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(node => node.textContent.trim() === '城市服务韧性 · 证据到复核').length === previous + 1, { previous: priorWorkflowHeadings }, { timeout: 90_000 });
  assert.equal(sha256(fs.readFileSync(manifestPath)), sha256(manifestBytes), 'Repeated workflow changed the manifest');
  assert.deepEqual(modelRequests, [], 'Deterministic workflow unexpectedly called a model provider');
  console.log(JSON.stringify({ conversationId, runtimeId: snapshot.runtime.id, outputs: outputs.map(file => path.join(evidence, path.basename(file))), screenshot: path.join(evidence, 'resilience-workbench.png'), pdf: path.join(evidence, pdf), workflowManifest: path.join(evidence, workflowManifest), workflowScreenshot: path.join(evidence, 'resilience-workflow-workbench.png'), workflowPdf: path.join(evidence, workflowPdf), modelRequests }, null, 2));
} catch (error) {
  if (app) { try { const window = await app.firstWindow(); await window.screenshot({ path: path.join(evidence, 'failure.png') }); } catch {} }
  for (const name of ['desktop.log', 'agent-host.log']) { const file = path.join(profile, 'logs', name); if (fs.existsSync(file)) console.error(fs.readFileSync(file, 'utf8').slice(-5000)); }
  console.error(`Evidence directory: ${evidence}`);
  throw error;
} finally {
  try { await app?.close(); } finally { await new Promise(resolve => model.close(resolve)); if (process.argv[2]) fs.rmSync(temp, { recursive: true, force: true }); }
}
