import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function capabilitySmoke(page) {
  const opener = page.getByRole('button', { name: '能力中心', exact: true });
  await opener.click();
  const center = page.getByRole('dialog', { name: '能力中心', exact: true });
  const cards = center.locator('.capability-card');
  await cards.first().waitFor();
  assert.ok(await cards.count() > 0);
  assert.equal(await center.locator('.capability-technical').getAttribute('open'), null);
  const search = center.getByRole('textbox', { name: '搜索能力', exact: true });
  await search.fill('no-such-capability-9865');
  await center.getByText('没有匹配的能力', { exact: true }).waitFor();
  assert.equal(await center.locator('.capability-inspector').count(), 0);
  await center.getByRole('button', { name: '重置筛选', exact: true }).click();
  await cards.first().waitFor();
  await cards.filter({ has: page.getByText('空间分析', { exact: true }) }).click();
  await center.getByRole('heading', { name: '功能概览', exact: true }).waitFor();
  assert.equal(await center.getByRole('heading', { name: '当前任务', exact: true }).count(), 0);
  assert.equal(await center.getByRole('heading', { name: '如何使用', exact: true }).count(), 0);
  assert.match(await center.locator('.capability-feature-list').innerText(), /缓冲区|最近设施|关联点与区域/);
  const openedModules = [];
  const interceptOpen = async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== 'open_module_directory') return route.continue();
    openedModules.push(command);
    await route.fulfill({ json: { success: true } });
  };
  await page.route('**/api/rpc', interceptOpen);
  try {
    await center.getByRole('button', { name: '在文件管理器中打开', exact: true }).click();
    assert.deepEqual(openedModules, [{ type: 'open_module_directory', moduleId: 'com.transportx.spatial-analysis' }]);
    assert.equal(await page.getByRole('dialog').count(), 1, 'opening the native folder does not create an internal file browser');
  } finally { await page.unroute('**/api/rpc', interceptOpen); }
  await center.locator('.dialog-heading').hover();

  const originalTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const theme of ['sand', 'light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    assert.equal(await center.evaluate((element) => element.scrollWidth <= element.clientWidth), true, `${theme}: no horizontal overflow`);
    if (process.env.TAU_CAPABILITY_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.TAU_CAPABILITY_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.TAU_CAPABILITY_SCREENSHOT_DIR, `${theme}.png`), animations: 'disabled' });
    }
  }
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, originalTheme);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await center.evaluate((element) => element.getBoundingClientRect().right <= innerWidth && element.scrollWidth <= element.clientWidth), true, 'mobile center fits the viewport');
  assert.equal(await center.locator('.capability-inspector').evaluate((element) => element.scrollWidth <= element.clientWidth), true, 'mobile detail has no horizontal overflow');
  if (process.env.TAU_CAPABILITY_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.TAU_CAPABILITY_SCREENSHOT_DIR, 'mobile.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await center.getByRole('button', { name: '关闭', exact: true }).click();

  const response = await page.request.post(new URL('/api/rpc', page.url()).href, { data: { type: 'get_platform_overview' } });
  const overview = (await response.json()).data;
  const baseModule = { id: 'smoke.presentation', name: '能力展示测试', version: '1.0.0', type: 'module', origin: 'installed', removable: true, enabled: true, extensions: 0, skills: 1,
    skillFiles: [{ entryPath: 'skills/SKILL.md', name: '站点接驳分析', description: '检查站点周边的数据与接驳设施。', content: '# 站点接驳分析\n\nTest source.' }],
    assets: [{ id: 'data:missing-stations', kind: 'data', configured: false, active: false }] };
  overview.modules.push(baseModule, { ...baseModule, id: 'smoke.other-data', name: '其他数据', skills: 0, skillFiles: [], assets: [{ id: 'data:other', kind: 'data', configured: true, active: true }] });
  let failLoad = false;
  let failToggle = true;
  const intercept = async (route) => {
    const command = route.request().postDataJSON();
    if (command.type === 'get_platform_overview') return route.fulfill({ json: failLoad ? { success: false, error: 'load boundary' } : { success: true, data: overview } });
    if (command.type === 'set_module_enabled' && command.moduleId === baseModule.id) {
      if (failToggle) return route.fulfill({ json: { success: false, error: 'toggle boundary' } });
      baseModule.enabled = command.enabled;
      return route.fulfill({ json: { success: true, data: { overview } } });
    }
    return route.continue();
  };
  await page.route('**/api/rpc', intercept);
  try {
    await opener.click();
    await search.fill('站点接驳分析');
    await cards.first().waitFor();
    assert.equal(await cards.count(), 1);
    assert.match(await cards.first().innerText(), /待配置/, 'an unrelated active dataset cannot satisfy a missing asset');
    await center.locator('.capability-inspector .capability-description', { hasText: '检查站点周边的数据与接驳设施。' }).waitFor();
    await center.locator('.capability-technical > summary').click();
    await center.locator('.skill-document > summary').click();
    await center.locator('pre', { hasText: 'Test source.' }).waitFor();
    await center.getByRole('button', { name: '关闭功能', exact: true }).click();
    await center.getByRole('alert').filter({ hasText: 'toggle boundary' }).waitFor();
    failToggle = false;
    await center.getByRole('button', { name: '关闭功能', exact: true }).click();
    await center.getByRole('button', { name: '开启功能', exact: true }).waitFor();
    await center.getByRole('button', { name: '开启功能', exact: true }).click();
    await center.getByRole('button', { name: '关闭功能', exact: true }).waitFor();
    failLoad = true;
    await center.getByRole('button', { name: '刷新能力目录', exact: true }).click();
    await center.getByRole('alert').filter({ hasText: '能力信息读取失败' }).waitFor();
    failLoad = false;
    await center.getByRole('button', { name: '重试', exact: true }).click();
    await cards.first().waitFor();
    await center.getByRole('button', { name: '管理模块与资源', exact: true }).first().click();
    await page.locator('[data-testid="settings-workspace"]').waitFor();
    await page.getByRole('button', { name: /返回工作台/ }).click();
  } finally {
    await page.unroute('**/api/rpc', intercept);
  }
  // Returning from settings remounts the sidebar and reloads real platform state.
  console.log('Capability smoke: module summaries, native folder command, catalog search, resource state, controls, recovery, themes and mobile layout passed.');
}
