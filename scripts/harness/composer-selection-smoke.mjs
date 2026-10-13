import assert from 'node:assert/strict';
import fs from 'node:fs';

export async function prepareComposerContextSmoke(page) {
  const composer = page.getByLabel('消息输入');
  await composer.fill('样式-Canvas上下文'); await composer.press('Enter');
  await page.locator('.canvas-panel:not([hidden]) h1', { hasText: '区域分析报告', exact: true }).waitFor();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭视图：区域分析报告', exact: true }).click();
}

export async function composerSelectionSmoke(page) {
  const directory = '.plans/style-upgrade-phase-three/validation';
  fs.mkdirSync(directory, { recursive: true });
  const composer = page.getByLabel('消息输入');
  const sessionId = await page.evaluate(() => localStorage.getItem('tau-active-live-session-id'));
  const selection = page.getByRole('region', { name: '本次内容', exact: true });
  await page.getByLabel('重新打开成果').selectOption('document:stage-three');
  await page.getByRole('button', { name: '附加当前 Canvas', exact: true }).click();
  await selection.locator('.composer-context-card', { hasText: '区域分析报告' }).waitFor();
  assert.match(await selection.innerText(), /版本 0/);
  assert.equal(await selection.locator('.composer-context-card').count(), 2, 'map and Canvas selections remain distinct');
  assert.equal(await selection.evaluate((node) => node.closest('form') !== null), true, 'selected content belongs to the input surface');
  assert.equal(await page.locator('.session-attachment-library').evaluate((node) => node.closest('form') === null), true, 'historical resources stay outside this message');

  const uploadPattern = `**/api/live-sessions/${sessionId}/attachments*`;
  const rejectFailedFile = async (route) => route.request().method() === 'POST' && route.request().postDataBuffer()?.includes(Buffer.from('stage-three-failed.txt'))
    ? route.fulfill({ status: 400, json: { error: '文件上传失败，请重新选择文件。' } }) : route.continue();
  await page.route(uploadPattern, rejectFailedFile);
  const files = Array.from({ length: 6 }, (_, index) => ({ name: `stage-three-${index}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`交通数据 ${index}`) }));
  await page.locator('.composer-file-input').setInputFiles([...files, { name: 'stage-three-failed.txt', mimeType: 'text/plain', buffer: Buffer.from('failed') }]);
  await selection.locator('.pending-attachment.is-error').waitFor();
  assert.equal(await selection.locator('.pending-attachment.is-ready').count(), 6);
  assert.match(await selection.locator('.pending-attachment.is-error').innerText(), /未包含在本次消息/);
  const list = selection.locator('.composer-selection-list');
  const size = await list.evaluate((node) => ({ height: node.clientHeight, content: node.scrollHeight }));
  assert.ok(size.height <= 180 && size.content > size.height, 'many selections scroll inside a bounded area');
  const lastRemove = page.getByRole('button', { name: '移除附件 stage-three-5.txt', exact: true });
  await lastRemove.focus(); await lastRemove.press('Enter');
  assert.equal(await selection.locator('.pending-attachment.is-ready').count(), 5, 'keyboard removal works inside the scroll area');
  await composer.fill('核对本次附件与上下文');
  assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isEnabled(), true);
  await list.evaluate((node) => node.scrollTop = 0);
  await page.screenshot({ path: `${directory}/selection-files.png`, animations: 'disabled' });
  await list.evaluate((node) => node.scrollTop = node.scrollHeight);
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const value of ['light', 'dark', 'sand']) {
    await page.evaluate((value) => document.documentElement.dataset.theme = value, value);
    await page.screenshot({ path: `${directory}/selection-${value}.png`, animations: 'disabled' });
  }
  await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: viewport.width, height: 650 });
  const inputBox = await composer.boundingBox();
  const sendBox = await page.getByRole('button', { name: '发送消息', exact: true }).boundingBox();
  assert.ok(inputBox?.height >= 34 && sendBox && sendBox.y + sendBox.height <= 650, 'input and send remain visible in a short window');
  await page.screenshot({ path: `${directory}/selection-short.png`, animations: 'disabled' });
  await page.setViewportSize(viewport);
  const commands = [];
  const rejectPrompt = async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== 'prompt') return route.continue();
    commands.push(command);
    await route.fulfill({ json: { success: false, error: 'selection boundary smoke' } });
  };
  await page.route('**/api/rpc', rejectPrompt);
  await composer.press('Enter');
  await page.locator('.composer-error', { hasText: 'selection boundary smoke' }).waitFor();
  assert.equal(commands.length, 1);
  assert.equal(commands[0].attachmentIds.length, 5);
  assert.equal(commands[0].geoContextIds.length, 1);
  assert.equal(commands[0].canvasContextIds.length, 1);
  assert.equal(await selection.locator('.composer-context-card').count(), 2, 'rejection preserves both context types');
  await page.unroute('**/api/rpc', rejectPrompt);
  await page.unroute(uploadPattern, rejectFailedFile);
  await page.getByRole('button', { name: '移除附件 stage-three-failed.txt', exact: true }).click();
  await page.getByRole('button', { name: '关闭视图：区域分析报告', exact: true }).click();
  await page.getByRole('tab', { name: 'Geo 交互验收地图', exact: true }).click();
  fs.writeFileSync(`${directory}/selection.json`, JSON.stringify({ size, deliveredAttachments: commands[0].attachmentIds.length, geoContexts: commands[0].geoContextIds.length, canvasContexts: commands[0].canvasContextIds.length }, null, 2));
  console.log('Composer selection smoke: bounded multiple files, excluded failure, keyboard removal, real map/Canvas title, rejected delivery, themes and short window passed.');
}
