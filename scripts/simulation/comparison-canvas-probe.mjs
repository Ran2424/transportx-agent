// Real model-produced paired Runs, shipped browser kernel and frozen report.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base = new URL(input.baseUrl), conversation = input.saved.conversation;
assert.equal(base.hostname, '127.0.0.1');
const root = path.resolve(process.argv[3]); fs.mkdirSync(root);
const request = async (url, body) => {
  const response = await fetch(new URL(url, base), { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-TransportX-Protocol': '2' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
};
const prefix = `/api/conversations/${conversation.id}`;
const snapshot = await request(`${prefix}/snapshot`);
assert.equal(!!snapshot.runtime?.isStreaming, false, 'Never interrupt or repeat the actual model task');
const lastAnswer = snapshot.snapshot.entries.filter(entry => entry.message?.role === 'assistant').at(-1).message.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
const lastCitation = [...lastAnswer.matchAll(/\[\[cite:(e_[a-f0-9]{64})\]\]/g)].at(-1)?.[1];
assert.ok(lastCitation, 'Actual model answer must contain a registered citation');
fs.writeFileSync(path.join(root, 'model-snapshot.json'), JSON.stringify(snapshot));
const resources = (await request(`${prefix}/simulation-runs`)).runs;
assert.equal(resources.length, 6);
const runs = resources.map(value => value.run).sort((a, b) => a.experimentSlot - b.experimentSlot);
assert.ok(runs.every(run => run.state === 'ended' && run.termination === 'completed'));
const experiment = await request(`${prefix}/simulation-experiments/${runs[0].experimentId}`);
assert.equal(experiment.comparison.completePairs, 3); assert.ok(experiment.artifact);
await request(`${prefix}/close`, { stopCurrent: true });
const before = await request('/api/health'); assert.equal(before.liveSessionCount, 0);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15_000);
const errors = [], traffic = [], contexts = [];
let citation;
page.on('pageerror', error => errors.push(String(error)));
page.on('request', req => traffic.push({ at: Date.now(), path: new URL(req.url()).pathname, ...(new URL(req.url()).pathname === '/api/rpc' ? { command: req.postDataJSON()?.type } : {}) }));
const viewer = id => page.locator(`[data-testid="simulation-workspace"][data-run-id="${id}"]`);
const open = async id => {
  if (!(await page.getByTestId('agent-canvas').getAttribute('class')).includes('is-open')) await page.getByRole('button', { name: '切换画布', exact: true }).click();
  const tab = page.locator(`[id="canvas-tab-${id}"]`);
  if (await tab.count()) {
    await tab.focus(); await tab.press('Enter');
    await page.waitForFunction(id => document.getElementById(`canvas-tab-${id}`)?.getAttribute('aria-selected') === 'true', id);
  } else await page.locator('.canvas-reopen').selectOption(id);
};
const seek60 = async run => {
  await open(`simulation:${run.runId}`);
  const slider = viewer(run.runId).getByRole('slider', { name: '仿真观看时刻' });
  await page.waitForFunction(id => document.querySelector(`[data-run-id="${id}"] input[type="range"]`)?.getAttribute('max') === '600', run.runId);
  await slider.focus(); await slider.press('Home'); await slider.press('PageUp');
  await page.waitForFunction(id => document.querySelector(`[data-run-id="${id}"]`)?.getAttribute('data-frame-time') === '60', run.runId);
};
try {
  await page.goto(base.toString(), { waitUntil: 'networkidle' });
  await page.locator('.session-row').filter({ hasText: conversation.name }).click();
  await page.locator(`.assistant-prose [data-citation-id="${lastCitation}"]`).first().waitFor({ state: 'attached' });
  const finalMessage = page.locator('.assistant-message').filter({ has: page.locator(`[data-citation-id="${lastCitation}"]`) }).last();
  assert.equal(await finalMessage.locator('.citation-unavailable').count(), 0);
  await finalMessage.locator(`[data-citation-id="${lastCitation}"]`).first().click();
  const detail = page.getByRole('dialog', { name: '引用依据', exact: true });
  await detail.getByRole('heading', { level: 3 }).waitFor();
  assert.equal(await detail.getByRole('alert').count(), 0);
  citation = { evidenceId: lastCitation, source: await detail.innerText(), download: await detail.getByRole('link', { name: '下载原件', exact: true }).getAttribute('href') };
  await page.screenshot({ path: path.join(root, 'corrected-citation.png') });
  await detail.getByRole('button', { name: '关闭', exact: true }).click();
  const baseline = runs[0], variant = runs[1];
  await seek60(baseline);
  const panel = viewer(baseline.runId);
  for (const id of ['bus-a', 'node:pickup-a', 'route:bus-east']) {
    await panel.getByRole('combobox', { name: '仿真查询对象' }).selectOption(id);
    const query = await request(`${prefix}/simulation-runs/${baseline.runId}/query?time=60&objectId=${encodeURIComponent(id)}`);
    const expected = query.fleet ? `当前载客 ${query.fleet.occupants.length}/${query.fleet.capacity}` : query.node ? `${id} · 候车 ${query.node.waiting}` : `${id} · 车辆`;
    await panel.getByText(expected, { exact: false }).waitFor();
    await page.getByRole('button', { name: '附加当前 Canvas', exact: true }).waitFor();
    const [attached] = await Promise.all([page.waitForResponse(response => response.url().includes('/canvas-contexts') && response.request().method() === 'POST'), page.locator('.canvas-context-action').click()]);
    const context = (await attached.json()).context;
    assert.equal(context.target.time, 60); assert.equal(context.target.objectId, id);
    assert.equal(context.selection.query.runId, baseline.runId);
    assert.deepEqual(context.selection.query, query); contexts.push(context);
    fs.writeFileSync(path.join(root, 'contexts.json'), JSON.stringify(contexts));
  }
  const comparison = panel.getByTestId('simulation-comparison');
  await comparison.getByText('配对实验 · 完整 3/3', { exact: false }).waitFor();
  const tables = comparison.locator('table'); assert.equal(await tables.count(), 2);
  for (let i = 0; i < 3; i++) {
    const pair = experiment.comparison.pairs[i];
    const cells = tables.nth(0).locator('tbody tr').nth(i).locator('td');
    assert.deepEqual(await cells.allTextContents(), [String(pair.seed), '完整', String(pair.delta.completedJourneys), pair.delta.meanHubWaitSeconds.toFixed(2), pair.delta.meanRoadTimeLossSeconds.toFixed(2)]);
    const more = tables.nth(1).locator('tbody tr').nth(i).locator('td');
    assert.deepEqual(await more.allTextContents(), [String(pair.seed), pair.delta.meanAllWaitSeconds.toFixed(2), pair.delta.p90AllWaitSeconds.toFixed(2), String(pair.delta.lastServiceMisses), String(pair.delta.fleetBusyVehicleSeconds)]);
  }
  await page.screenshot({ path: path.join(root, 'comparison-60s.png') });
  await comparison.getByRole('button', { name: '打开冻结比较报告', exact: true }).click();
  const document = page.getByTestId('document-workspace').filter({ visible: true });
  await document.getByRole('heading', { name: '合成交通实验比较', exact: true }).waitFor();
  assert.ok((await document.innerText()).includes(experiment.experimentId));
  assert.ok((await document.innerText()).includes(experiment.artifact.manifestSha256));
  await page.screenshot({ path: path.join(root, 'frozen-report.png') });
  const geoOption = page.locator('.canvas-reopen option[value^="geo:"]').first();
  const geoId = await geoOption.count() ? await geoOption.getAttribute('value') : await page.locator('[role="tab"][id^="canvas-tab-geo:"]').first().getAttribute('id').then(id => id.slice('canvas-tab-'.length));
  await open(geoId);
  const geoPanel = page.locator('.canvas-panel:not([hidden])');
  await geoPanel.getByLabel('切换模式').selectOption('viewport');
  const draft = await geoPanel.locator('.geo-context-tray').innerText();
  await seek60(variant);
  await viewer(variant.runId).getByRole('combobox', { name: '仿真查询对象' }).selectOption('bus-a');
  const variantQuery = await request(`${prefix}/simulation-runs/${variant.runId}/query?time=60&objectId=bus-a`);
  await viewer(variant.runId).getByText(`当前载客 ${variantQuery.fleet.occupants.length}/${variantQuery.fleet.capacity}`, { exact: false }).waitFor();
  await open(geoId); assert.equal(await geoPanel.locator('.geo-context-tray').innerText(), draft);
  await page.screenshot({ path: path.join(root, 'geo-retained.png') });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.session-row').filter({ hasText: conversation.name }).click();
  await page.locator(`.assistant-prose [data-citation-id="${lastCitation}"]`).first().waitFor({ state: 'attached' });
  await seek60(baseline); await viewer(baseline.runId).getByTestId('simulation-comparison').getByText('配对实验 · 完整 3/3', { exact: false }).waitFor();
  const after = await request('/api/health'); assert.equal(after.liveSessionCount, 0);
  assert.deepEqual(errors, []);
  assert.ok(!traffic.some(item => /\/activate$/.test(item.path)), 'History viewing must not activate Pi');
  const evidence = { protocol: 'transportx-comparison-canvas-probe', version: 1, conversationId: conversation.id, experiment, runs, contexts, citation, geoDraftRetained: draft, readonlyHistoryWithoutPi: true, healthBefore: before, healthAfter: after, pageErrors: errors, traffic };
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ completePairs: 3, sameTimeContexts: contexts.length, reportOpened: true, geoRetained: true, noPi: true }));
} catch (error) {
  await page.screenshot({ path: path.join(root, 'failure.png') });
  throw error;
} finally { await browser.close(); }
