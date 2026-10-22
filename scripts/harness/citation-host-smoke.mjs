import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { ZipFile } from 'yazl';

export async function citationHostSmoke({ root, endpoint, json, rpc, until, providerInputs }) {
  // The independent Pi-local package must survive ZIP distribution, not just
  // a directory copy. Existing sessions retain their exact earlier version.
  const packageRoot = path.join(root, 'modules/local.traffic-peak/1.0.0');
  const zip = new ZipFile(), archive = path.join(root, 'traffic-peak.zip');
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'manifest.json'), 'utf8'));
  zip.addBuffer(Buffer.from(JSON.stringify({ ...manifest, version: '1.0.1' })), 'local.traffic-peak/1.0.1/manifest.json');
  for (const name of ['index.ts', 'peak.py']) zip.addFile(path.join(packageRoot, name), `local.traffic-peak/1.0.1/${name}`);
  await new Promise((resolve, reject) => { const output = fs.createWriteStream(archive); output.on('close', resolve); output.on('error', reject); zip.outputStream.on('error', reject); zip.outputStream.pipe(output); zip.end(); });
  const inspection = await rpc({ type: 'inspect_module_archive', sourcePath: archive });
  assert.equal(inspection.success, true);
  assert.equal((await rpc({ type: 'install_module_archive', importId: inspection.data.inspection.importId, selections: [{ id: manifest.id, version: '1.0.1' }] })).success, true);
  const session = (await json('/api/live-sessions', { cwd: path.join(root, 'scenario'), model: 'probe/smoke', name: 'P2 Citation acceptance' })).session;
  const snapshot = () => json(`/api/live-sessions/${session.id}/snapshot`);
  const diagnostic = async (sessionId) => (await rpc({ type: 'get_platform_overview', ...(sessionId ? { sessionId } : {}) })).data.modules.find((module) => module.id === 'com.transportx.citation').toolDiagnostics[0];
  assert.equal((await diagnostic()).reason, 'no_session');
  assert.equal((await diagnostic(session.id)).state, 'unverified');
  const results = (state) => state.entries.filter((entry) => entry.message?.role === 'toolResult').map((entry) => entry.message);
  async function execute(input) {
    const before = results(await snapshot()).length;
    await rpc({ type: 'prompt', sessionId: session.id, message: 'citation:' + JSON.stringify(input) });
    const state = await until(async () => { const state = await snapshot(); return !state.isStreaming && results(state).length > before && state; }, 'real Citation result');
    return results(state).at(-1);
  }
  const plan = JSON.parse(fs.readFileSync(path.join(session.cwd, '.tau/resolved-session-plan.json'), 'utf8'));
  assert.equal(plan.modules.find((module) => module.id === manifest.id).version, '1.0.1');
  fs.writeFileSync(path.join(session.cwd, 'volumes.csv'), 'road,hour,volume\nA,08,10\nA,08,20\n');
  await rpc({ type: 'prompt', sessionId: session.id, message: 'traffic:' + JSON.stringify({ inputPath: 'volumes.csv' }) });
  const peak = await until(async () => { const state = await snapshot(); return !state.isStreaming && results(state).length && results(state).at(-1); }, 'ZIP-installed real Pi-local tool');
  assert.equal(peak.isError, false);
  assert.match(fs.readFileSync(path.join(session.cwd, peak.details.output), 'utf8'), /A,08,30/);
  fs.writeFileSync(path.join(session.cwd, 'reference.md'), '# Reference\n\nControlled citation fixture.\n');
  const input = { sources: [{ path: 'reference.md', locator: { kind: 'document', lineStart: 3, lineEnd: 3 }, contentKind: 'excerpt', text: 'Controlled citation fixture.' }] };
  let captured, dropResponse = false, forwarded = 0;
  const relay = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    captured = JSON.parse(raw);
    forwarded++;
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const response = await fetch(endpoint + req.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw, signal: controller.signal });
      if (dropResponse) { await response.text(); res.destroy(); return; }
      res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
    } catch (error) {
      if (!controller.signal.aborted) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(error) })); }
    }
  });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
  try {
    await rpc({ type: 'prompt', sessionId: session.id, message: `/p2_citation_endpoint http://127.0.0.1:${relay.address().port}` });
    const valid = await execute(input);
    assert.equal(valid.isError, false);
    assert.equal(valid.details.kind, 'tau-citations');
    assert.equal(valid.details.citations.version, '3.0');
    assert.equal(valid.details.citations.evidence.length, 1);
    assert.equal((await diagnostic(session.id)).state, 'available', JSON.stringify(await diagnostic(session.id)));
    await rpc({ type: 'prompt', sessionId: session.id, message: '/p2_citation_active off' });
    await rpc({ type: 'prompt', sessionId: session.id, message: 'success' });
    await until(async () => !(await snapshot()).isStreaming, 'native active-tool observation');
    assert.equal((await diagnostic(session.id)).reason, 'inactive');
    await rpc({ type: 'prompt', sessionId: session.id, message: '/p2_citation_active on' });
    const repeated = await execute(input);
    assert.deepEqual(repeated.details.citations.evidence, valid.details.citations.evidence);
    const registry = JSON.parse(fs.readFileSync(path.join(session.cwd, '.tau/citations.json'), 'utf8'));
    assert.equal(registry.evidence.length, 1);
    const registryFile = path.join(session.cwd, '.tau/citations.json');
    const beforeBatch = fs.readFileSync(registryFile);
    const invalidBatch = await execute({ sources: [...input.sources, { path: 'missing.md', locator: { kind: 'source' }, contentKind: 'source-only' }] });
    assert.equal(invalidBatch.isError, true);
    assert.deepEqual(fs.readFileSync(registryFile), beforeBatch, 'invalid later batch input cannot partially register the first source');
    const invalid = await execute({ ...input, webUrls: ['https://example.com/'] });
    assert.equal(invalid.isError, true);
    assert.match(JSON.stringify(invalid.content), /sources and webUrls cannot be combined/);
    const structural = await fetch(endpoint + '/api/internal/citations/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...captured, sources: [{ ...input.sources[0], unexpected: true }], webUrls: undefined }) });
    assert.equal(structural.status, 400, 'Host enforces the same structural schema after tool_call mutation');
    assert.equal((await structural.json()).code, 'tool_input_invalid');
    const incompatible = await fetch(endpoint + '/api/internal/citations/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...captured, ...input, webUrls: undefined, contractVersion: '2.0.0' }) });
    assert.equal(incompatible.status, 409);
    const web = await execute({ webUrls: ['https://citation.fixture.test/citation-fixture'] });
    assert.equal(web.isError, false);
    assert.equal(web.details.citations.sources[0].metadata.url, 'https://citation.fixture.test/citation-fixture');
    fs.writeFileSync(path.join(session.cwd, 'second.md'), 'Second controlled reference.');
    dropResponse = true;
    const beforeForwarded = forwarded;
    const lost = await execute({ sources: [{ path: 'second.md', locator: { kind: 'source' }, contentKind: 'source-only' }] });
    assert.equal(lost.isError, true);
    assert.equal(lost.details.error.code, 'citation_result_unknown');
    assert.equal(forwarded - beforeForwarded, 1);
    dropResponse = false;
    const countBeforeCancel = JSON.parse(fs.readFileSync(path.join(session.cwd, '.tau/citations.json'), 'utf8')).evidence.length;
    assert.equal(countBeforeCancel, 3, 'the newly committed registration survives response loss');
    const beforeCancel = results(await snapshot()).length;
    await rpc({ type: 'prompt', sessionId: session.id, message: 'citation:' + JSON.stringify({ webUrls: ['https://citation.fixture.test/citation-fixture?slow=1'] }) });
    await until(() => fs.existsSync(path.join(root, 'web-fetch-started')), 'production public citation stream');
    await rpc({ type: 'abort', sessionId: session.id });
    await until(async () => { const state = await snapshot(); return !state.isStreaming && results(state).length > beforeCancel; }, 'Citation cancellation result');
    await until(() => fs.existsSync(path.join(root, 'web-fetch-aborted')), 'Host cancellation closes the external response');
    const cancelled = results(await snapshot()).at(-1);
    assert.ok(['citation_cancelled', 'citation_result_unknown'].includes(cancelled.details.error.code));
    assert.equal(JSON.parse(fs.readFileSync(path.join(session.cwd, '.tau/citations.json'), 'utf8')).evidence.length, countBeforeCancel);
    const browser = await chromium.launch({ channel: process.env.TAU_BROWSER_CHANNEL || 'chrome', headless: true });
    try {
      const page = await browser.newPage({ locale: 'zh-CN' });
      await page.goto(endpoint, { waitUntil: 'domcontentloaded' });
      await page.locator('.session-row').filter({ hasText: 'P2 Citation acceptance' }).first().click();
      await page.getByRole('button', { name: '打开设置', exact: true }).click();
      const details = page.getByRole('switch', { name: '显示执行详情', exact: true });
      if (await details.getAttribute('aria-checked') !== 'true') await details.click();
      await page.keyboard.press('Escape');
      await page.locator('.tool-status.unknown').first().waitFor();
      await page.getByRole('button', { name: '能力中心', exact: true }).click();
      const center = page.getByRole('dialog', { name: '能力中心', exact: true });
      await center.locator('.capability-card').filter({ hasText: /引用依据|Citation/ }).first().click();
      await center.locator('[data-tool-state="available"]').waitFor();
      assert.match(await center.locator('.capability-tool-diagnostics').innerText(), /tau_resolve_citation/);
      await page.keyboard.press('Escape');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.tool-status.unknown').first().waitFor();
    } finally { await browser.close(); }
    const modelResults = JSON.stringify(providerInputs.flatMap((request) => request.messages.filter((message) => message.role === 'tool')));
    assert.match(modelResults, /sources and webUrls cannot be combined/);
    return { independentZipUpdateAndExecution: true, productionRegistration: true, liveThreeStateDiagnostics: true, duplicateRegistrationKeepsEvidence: true, mutuallyExclusiveInputRejected: true, undeclaredFieldRejected: true, incompatibleContractRejected: true, controlledExternalWebStream: true, cancellationClosesWebStream: true, committedResponseLossIsUnknown: true, noAutomaticRetry: true, realResultsUiAndReload: true };
  } finally { relay.closeAllConnections(); await new Promise((resolve) => relay.close(resolve)); }
}
