import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-count-smoke-'));
const evidence = process.argv[2] ? path.resolve(process.argv[2]) : path.join(profile, 'evidence');
fs.mkdirSync(evidence, { recursive: true });
const batchA = '2024-11-04';
const batchB = '2024-11-11';
const batchC = '2024-11-18';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function verifyFromSource(result) {
  const sources = result.batches.map(batch => {
    const bytes = fs.readFileSync(path.join('data', 'count-comparison', batch.id + '.json'));
    assert.equal(hash(bytes), batch.sha256);
    return JSON.parse(bytes);
  });
  assert.equal(result.rows.length, result.endHour - result.startHour + 1);
  for (const [index, row] of result.rows.entries()) {
    assert.equal(row.hour, result.startHour + index);
    const values = sources.map(source => {
      const matching = source.filter(record => Number(record.date.slice(11, 13)) === row.hour);
      const usable = matching.filter(record => /^(0|[1-9]\d*)$/.test(record.fremont_bridge)).map(record => Number(record.fremont_bridge));
      const sum = usable.length ? usable.reduce((total, value) => total + value, 0) : null;
      return { total: matching.length, valid: usable.length, sum, average: sum === null ? null : sum / usable.length };
    });
    assert.deepEqual(row.values, values);
  }
}

function verifyCsv(csv, result) {
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const [header, ...lines] = csv.slice(1).trimEnd().split('\r\n');
  assert.equal(header, 'series,batch_id,batch_start,batch_end_exclusive,snapshot_sha256,source_url,local_hour,valid_samples,published_samples,count_sum,average_per_valid_record,run_id,engine_version,method_version');
  assert.equal(lines.length, 2 * result.rows.length);
  for (const [index, line] of lines.entries()) {
    const series = index % 2;
    const batch = result.batches[series];
    const row = result.rows[Math.floor(index / 2)];
    const value = row.values[series];
    // The fixed source URLs percent-encode commas. Check every emitted field.
    assert.deepEqual(line.split(',').map(field => field.replace(/^"|"$/g, '')), [
      series === 0 ? 'A' : 'B', batch.id, batch.startDate, batch.endDateExclusive, batch.sha256,
      batch.sourceUrl, String(row.hour).padStart(2, '0') + ':00', String(value.valid), String(value.total),
      String(value.sum ?? ''), String(value.average ?? ''), result.runId, result.engineVersion, result.methodVersion,
    ]);
  }
}

let app;
try {
  const executablePath = process.env.TRANSPORTX_COUNT_SMOKE_EXECUTABLE;
  app = await electron.launch({ ...(executablePath ? { executablePath } : { args: ['.'], cwd: process.cwd() }),
    env: { ...process.env, TAU_USER_DATA_DIR: profile }, timeout: 45_000 });
  const window = await app.firstWindow({ timeout: 45_000 });
  await window.waitForSelector('.workspace-brand', { timeout: 30_000 });
  await window.evaluate(() => localStorage.setItem('tau-locale', 'zh-CN'));
  await window.reload();
  // Choose file destinations in the test while the real Electron download runs.
  await app.evaluate(({ BrowserWindow }, directory) => {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const sender = BrowserWindow.getAllWindows()[0].webContents;
    globalThis.countSmokeDownloads = {};
    sender.session.on('will-download', (_event, item, contents) => {
      if (contents !== sender) return;
      const name = path.basename(item.getFilename());
      const destination = path.join(directory, name);
      if (fs.existsSync(destination)) fs.unlinkSync(destination);
      item.setSavePath(destination);
      item.once('done', (_doneEvent, state) => { globalThis.countSmokeDownloads[name] = state; });
    });
  }, evidence);
  const entry = window.getByRole('button', { name: '数据对比', exact: true });
  await entry.click();
  const dialog = window.getByRole('dialog', { name: '时段数据对比' });
  const a = dialog.getByLabel('数据批次 A');
  const b = dialog.getByLabel('数据批次 B');
  const start = dialog.getByLabel('开始小时');
  const end = dialog.getByLabel('结束小时（含）');
  const run = dialog.getByRole('button', { name: '运行对比' });
  async function compare() {
    const response = window.waitForResponse(item => new URL(item.url()).pathname === '/api/count-comparison' && item.request().method() === 'POST');
    await run.click();
    const actual = await response;
    assert.equal(actual.status(), 200, await actual.text());
    const result = await actual.json();
    assert.match(result.engineVersion, /^v?1\.5\.6$/);
    verifyFromSource(result);
    await dialog.getByRole('heading', { name: '对比明细' }).waitFor();
    return result;
  }
  await a.selectOption(batchA);
  await b.selectOption(batchA);
  assert.equal(await run.isDisabled(), true);
  await b.selectOption(batchB);
  await start.selectOption('20');
  assert.equal(await run.isDisabled(), true);
  await start.selectOption('14');
  await end.selectOption('19');
  const result = await compare();
  assert.deepEqual(result.batches.map(batch => batch.id), [batchA, batchB]);
  assert.deepEqual([result.startHour, result.endHour], [14, 19]);
  const peak = dialog.getByRole('row').filter({ hasText: '17:00' });
  assert.deepEqual(await peak.getByRole('cell').allTextContents(), ['281.71', '7 / 7 条', '193', '7 / 7 条']);
  const canvas = dialog.locator('canvas');
  await canvas.waitFor();
  assert.ok(await canvas.evaluate(element => {
    const data = element.getContext('2d').getImageData(0, 0, element.width, element.height).data;
    let drawn = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index]) drawn += 1;
    return drawn > 500;
  }), 'the chart canvas must contain rendered pixels');
  const resultImage = path.join(evidence, 'transportx-duckdb-workbench.png');
  await window.screenshot({ path: resultImage });
  await dialog.getByRole('button', { name: '下载 CSV' }).click();
  await dialog.getByRole('button', { name: '下载复核清单' }).click();
  const stem = 'fremont-counts-' + result.runId.slice(0, 12);
  const filenames = [stem + '.csv', stem + '.json'];
  const deadline = Date.now() + 12_000;
  while (true) {
    const states = await app.evaluate((_, names) => names.map(name => globalThis.countSmokeDownloads[name]), filenames);
    if (states.every(state => state === 'completed')) break;
    assert.ok(Date.now() < deadline, 'Electron downloads did not complete: ' + JSON.stringify(states));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(evidence, filenames[1]), 'utf8')), result);
  verifyCsv(fs.readFileSync(path.join(evidence, filenames[0]), 'utf8'), result);

  await b.selectOption(batchC);
  assert.equal(await dialog.getByRole('button', { name: '下载 CSV' }).count(), 0);
  await start.selectOption('17');
  await end.selectOption('17');
  const rerun = await compare();
  assert.deepEqual(rerun.batches.map(batch => batch.id), [batchA, batchC]);
  assert.equal(rerun.rows[0].hour, 17);
  assert.notEqual(rerun.runId, result.runId);
  await window.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await window.screenshot({ path: path.join(evidence, 'transportx-duckdb-entry.png') });
  console.log(JSON.stringify({ engine: result.engineVersion, peak: result.rows.find(row => row.hour === 17),
    csv: path.join(evidence, filenames[0]), review: path.join(evidence, filenames[1]), screenshot: resultImage }, null, 2));
} catch (error) {
  for (const name of ['desktop.log', 'agent-host.log']) {
    const log = path.join(profile, 'logs', name);
    if (fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8').slice(-3500));
  }
  throw error;
} finally {
  try { await app?.close(); } finally { fs.rmSync(profile, { recursive: true, force: true }); }
}
