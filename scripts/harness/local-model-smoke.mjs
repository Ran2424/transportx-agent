import assert from 'node:assert/strict';
import http from 'node:http';

export async function localModelSmoke(page, baseUrl) {
  let catalog = 'models';
  const server = http.createServer((request, response) => {
    if (request.url !== '/v1/models') { response.writeHead(404).end(); return; }
    if (catalog === 'auth' && request.headers.authorization !== 'Bearer smoke-local-key') { response.writeHead(401).end(); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: catalog === 'empty' ? [] : [{ id: 'smoke-local', name: 'Smoke Local Model' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  let provider;
  try {
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '添加模型', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '模型接入', exact: true });
    await dialog.getByRole('tab', { name: '本地模型', exact: true }).click();
    const endpoint = dialog.getByLabel('服务地址', { exact: true });
    const apiKey = dialog.getByLabel('API Key（可选）', { exact: true });
    const detect = dialog.getByRole('button', { name: '检测连接并获取模型', exact: true });
    const save = dialog.getByRole('button', { name: '保存模型', exact: true });
    assert.equal(await endpoint.inputValue(), '');
    await dialog.locator('.menu-select-trigger', { hasText: '自定义地址' }).click();
    await dialog.getByRole('option', { name: 'Ollama', exact: true }).click();
    assert.equal(await endpoint.inputValue(), 'http://127.0.0.1:11434/v1');
    await dialog.locator('.menu-select-trigger', { hasText: 'Ollama' }).click();
    await dialog.getByRole('option', { name: 'LM Studio', exact: true }).click();
    assert.equal(await endpoint.inputValue(), 'http://127.0.0.1:1234/v1');
    assert.equal(await apiKey.getAttribute('required'), null);
    await endpoint.fill(address);
    assert.equal(await save.isDisabled(), true);
    catalog = 'empty';
    await detect.click();
    await dialog.getByRole('status').filter({ hasText: '没有可用模型' }).waitFor();
    assert.equal(await save.isDisabled(), true);
    catalog = 'auth';
    await detect.click();
    await dialog.getByRole('alert').filter({ hasText: '需要鉴权' }).waitFor();
    await apiKey.fill('smoke-local-key');
    await detect.click();
    await dialog.getByRole('status').filter({ hasText: '发现 1 个模型' }).waitFor();
    assert.equal(await save.isEnabled(), true);
    await apiKey.fill('');
    assert.equal(await save.isDisabled(), true, 'changing credentials invalidates discovery');
    catalog = 'models';
    await detect.click();
    await dialog.locator('.menu-select-trigger', { hasText: 'Smoke Local Model' }).waitFor();
    assert.equal(await endpoint.inputValue(), `${address}/v1`);
    await endpoint.fill(`${address}/v1/`);
    assert.equal(await save.isDisabled(), true, 'changing the endpoint invalidates discovery');
    await detect.click();
    await dialog.getByRole('status').filter({ hasText: '发现 1 个模型' }).waitFor();
    await save.click();
    await dialog.waitFor({ state: 'hidden' });
    const models = await page.request.post(`${baseUrl}/api/rpc`, { data: { type: 'get_available_models' } });
    const added = (await models.json()).data.models.find((model) => model.id === 'smoke-local');
    assert.ok(added, 'the saved local model is available to new sessions');
    provider = added.provider;
    assert.match(provider, /^local-[a-f0-9]{12}$/);
    // Exercise both refresh entry points against controlled partial/transport
    // failures. Native network refresh is covered by the real Pi catalog test.
    const listed = await models.json();
    let refreshMode = 'partial', refreshCalls = 0;
    const refreshRoute = async (route) => {
      const command = route.request().postDataJSON();
      if (command?.type !== 'refresh_models') return route.continue();
      refreshCalls++;
      await route.fulfill({ json: refreshMode === 'partial'
        ? { success: true, data: { models: listed.data.models, errors: [{ provider: 'smoke', message: 'HTTP 503; cached models retained' }] } }
        : { success: false, error: 'test catalog offline' } });
    };
    await page.route('**/api/rpc', refreshRoute);
    await page.getByRole('button', { name: '刷新模型列表', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'HTTP 503' }).waitFor();
    await page.getByText('smoke-local', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: '常规', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '新建交通任务', exact: true }).first().click();
    const newTask = page.getByRole('dialog', { name: '新建交通任务', exact: true });
    await newTask.locator('.menu-select-trigger').first().click();
    await page.getByRole('option').filter({ hasText: 'smoke-local' }).waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '选择模型与思考级别', exact: true }).click();
    const picker = page.getByRole('dialog', { name: '模型与推理', exact: true });
    await picker.locator('.menu-select-trigger').first().click();
    await picker.getByRole('option').filter({ hasText: 'smoke-local' }).click();
    await picker.getByRole('button', { name: '刷新模型列表', exact: true }).click();
    await picker.getByRole('alert').filter({ hasText: 'HTTP 503' }).waitFor();
    await picker.locator('.menu-select-trigger').first().filter({ hasText: 'smoke-local' }).waitFor();
    refreshMode = 'failure';
    await picker.getByRole('button', { name: '刷新模型列表', exact: true }).click();
    await picker.getByRole('alert').filter({ hasText: 'test catalog offline' }).waitFor();
    await picker.locator('.menu-select-trigger').first().filter({ hasText: 'smoke-local' }).waitFor();
    assert.equal(refreshCalls, 3);
    await page.unroute('**/api/rpc', refreshRoute);
    await picker.getByRole('button', { name: '保存', exact: true }).click();
    await picker.waitFor({ state: 'hidden' });
    // Restore the fixture model for the remaining smoke scenarios.
    const live = await (await page.request.get(`${baseUrl}/api/live-sessions`)).json();
    const active = live.sessions.find((item) => item.model?.id === 'smoke-local');
    assert.ok(active, 'saving synchronizes the current session');
    await page.request.post(`${baseUrl}/api/rpc`, { data: { type: 'set_model', sessionId: active.id, provider: 'kimi-coding', modelId: 'k2p7' } });
    console.log('Local model smoke: discovery, refresh in settings/picker, partial/Host errors, selection retention and current-session save passed.');
  } finally {
    if (provider) await page.request.post(`${baseUrl}/api/rpc`, { data: { type: 'delete_model_provider', provider } });
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  }
}
