import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function workspaceCleanupSmoke(page) {
  for (const deleteWorkspace of [true, false]) {
    const name = deleteWorkspace ? '工作目录清理验收' : '保留工作目录验收';
    const session = await page.evaluate(async (name) => {
      const response = await fetch('/api/live-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, model: 'kimi-coding/k2p7' }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      return result.session;
    }, name);
    fs.writeFileSync(path.toNamespacedPath(path.join(session.cwd, 'nul')), 'bash error output');
    await page.reload({ waitUntil: 'networkidle' });
    const historyFile = await page.evaluate(async (id) => {
      const { sessions } = await (await fetch('/api/live-sessions')).json();
      return sessions.find((session) => session.id === id)?.sessionFile;
    }, session.id);
    assert.equal(typeof historyFile, 'string');
    assert.ok(fs.existsSync(historyFile));
    await page.locator('.session-row', { hasText: name }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '删除对话', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '删除对话', exact: true });
    const checkbox = dialog.getByRole('checkbox', { name: '同时删除工作目录及其中的全部文件' });
    assert.equal(await checkbox.isChecked(), true, 'workspace cleanup is selected by default');
    await dialog.getByText(`将删除：${session.cwd}`, { exact: true }).waitFor();
    assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth), true, 'the workspace path fits the dialog');
    if (!deleteWorkspace) await checkbox.uncheck();
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/sessions/delete') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '删除对话', exact: true }).click();
    const response = await responsePromise;
    assert.equal(response.status(), 200, await response.text());
    assert.equal(response.request().postDataJSON().deleteWorkspace, deleteWorkspace);
    assert.equal(fs.existsSync(session.cwd), !deleteWorkspace);
    assert.equal(fs.existsSync(historyFile), false);
  }
  console.log('Workspace cleanup smoke: default deletion, reserved-name files, explicit retention and history cleanup passed.');
  const logs = await page.evaluate(async () => {
    const result = await (await fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'get_platform_overview' }) })).json();
    return result.data.storage.logs;
  });
  assert.ok(fs.existsSync(path.join(logs, 'runtime.jsonl')), 'runtime diagnostics survive workspace cleanup');
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await page.getByRole('button', { name: '常规', exact: true }).click();
  await page.getByText(logs, { exact: true }).waitFor();
  if (process.argv.includes('--web')) {
    assert.equal(await page.getByRole('button', { name: '打开日志目录', exact: true }).count(), 0, 'Web does not offer server-side native folder actions');
    await page.keyboard.press('Escape');
    console.log('Web log directory smoke: persistent diagnostics and location retained; native action excluded.');
    return;
  }
  let opened = 0;
  const openLogRoute = async (route) => {
    if (route.request().postDataJSON()?.type !== 'open_logs_directory') return route.continue();
    opened++;
    await route.fulfill({ json: { success: true } });
  };
  await page.route('**/api/rpc', openLogRoute);
  const openResponse = page.waitForResponse((response) => response.url().endsWith('/api/rpc') && response.request().postDataJSON()?.type === 'open_logs_directory');
  await page.getByRole('button', { name: '打开日志目录', exact: true }).click();
  assert.equal((await openResponse).status(), 200);
  await page.waitForFunction(() => !document.querySelector('.storage-list button')?.disabled);
  await page.unroute('**/api/rpc', openLogRoute);
  assert.equal(opened, 1);
  await page.keyboard.press('Escape');
  console.log('Log directory smoke: persistent diagnostics, settings location and open action passed.');
}
