import assert from 'node:assert/strict';

// Browser-facing publication fixtures exercise request ordering and recovery independently of SUMO.
export async function simulationResourceSmoke(page, firstConversation, secondConversation) {
  const firstRun = 'sim_' + '1'.repeat(32), secondRun = 'sim_' + '2'.repeat(32);
  const networkSha256 = 'a'.repeat(64), createdAt = '2026-11-14T00:00:00Z';
  const runs = new Map([[firstConversation, firstRun], [secondConversation, secondRun]]);
  const failures = new Set(['geometry', 'chunk', 'query']);
  const geometry = { type: 'FeatureCollection', routes: { 'route:road': ['edge'] }, features: [{ type: 'Feature', id: 'edge', properties: { edgeId: 'edge' }, geometry: { type: 'LineString', coordinates: [[121.4, 31.1], [121.41, 31.11]] } }], serviceRoutes: [] };
  const viewport = page.viewportSize();
  const originalTheme = await page.locator('html').getAttribute('data-theme');
  const summary = (runId) => ({ runId, scenarioId: 'scenario_' + 'a'.repeat(32), state: 'running', sourceKind: 'synthetic', modelValidation: 'not_calibrated', createdAt, updatedAt: createdAt, latestComputedTime: 60, availableFrameTime: 60 });
  const lists = (runId) => ({ runs: [{ run: summary(runId), canvas: {
    protocol: 'pi-canvas', version: '1.0', presentationId: 'sim-resource-' + runId,
    adapterId: 'com.transportx.traffic-simulation.canvas', kind: 'simulation', viewId: 'simulation:' + runId,
    revision: 1, operation: 'present', title: '测试仿真 ' + runId.slice(-1), generatedAt: createdAt,
    resources: [{ scope: 'capability', moduleId: 'com.transportx.traffic-simulation', resourceId: runId }],
    payload: { runId, scenarioId: summary(runId).scenarioId, sourceKind: 'synthetic', modelValidation: 'not_calibrated' },
  } }] });
  const frame = time => ({ time, generatedWallNs: 0, vehicles: {} });
  const index = runId => ({ protocol: 'transportx-simulation-index', version: 1, runId, networkSha256, revision: 1, availableTime: 60, computedTime: 60, final: false, chunks: [{ from: 0, sha256: 'b'.repeat(64) }] });
  const block = runId => ({ protocol: 'transportx-simulation-block', version: 1, runId, networkSha256, sequence: 0, start: frame(0), frames: Array.from({ length: 30 }, (_, i) => frame((i + 1) * 2)), sampleSeconds: 2 });
  let releaseLate, startedLate;
  const late = new Promise(resolve => { releaseLate = resolve; });
  const slow = new Promise(resolve => { startedLate = resolve; });
  let holdQuery = false;
  const endpoint = /\/api\/conversations\/([^/]+)\/simulation-runs(?:\/([^/]+)\/(index|geometry|chunks\/\d+|query))?$/;
  const matcher = /\/api\/conversations\/[^/]+\/simulation-runs(?:\/|\?|$)/;
  const handle = async route => {
    const url = new URL(route.request().url()), match = endpoint.exec(url.pathname);
    if (!match || !runs.has(match[1])) return route.fallback();
    const runId = runs.get(match[1]), resource = match[3]?.startsWith('chunks/') ? 'chunk' : match[3];
    if (runId === firstRun && failures.delete(resource)) return route.fulfill({ status: 503, json: { error: 'fixture ' + resource } });
    if (resource === 'query' && runId === firstRun && holdQuery) {
      startedLate();
      await late;
    }
    const output = resource === 'index' ? { run: summary(runId), index: index(runId) }
      : resource === 'chunk' ? { block: block(runId), events: [] }
      : resource === 'geometry' ? geometry
      : resource === 'query' ? { runId, requestedTime: Number(url.searchParams.get('time')), time: Math.floor(Number(url.searchParams.get('time')) / 2) * 2, events: [], countsByState: {} }
      : lists(runId);
    await route.fulfill({ json: output }).catch(error => {
      if (!(resource === 'query' && runId === firstRun && holdQuery)) throw error;
    });
  };
  const viewer = runId => page.locator(`[data-testid="simulation-workspace"][data-run-id="${runId}"]`);
  await page.route(matcher, handle);
  try {
    await page.reload({ waitUntil: 'networkidle' });
    const canvas = page.getByTestId('agent-canvas');
    const openRun = async (runId, name) => {
      await page.locator('.session-row').filter({ hasText: name }).click();
      const tab = canvas.getByRole('tab', { name: '测试仿真 ' + runId.slice(-1), exact: true });
      await tab.waitFor({ state: 'attached' });
      if (!(await canvas.getAttribute('class')).includes('is-open')) await page.getByRole('button', { name: '切换画布', exact: true }).click();
      await tab.click();
      await viewer(runId).waitFor({ state: 'visible' });
    };
    await openRun(firstRun, '会话 A');
    const first = viewer(firstRun);
    const road = first.getByRole('button', { name: '重试路网', exact: true });
    const frames = first.getByRole('button', { name: '重试位置帧', exact: true });
    await page.setViewportSize({ width: 500, height: 740 });
    try {
      for (const theme of ['light', 'dark', 'sand']) {
        await page.locator('html').evaluate((node, value) => { node.dataset.theme = value; }, theme);
        await road.waitFor({ state: 'visible' });
        await frames.focus();
        assert.ok(await frames.evaluate(node => node === document.activeElement));
      }
    } finally {
      if (viewport) await page.setViewportSize(viewport);
      await page.locator('html').evaluate((node, theme) => { if (theme) node.dataset.theme = theme; }, originalTheme);
    }
    await frames.focus();
    await frames.press('Enter');
    const query = first.getByRole('button', { name: '重试对象查询', exact: true });
    await query.waitFor();

    await query.focus();
    await query.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.canvas-context-action')?.disabled);
    await road.waitFor();
    await road.click();
    await first.locator('.maplibregl-canvas').waitFor();
    holdQuery = true;
    const slider = first.getByRole('slider', { name: '仿真观看时刻' });
    await slider.focus();
    await slider.press('End');
    await slow;
    await openRun(secondRun, '会话 B');
    const second = viewer(secondRun);
    await page.waitForFunction((id) => !!document.querySelector(`[data-run-id="${id}"]`)?.getAttribute('data-frame-time'), secondRun);
    releaseLate();
    assert.equal(await second.locator('.simulation-error').count(), 0);
    await second.getByRole('combobox', { name: '回放速度' }).selectOption('16');

    const playback = await second.evaluate(async element => {
      const start = performance.now(), marks = [];
      const observer = new MutationObserver(() => marks.push(Number(element.getAttribute('data-frame-time'))));
      observer.observe(element, { attributes: true, attributeFilter: ['data-frame-time'] });
      [...element.querySelectorAll('button')].find(button => button.textContent === '播放').click();
      await new Promise(resolve => setTimeout(resolve, 850));
      observer.disconnect();
      return { frames: marks.length, elapsedMs: Math.round(performance.now() - start) };
    });
    assert.ok(playback.frames > 0, JSON.stringify(playback));
    console.log('Simulation resource isolation and retry passed. Playback fixture:', JSON.stringify(playback));
  } finally {
    releaseLate();
    await page.unroute(matcher, handle);
  }
}
