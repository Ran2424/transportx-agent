// Read actual Host-owned SUMO output through the shipped browser kernel.
// The only fault injection delays a real HTTP response without changing bytes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base = new URL(input.baseUrl);
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
for (const reference of [input.current, input.previous]) {
  assert.match(reference.conversationId, /^conv_[a-f0-9-]+$/);
  assert.match(reference.runId, /^sim_[a-f0-9]{32}$/);
}
const root = path.resolve(input.outputRoot); fs.mkdirSync(root, { recursive: true });
const request = async (url, body) => {
  const response = await fetch(new URL(url, base), { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-TransportX-Protocol': '2' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
};
for (const reference of [input.current, input.previous]) {
  const snapshot = await request(`/api/conversations/${reference.conversationId}/snapshot`);
  assert.equal(!!snapshot.runtime?.isStreaming, false, 'Do not interrupt an active model task');
  await request(`/api/conversations/${reference.conversationId}/close`, { stopCurrent: true });
}
const before = await request('/api/health'); assert.equal(before.liveSessionCount, 0);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15_000);
const errors = [], network = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('request', req => network.push({ at: Date.now(), path: new URL(req.url()).pathname }));
const current = input.current, previous = input.previous;
const viewer = (id) => page.locator(`[data-testid="simulation-workspace"][data-run-id="${id}"]`);
const selectView = async (title, runId) => {
  await page.waitForFunction(title => [...document.querySelectorAll('[role="tab"], .canvas-reopen option')].some(node => node.textContent === title), title);
  if (!(await page.getByTestId('agent-canvas').getAttribute('class')).includes('is-open')) await page.getByRole('button', { name: '切换画布', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="agent-canvas"]')?.classList.contains('is-open'));
  const tab = runId ? page.locator(`[id="canvas-tab-simulation:${runId}"]`) : page.getByRole('tab', { name: title, exact: true });
  if (!await tab.count()) await page.locator('.canvas-reopen').selectOption(runId ? `simulation:${runId}` : { label: title });
  else await tab.click();
};
const selectConversation = async (reference) => {
  await page.locator('.session-row').filter({ hasText: reference.name }).click();
  await selectView(reference.title, reference.runId);
  await viewer(reference.runId).waitFor({ state: 'visible' });
  await page.waitForFunction(id => !!document.querySelector(`[data-run-id="${id}"]`)?.getAttribute('data-frame-time'), reference.runId);
};
const seek = async (reference, pageUps) => {
  const slider = viewer(reference.runId).getByRole('slider', { name: '仿真观看时刻' });
  await slider.focus(); await slider.press('Home');
  for (let i = 0; i < pageUps; i++) await slider.press('PageUp');
};
let releaseLate;
let roadRun;
try {
  await page.goto(base.toString(), { waitUntil: 'networkidle' });
  await selectConversation(current);
  await seek(current, 1);
  await page.waitForFunction(id => document.querySelector(`[data-run-id="${id}"]`)?.getAttribute('data-frame-time') === '60', current.runId);
  await viewer(current.runId).getByRole('combobox', { name: '仿真查询对象' }).selectOption('bus-0');
  const actual = await request(`/api/conversations/${current.conversationId}/simulation-runs/${current.runId}/query?time=60&objectId=bus-0`);
  await viewer(current.runId).getByText(`车道沿程 ${actual.vehicle.lanePositionMeters.toFixed(2)} m`, { exact: false }).waitFor();
  await page.screenshot({ path: path.join(root, 'simulation-60s.png') });
  const attached = page.waitForResponse(response => response.url().includes('/canvas-contexts') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '附加当前 Canvas', exact: true }).click();
  const context = (await (await attached).json()).context;
  assert.equal(context.target.time, 60); assert.equal(context.target.objectId, 'bus-0');
  assert.equal(context.selection.query.vehicle.lanePositionMeters, actual.vehicle.lanePositionMeters);
  let viewing;
  if (input.checkViewing) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const memoryBefore = (await cdp.send('Performance.getMetrics')).metrics;
    await viewer(current.runId).getByRole('combobox', { name: '回放速度' }).selectOption('16');
    const playback = await page.evaluate(async (id) => {
      const node = document.querySelector(`[data-run-id="${id}"]`), marks = [], cadence = [];
      const observer = new MutationObserver(() => marks.push({ at: performance.now(), time: Number(node.getAttribute('data-frame-time')) }));
      observer.observe(node, { attributes: true, attributeFilter: ['data-frame-time'] });
      let frame, last;
      const tick = (now) => { if (last) cadence.push(now - last); last = now; frame = requestAnimationFrame(tick); };
      frame = requestAnimationFrame(tick);
      const button = [...node.querySelectorAll('button')].find(item => item.textContent === '播放');
      button.click();
      await new Promise(resolve => setTimeout(resolve, 8000));
      [...node.querySelectorAll('button')].find(item => item.textContent === '暂停观看')?.click();
      cancelAnimationFrame(frame); observer.disconnect();
      return { marks, cadence, explanation: '2 s sampled state at 16× playback; RAF cadence is browser scheduling, not vehicle sample frequency' };
    }, current.runId);
    assert.ok(playback.marks.length >= 40, `Playback stalled: ${playback.marks.length} samples`);
    const memoryAfter = (await cdp.send('Performance.getMetrics')).metrics;
    await selectView(input.geoTitle);
    const panel = page.locator('.canvas-panel:not([hidden])');
    await panel.locator('.geo-map canvas').waitFor();
    const legend = panel.getByRole('region', { name: '地图图例', exact: true });
    await legend.getByRole('button', { name: '图层设置', exact: true }).click();
    const roads = legend.getByRole('checkbox', { name: '道路（4 条边）', exact: true });
    await roads.uncheck(); await roads.check();
    await legend.getByRole('button', { name: '图层设置', exact: true }).click();
    await panel.getByLabel('切换模式').selectOption('viewport');
    await panel.locator('.geo-context-tray').waitFor();
    const draft = await panel.locator('.geo-context-tray').innerText();
    await selectView(current.title, current.runId);
    await seek(current, 2);
    await page.waitForFunction(id => document.querySelector(`[data-run-id="${id}"]`)?.getAttribute('data-frame-time') === '120', current.runId);
    await page.getByRole('tab', { name: input.geoTitle, exact: true }).click();
    assert.equal(await panel.locator('.geo-context-tray').innerText(), draft, 'Simulation playback preserves the ordinary Geo draft');
    assert.ok((await panel.innerText()).includes('rev 9'), 'Simulation never changes the ordinary Geo revision');
    const screenshot = page.waitForResponse(response => response.url().includes('/geo-screenshots') && response.request().method() === 'POST');
    await panel.getByRole('button', { name: '保存截图', exact: true }).click();
    const saved = await screenshot; assert.ok(saved.ok());
    const dataUrl = saved.request().postDataJSON().dataUrl;
    const dimensions = await page.evaluate(url => new Promise(resolve => { const image = new Image(); image.onload = () => resolve({ width: image.width, height: image.height }); image.src = url; }), dataUrl);
    assert.ok(dimensions.width > 300 && dimensions.height > 300);
    fs.writeFileSync(path.join(root, 'ordinary-geo-export.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    const attach = page.waitForResponse(response => response.url().includes('/geo-contexts') && response.request().method() === 'POST');
    await panel.getByRole('button', { name: '附到对话', exact: true }).first().click();
    const geoContext = await (await attach).json();
    await page.screenshot({ path: path.join(root, 'geo-and-simulation.png') });
    viewing = { playback, memoryBefore, memoryAfter, draft, geoContext, screenshot: await saved.json(), dimensions, revision: 9 };
    await selectView(current.title, current.runId);
  }
  if (input.executeRoadProbe || input.executeVisibleProbe) {
    assert.equal(fs.existsSync(path.join(root, 'run-dispatched.json')), false, 'A dispatched probe must be recovered by Run ID, not rerun');
    const original = await request(`/api/conversations/${current.conversationId}/simulation-runs`);
    const existingIds = new Set(original.runs.map(({ run }) => run.runId));
    let accepted;
    const newRun = new Promise(resolve => { accepted = resolve; });
    const notifications = [];
    page.on('websocket', socket => socket.on('framereceived', event => {
      try { const value = JSON.parse(event.payload.toString()); if (value.type === 'simulation_index_updated' && !existingIds.has(value.runId)) { notifications.push({ at: Date.now(), ...value }); accepted(value.runId); } } catch {}
    }));
    await page.addInitScript(() => {
      window.simulationVisibleMarks = [];
      new MutationObserver(() => {
        for (const node of document.querySelectorAll('[data-testid="simulation-workspace"]')) {
          const time = node.getAttribute('data-frame-time');
          if (time && node.getClientRects().length && node.closest('.is-open')) {
            const mark = { at: Date.now(), runId: node.getAttribute('data-run-id'), time: Number(time) };
            const previous = window.simulationVisibleMarks.at(-1);
            if (!previous || previous.runId !== mark.runId || previous.time !== mark.time) window.simulationVisibleMarks.push(mark);
          }
        }
      }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-frame-time'] });
    });
    // Reload before dispatch so the observer owns the actual WebSocket, then
    // submit natural language to the configured real Pi model, not a fixture.
    await page.reload({ waitUntil: 'networkidle' }); await selectConversation(current);
    const prompt = input.executeVisibleProbe
      ? '本轮是新增一次代表规模的可见延迟验收，并非重试未知作业。已有 Run 已确认完成且应保留。请使用明确提供的 representative.json，执行且仅执行一次 600 秒、120 辆背景车、100 名旅客的合成仿真，打开专属 Canvas；保留原输入、普通 Geo 及已有 Run。结果未知时查询原 Run，不补跑，不推断真实收益。'
      : '请对本工作区明确提供的 road-probe.json 纯道路合成样例执行且仅执行一次 600 秒仿真。核对后使用交通仿真能力，保留普通 Geo 与已有 Run，不修改输入、不增加旅客服务、不推断真实收益。若结果未知，只查询原 Run，不补跑。';
    await page.getByLabel('消息输入', { exact: true }).fill(prompt); await page.getByLabel('消息输入', { exact: true }).press('Enter');
    const timeout = new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Real Pi did not accept the road Run within 90 seconds')), 90_000); timer.unref(); });
    const roadId = await Promise.race([newRun, timeout]);
    fs.writeFileSync(path.join(root, 'run-dispatched.json'), JSON.stringify({ runId: roadId, conversationId: current.conversationId }));
    await viewer(roadId).waitFor({ state: 'visible' });
    if (!input.executeVisibleProbe) await page.getByRole('button', { name: '收起画布', exact: true }).click();
    const hiddenAt = Date.now();
    let finished;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const listed = await request(`/api/conversations/${current.conversationId}/simulation-runs`);
      finished = listed.runs.find(({ run }) => run.runId === roadId)?.run;
      const snapshot = await request(`/api/conversations/${current.conversationId}/snapshot`);
      if (finished?.state === 'ended' && !snapshot.runtime?.isStreaming) break;
      assert.notEqual(finished?.state, 'unknown', JSON.stringify(finished));
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(finished?.termination, 'completed', JSON.stringify(finished));
    assert.equal(finished.metrics.road.planned, input.executeVisibleProbe ? 122 : 120);
    if (!input.executeVisibleProbe) assert.equal(finished.metrics.service, undefined);
    await page.waitForTimeout(150);
    assert.equal((await page.getByTestId('agent-canvas').getAttribute('class')).includes('is-open'), !!input.executeVisibleProbe, 'Final real tool_result must preserve viewing state');
    const finishedAt = Date.now();
    const backgroundReads = network.filter(item => item.at > hiddenAt + 50 && item.at < finishedAt && item.path.includes(`/simulation-runs/${roadId}/`));
    if (!input.executeVisibleProbe) assert.equal(backgroundReads.length, 0, JSON.stringify(backgroundReads));
    const final = await request(`/api/conversations/${current.conversationId}/simulation-runs`);
    assert.equal(final.runs.length, original.runs.length + 1, 'The real model dispatched exactly one new road Run');
    const marks = await page.evaluate(() => window.simulationVisibleMarks);
    const index = await request(`/api/conversations/${current.conversationId}/simulation-runs/${roadId}/index`);
    const firstVisible = marks.find(mark => mark.runId === roadId);
    const latency = firstVisible ? firstVisible.at - index.index.chunks[0].publishedWallNs / 1e6 : null;
    if (input.executeVisibleProbe) { assert.ok(latency >= 0 && latency < 1000, `Published state visibility: ${latency} ms`); assert.ok(firstVisible.at < index.index.chunks.at(-1).publishedWallNs / 1e6, 'State is visible before computation finishes'); }
    roadRun = { run: finished, hiddenAt, finishedAt, backgroundReads, notifications, marks, publishedToFirstVisibleMs: latency };
    fs.writeFileSync(path.join(root, 'run-probe.json'), JSON.stringify(roadRun, null, 2));
    await request(`/api/conversations/${current.conversationId}/close`, { stopCurrent: true });
    await selectConversation(current);
  }
  await page.reload({ waitUntil: 'networkidle' });
  await selectConversation(current);
  await seek(current, 1);
  await page.waitForFunction(id => document.querySelector(`[data-run-id="${id}"]`)?.getAttribute('data-frame-time') === '60', current.runId);
  assert.equal((await request('/api/health')).liveSessionCount, 0, 'History and refresh never start Pi');

  // A real old-Run block is fetched before its delivery is delayed.
  let lateStarted;
  const arrived = new Promise(resolve => { lateStarted = resolve; });
  const held = new Promise(resolve => { releaseLate = resolve; });
  const late = {};
  const pattern = `**/simulation-runs/${current.runId}/chunks/18`;
  await page.route(pattern, async route => {
    try {
      const response = await route.fetch(); const bytes = await response.body();
      late.sha256 = crypto.createHash('sha256').update(bytes).digest('hex'); late.bytes = bytes.length;
      lateStarted(); await held;
      try { await route.fulfill({ response }); late.delivered = true; }
      catch { late.cancelled = true; }
    } catch (error) { late.error = String(error); lateStarted(); }
  });
  await seek(current, 3); await arrived;
  await selectConversation(previous);
  releaseLate(); await page.waitForTimeout(150);
  assert.equal(await viewer(previous.runId).isVisible(), true);
  assert.equal(await viewer(previous.runId).getAttribute('data-frame-time'), '0');
  assert.ok(late.sha256, JSON.stringify(late));
  await page.unroute(pattern);
  assert.deepEqual(errors, []);
  assert.equal((await request('/api/health')).liveSessionCount, 0);
  const evidence = { protocol: 'transportx-simulation-canvas-probe', version: 1, scope: 'actual Host/SUMO artifacts, browser rendering/query/context, real Pi road Run while hidden, refresh and delayed real response isolation', current, previous, actualQuery: actual, context, viewing, roadRun, late, network, errors, piBefore: before.liveSessionCount, piAfter: 0 };
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ evidence: path.join(root, 'evidence.json'), lateResponseBytes: late.bytes, historyStartsPi: false }));
} catch (error) {
  fs.writeFileSync(path.join(root, 'layout.json'), JSON.stringify(await page.locator('.agent-main-column, [data-testid="agent-canvas"], .workspace-focus-panel, .conversation-pane').evaluateAll(nodes => nodes.map(node => ({ class: node.className, box: node.getBoundingClientRect().toJSON(), grid: getComputedStyle(node).gridTemplateColumns }))), null, 2));
  await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(root, 'failure.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable'));
  throw error;
} finally { releaseLate?.(); await browser.close(); }
