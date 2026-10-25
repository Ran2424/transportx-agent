import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function piQueueSmoke(page) {
  const composer = page.getByLabel('消息输入');
  const queue = page.getByRole('region', { name: '等待 Agent 处理', exact: true });
  const rpc = (command) => page.evaluate(async (value) => (await fetch('/api/rpc', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-TransportX-Protocol': '2' }, body: JSON.stringify({ ...value, clientCommandId: crypto.randomUUID() }),
  })).json(), command);
  const snapshot = (id) => page.evaluate(async (value) => (await (await fetch(`/api/conversations/${value}/snapshot`)).json()).snapshot, id);
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  await composer.fill('Pi-queue-lifecycle'); await composer.press('Enter');
  await page.locator('.assistant-message', { hasText: 'Pi 队列测试已就绪。' }).waitFor();
  const conversationId = await page.evaluate(() => localStorage.getItem('tau-active-conversation-id'));
  const sessionId = (await snapshot(conversationId)).session.id;
  const guidance = '只分析早高峰\n保留道路名称与统计口径。';
  for (let index = 0; index < 2; index++) {
    await composer.fill(guidance);
    await page.getByRole('button', { name: '发送引导', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.conversation-composer textarea')?.value === '');
  }
  assert.equal((await rpc({ type: 'follow_up', sessionId, message: '完成后生成报告。' })).success, true);
  await queue.locator('li').nth(2).waitFor();
  assert.deepEqual(await queue.locator('li p').allTextContents(), [guidance, guidance, '完成后生成报告。']);
  assert.deepEqual(await queue.locator('li > span').allTextContents(), ['引导', '引导', '后续']);
  assert.equal(await queue.getByRole('button').count(), 0, 'Pi queues do not expose browser-only cancel controls');
  assert.equal(await page.locator('.queued-prompts > div').count(), 0, 'Pi messages do not enter the browser send queue');
  const before = await snapshot(conversationId);
  assert.deepEqual(before.session.piQueue, { steering: [guidance, guidance], followUp: ['完成后生成报告。'] });

  await page.getByRole('button', { name: '新建工作区和会话', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '新建会话' });
  await dialog.getByLabel('工作区名称', { exact: true }).fill('队列隔离工作区');
  await dialog.getByLabel('会话名称（可选）', { exact: true }).fill('队列隔离会话 B');
  await dialog.getByRole('button', { name: '创建会话', exact: true }).click();
  await page.waitForFunction((id) => localStorage.getItem('tau-active-conversation-id') !== id, conversationId);
  assert.equal(await queue.count(), 0, 'another session does not display this queue');
  await page.locator('.live-tab-select', { hasText: before.session.sessionName }).click();
  await queue.locator('li').nth(2).waitFor();
  await page.reload(); await queue.locator('li').nth(2).waitFor();
  assert.deepEqual(await queue.locator('li p').allTextContents(), [guidance, guidance, '完成后生成报告。'], 'refresh restores the Host snapshot without resending');

  const directory = path.resolve('.plans/pi-rpc-queue/validation');
  fs.mkdirSync(directory, { recursive: true });
  for (const theme of ['light', 'dark', 'sand']) {
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
    await queue.screenshot({ path: path.join(directory, `${theme}.png`), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const sidebar = page.getByRole('button', { name: '展开或收起会话侧栏', exact: true });
  if (await sidebar.getAttribute('aria-pressed') === 'true') await sidebar.click();
  await queue.screenshot({ path: path.join(directory, 'mobile.png'), animations: 'disabled' });
  assert.equal(await queue.evaluate((node) => { const bounds = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)); }), true, 'queue is visible above the mobile composer');
  assert.equal(await queue.evaluate((node) => node.scrollWidth <= node.clientWidth), true, 'queue text fits a narrow screen');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

  fs.writeFileSync(path.join(before.session.cwd, '.tau/queue-release-1'), 'continue');
  await page.locator('.assistant-message', { hasText: '一条引导已处理。' }).waitFor();
  assert.deepEqual(await queue.locator('li p').allTextContents(), [guidance, '完成后生成报告。'], 'consumption removes one duplicate, retaining the next occurrence');
  await page.reload(); await queue.locator('li').nth(1).waitFor();
  assert.deepEqual(await queue.locator('li p').allTextContents(), [guidance, '完成后生成报告。']);
  assert.equal(await page.locator('.user-message', { hasText: '只分析早高峰' }).count(), 1, 'consumed guidance enters conversation once');
  assert.equal((await snapshot(conversationId)).entries.filter((entry) => entry.message?.role === 'user' && entry.message.content?.some?.((block) => block.text === guidance)).length, 1);
  fs.writeFileSync(path.join(before.session.cwd, '.tau/queue-release-2'), 'continue');
  await page.locator('.assistant-message', { hasText: 'Pi 队列消费完成。' }).waitFor();
  await queue.waitFor({ state: 'detached' });
  assert.deepEqual((await snapshot(conversationId)).session.piQueue, { steering: [], followUp: [] });
  await page.reload(); await composer.waitFor();
  assert.equal(await queue.count(), 0, 'refresh after consumption does not resurrect messages');
  assert.equal(await page.locator('.user-message', { hasText: '只分析早高峰' }).count(), 2);
  assert.equal(await page.locator('.user-message', { hasText: '完成后生成报告。' }).count(), 1);
  console.log('Pi queue smoke: guidance/follow-up, duplicates, consumption, session switch, refresh, three themes and narrow layout passed.');
}
