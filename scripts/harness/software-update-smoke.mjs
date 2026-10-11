import assert from 'node:assert/strict';
import fs from 'node:fs';

export async function softwareUpdateSmoke(browser, baseUrl) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.addInitScript(() => {
      const listeners = new Set();
      const state = { currentVersion: '3.22.0', phase: 'available', targetVersion: '3.23.0', releaseNotes: '<script>window.updateNotesExecuted = true</script>\nNew update controls' };
      const emit = (value) => { Object.assign(state, value); for (const listener of listeners) listener({ ...state }); return { ...state }; };
      window.transportxDesktop = { update: {
        getState: async () => ({ ...state }),
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        check: async () => emit({ phase: 'up-to-date' }),
        download: async () => emit({ phase: 'downloaded', percent: 100 }),
        install: async () => emit({ phase: 'downloaded', errorCode: 'host_busy' }),
      } };
      window.updateSmokeEmit = emit;
      window.updateSmokeListeners = () => listeners.size;
    });
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '查看更新', exact: true }).click();
    const panel = page.getByTestId('software-update');
    await panel.getByText('当前版本 3.22.0', { exact: true }).waitFor();
    assert.ok(await panel.locator('pre').textContent().then((value) => value.includes('<script>')));
    assert.equal(await page.evaluate(() => window.updateNotesExecuted), undefined);
    fs.mkdirSync('.plans/software-update/validation', { recursive: true });
    for (const theme of ['light', 'dark', 'sand']) {
      await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
      await panel.screenshot({ path: `.plans/software-update/validation/${theme}.png` });
      const sizes = await panel.locator('button, p, small, pre').evaluateAll((elements) => elements.map((element) => parseFloat(getComputedStyle(element).fontSize)));
      assert.ok(sizes.every((value) => value >= 11));
    }
    await panel.getByRole('button', { name: '下载更新', exact: true }).click();
    await panel.getByRole('button', { name: '重启并更新', exact: true }).click();
    await panel.getByText('仍有任务或文件操作进行中，请等待或自行停止后再试。').waitFor();
    const beforeClose = await page.evaluate(() => window.updateSmokeListeners());
    await page.locator('.settings-return').click();
    assert.equal(await page.evaluate(() => window.updateSmokeListeners()), beforeClose - 1);
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    await panel.getByRole('button', { name: '重启并更新', exact: true }).waitFor();
    await page.evaluate(() => window.updateSmokeEmit({ phase: 'downloading', errorCode: undefined, percent: 37 }));
    await panel.getByText('37%', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('progressbar').getAttribute('value'), '37');
    await page.evaluate(() => window.updateSmokeEmit({ phase: 'error', errorCode: 'download_failed' }));
    await panel.getByRole('button', { name: '下载更新', exact: true }).waitFor();
    console.log('Software update UI passed: notice, notes safety, themes, download, busy refusal, progress, retry and subscription cleanup.');
  } finally { await page.close(); }
}
