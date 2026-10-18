import assert from 'node:assert/strict';
import path from 'node:path';

export async function moduleLanguageSmoke(page) {
  const overviewResponse = await page.request.post(new URL('/api/rpc', page.url()).href, { data: { type: 'get_platform_overview' } });
  const overview = (await overviewResponse.json()).data;
  const spatial = overview.modules.find((module) => module.id === 'com.transportx.spatial-analysis');
  const legacyData = [
    ['hongqiao-metro-demo', 'hongqiao-metro-demo', '虹桥地铁入口视频与人数示例', 'Hongqiao Metro Entrance Video & Occupancy Demo'],
    ['shanghai-hub-traffic', 'shanghai-hub-traffic', '上海枢纽交通数据', 'Shanghai Hub Traffic Data'],
    ['shanghai-multimodal-data', 'shanghai-multimodal-20260824', '上海多方式交通数据快照', 'Shanghai Multimodal Traffic Snapshot'],
    ['shanghai-transit-gis', 'shanghai-transit-gis', '上海交通 GIS', 'Shanghai Transit GIS'],
    ['shanghaidata', 'shanghai-traffic', '上海体育场活动交通数据', 'Shanghai Stadium Event Traffic Data'],
    ['suishenxing-data', 'suishenxing-observations', '随申行交通业务观测', 'Suishenxing Traffic Observations'],
  ].map(([id, assetId, zh, en]) => ({ id: `com.transportx.${id}`, assetId: `data:${assetId}`, zh, en }));
  const legacyModules = legacyData.map((module) => ({
    id: module.id, name: module.en, version: '1.0.0', type: 'module', origin: 'installed', removable: true, enabled: true, extensions: 0, skills: 1,
    skillFiles: [{ entryPath: 'skill/SKILL.md', name: 'Original Skill heading', description: 'Original English Skill description.', content: '# Original Skill heading' }],
    assets: [{ id: module.assetId, kind: 'data', configured: true, active: true }],
  }));
  overview.modules.push(...legacyModules);
  const optionsResponse = await page.request.get(new URL('/api/platform/session-options', page.url()).href);
  const options = await optionsResponse.json();
  for (const module of options.modules.filter((module) => module.id === 'smoke.alpha')) module.presentation = spatial.presentation;
  options.modules.push(...legacyModules.map((module) => ({ ...module, enabledForNewSessions: true, selectedByDefault: false })));
  const inspection = { importId: 'language-smoke', sourceName: 'bilingual.zip', uncompressedBytes: 1024, modules: [
    { id: 'smoke.bilingual', name: 'Machine module name', version: '1.0.0', type: 'module', status: 'ready', skills: 1, extensions: 0, assets: 0, nativeRuntimes: 0, presentation: spatial.presentation },
    { id: 'smoke.legacy', name: 'Legacy archive module', version: '1.0.0', type: 'module', status: 'ready', skills: 1, extensions: 0, assets: 0, nativeRuntimes: 0 },
    { ...legacyModules[1], status: 'ready', assets: 1, nativeRuntimes: 0 },
  ] };
  const intercept = async (route) => {
    const command = route.request().postDataJSON();
    if (command.type === 'get_platform_overview') return route.fulfill({ json: { success: true, data: overview } });
    if (command.type === 'inspect_module_archive') return route.fulfill({ json: { success: true, data: { inspection } } });
    if (command.type === 'discard_module_archive') return route.fulfill({ json: { success: true } });
    return route.continue();
  };
  await page.route('**/api/rpc', intercept);
  const interceptOptions = (route) => route.fulfill({ json: options });
  await page.route('**/api/platform/session-options', interceptOptions);
  await page.evaluate(() => { window.transportxDesktop = { filePath: () => '/tmp/bilingual-smoke.zip' }; });
  try {
    for (const language of ['en-US', 'zh-CN']) {
      const english = language === 'en-US';
      const text = spatial.presentation.locales[language];
      await page.getByRole('button', { name: /^(打开设置|Open settings)$/, exact: true }).click();
      await page.locator('.settings-navigation-item').filter({ hasText: /^(常规|General)$/ }).click();
      await page.locator('.settings-language-option').filter({ has: page.locator(`input[value="${language}"]`) }).click();
      await page.getByRole('button', { name: english ? 'Modules' : '模块', exact: true }).click();
      const moduleRow = page.locator('.module-row').filter({ hasText: spatial.id });
      assert.equal(await moduleRow.locator('strong').innerText(), text.name);
      assert.equal(await moduleRow.locator('.module-description').innerText(), text.description);
      assert.equal(await moduleRow.locator('.module-feature-summary').innerText(), text.features.join(' · '));
      for (const module of legacyData) assert.equal(await page.locator('.module-row').filter({ hasText: module.id }).locator('strong').innerText(), english ? module.en : module.zh);
      await page.locator('input[type="file"][accept*="zip"]').setInputFiles({ name: 'bilingual.zip', mimeType: 'application/zip', buffer: Buffer.from('mock archive') });
      const preview = page.getByRole('dialog', { name: english ? 'Confirm module installation' : '确认安装模块', exact: true });
      await preview.waitFor();
      assert.equal(await preview.locator('.module-archive-row').first().locator('strong').innerText(), text.name);
      assert.equal(await preview.locator('.module-description').first().innerText(), text.description);
      assert.equal(await preview.locator('.module-feature-summary').first().innerText(), text.features.join(' · '));
      await preview.getByText('Legacy archive module', { exact: true }).waitFor();
      await preview.getByText(english ? legacyData[1].en : legacyData[1].zh, { exact: true }).waitFor();
      await preview.getByRole('button', { name: english ? 'Cancel' : '取消', exact: true }).click();
      await page.locator('.settings-return').click();
      await page.getByRole('button', { name: english ? 'Capability center' : '能力中心', exact: true }).click();
      const center = page.getByRole('dialog', { name: english ? 'Capability center' : '能力中心', exact: true });
      await center.getByRole('textbox', { name: english ? 'Search capabilities' : '搜索能力', exact: true }).fill(english ? '空间分析' : 'Spatial Analysis');
      await center.locator('.capability-card').filter({ has: page.getByText(text.name, { exact: true }) }).click();
      assert.equal(await center.locator('.capability-inspector .capability-description').innerText(), text.description);
      assert.equal(await center.locator('.capability-feature-list').innerText(), text.features.join('\n'));
      const search = center.getByRole('textbox', { name: english ? 'Search capabilities' : '搜索能力', exact: true });
      await search.fill('');
      await center.locator('.capability-filters button').filter({ hasText: english ? /^Data/ : /^数据/ }).click();
      assert.equal(await center.locator('.capability-card').count(), 6);
      for (const module of legacyData) {
        const name = english ? module.en : module.zh;
        const card = center.locator('.capability-card').filter({ has: page.locator('strong', { hasText: name }) });
        await card.click();
        assert.equal(await center.locator('.capability-inspector h2').innerText(), name);
        assert.ok(await center.locator('.capability-feature-list li').count() > 0);
        assert.equal(await center.locator('.capability-resource-list strong').innerText(), name);
        if (!english) assert.match(await center.locator('.capability-inspector .capability-description').innerText(), /[\u4e00-\u9fff]/);
      }
      await search.fill(english ? legacyData[1].zh : legacyData[1].en);
      assert.equal(await center.locator('.capability-card').count(), 1, 'legacy packages are searchable across both languages');
      await center.locator('.capability-card').click();
      await search.fill('');
      if (process.env.TAU_CAPABILITY_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.TAU_CAPABILITY_SCREENSHOT_DIR, `legacy-data-${language}.png`), animations: 'disabled' });
      await center.getByRole('button', { name: english ? 'Close' : '关闭', exact: true }).click();
      await page.getByRole('button', { name: english ? 'New traffic task' : '新建交通任务', exact: true }).first().click();
      const task = page.getByRole('dialog', { name: english ? 'New traffic task' : '新建交通任务', exact: true });
      const disclosure = task.locator('details').filter({ has: page.locator('summary', { hasText: english ? 'Task Modules and versions' : '任务 Module 与版本' }) });
      if (await disclosure.count()) await disclosure.locator('summary').click();
      const row = task.locator('.session-module-row').filter({ has: page.locator('[title="smoke.alpha"]') });
      await row.getByText(text.name, { exact: true }).waitFor();
      assert.ok((await row.innerText()).includes(text.description));
      assert.equal(await row.locator('select').inputValue(), '2.0.0');
      await task.getByRole('checkbox', { name: /^smoke\.beta\b/ }).waitFor();
      for (const module of legacyData) assert.equal(await task.locator(`[title="${module.id}"]`).innerText(), english ? module.en : module.zh);
      await task.getByRole('button', { name: english ? 'Cancel' : '取消', exact: true }).click();
    }
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    await page.getByRole('button', { name: '常规', exact: true }).click();
    await page.locator('.settings-language-option').filter({ has: page.locator('input[value="system"]') }).click();
    await page.locator('.settings-return').click();
  } finally {
    await page.unroute('**/api/rpc', intercept);
    await page.unroute('**/api/platform/session-options', interceptOptions);
    await page.evaluate(() => { delete window.transportxDesktop; });
  }
  console.log('Module language smoke: bilingual catalog, management, archive preview, task choices and legacy fallback passed.');
}
