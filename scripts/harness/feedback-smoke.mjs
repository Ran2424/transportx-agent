import assert from 'node:assert/strict';
import fs from 'node:fs';

export async function feedbackSmoke(page, baseUrl, longHistoryFile, longHistoryCwd) {
  const composer = page.getByLabel('消息输入');
  await composer.fill('反馈-empty-error');
  await composer.press('Enter');
  await page.locator('.model-feedback', { hasText: '供应商认证失败' }).waitFor();
  assert.equal((await page.locator('.conversation-thread').innerText()).includes('smoke-secret-key'), false);
  await page.getByRole('button', { name: '编辑后重新提问' }).last().click();
  await page.waitForFunction(() => document.querySelector('.conversation-composer textarea')?.value === '反馈-empty-error');
  await composer.fill('反馈-partial-error');
  await composer.press('Enter');
  await page.locator('.assistant-message', { hasText: '已生成的部分正文' }).waitFor();
  await page.locator('.model-feedback', { hasText: '供应商限流' }).waitFor();
  await composer.fill('反馈-retry-success');
  await composer.press('Enter');
  await page.getByRole('status', { name: '' }).filter({ hasText: '自动重试 1/3' }).waitFor();
  await page.locator('.assistant-message', { hasText: '重试后的回复成功' }).waitFor();
  assert.equal(await page.getByText('自动重试 1/3', { exact: false }).count(), 0);
  await composer.fill('反馈-cancelled');
  await composer.press('Enter');
  await page.locator('.model-feedback', { hasText: '已取消' }).waitFor();
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.model-feedback', { hasText: '供应商认证失败' }).waitFor();
  const sessions = await (await page.request.get(`${baseUrl}/api/live-sessions`)).json();
  const a = sessions.sessions[0];
  const created = await (await page.request.post(`${baseUrl}/api/live-sessions`, { data: { name: '导航B', model: 'kimi-coding/k2p7' } })).json();
  const b = created.session;
  await page.locator('.live-tab-select', { hasText: '导航B' }).waitFor();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let arrived;
  const started = new Promise((resolve) => { arrived = resolve; });
  const route = async (request) => { arrived(); await held; await request.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'late A failure' }) }); };
  const pattern = `**/api/live-sessions/${a.id}/snapshot`;
  await page.route(pattern, route);
  await page.locator('.live-tab-select').first().click();
  await started;
  await page.locator('.live-tab-select', { hasText: '导航B' }).click();
  await composer.waitFor();
  release();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.live-tab.is-active').innerText(), (await page.locator('.live-tab', { hasText: '导航B' }).innerText()));
  assert.equal(await page.getByText('late A failure', { exact: true }).count(), 0);
  await page.unroute(pattern, route);
  await page.request.delete(`${baseUrl}/api/live-sessions/${b.id}`);
  await page.locator('.live-tab-select').first().click();
  await composer.waitFor();
  const resumed = await (await page.request.post(`${baseUrl}/api/live-sessions/resume`, { data: { filePath: longHistoryFile, cwd: longHistoryCwd, useCurrentConfiguration: true } })).json();
  assert.ok(resumed.session, JSON.stringify(resumed));
  const longTab = page.locator('.live-tab-select', { hasText: resumed.session.sessionName || 'long-history-task' });
  await longTab.waitFor();
  const start = performance.now();
  await longTab.click();
  await page.waitForFunction(() => document.querySelectorAll('.user-message').length === 100 && document.querySelectorAll('.assistant-message').length === 100);
  console.log(`Conversation baseline: 200 messages visible in ${Math.round(performance.now() - start)} ms; DOM nodes ${await page.locator('.conversation-thread *').count()}.`);
  await page.request.delete(`${baseUrl}/api/live-sessions/${resumed.session.id}`);
  await page.locator('.live-tab-select').first().click();
  await composer.waitFor();
  console.log('Feedback smoke: empty/partial errors, safe feedback, retry success, history recovery and late navigation failure passed.');
}

export async function composerSmoke(page, baseUrl) {
  const composer = page.getByLabel('消息输入');
  const a = await page.evaluate(() => localStorage.getItem('tau-active-live-session-id'));
  const sends = [];
  const rejectSend = async (route) => {
    const command = route.request().postDataJSON();
    if (!['prompt', 'steer'].includes(command.type)) return route.continue();
    sends.push(command);
    await route.fulfill({ json: { success: false, error: 'input boundary smoke' } });
  };
  await page.route('**/api/rpc', rejectSend);
  await composer.fill('中文候选词');
  await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  await composer.press('Shift+Enter');
  await page.waitForTimeout(100);
  assert.equal(sends.length, 0, 'composition confirmation and Shift+Enter do not send');
  assert.equal(await composer.inputValue(), '中文候选词\n');
  await composer.press('Enter');
  await page.locator('.composer-error', { hasText: 'input boundary smoke' }).waitFor();
  assert.equal(sends.length, 1, 'ordinary Enter still sends');
  await composer.fill('');
  const rejectUpload = async (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 400, json: { error: 'upload boundary smoke' } })
    : route.continue();
  const failedUploadPattern = `**/api/live-sessions/${a}/attachments*`;
  await page.route(failedUploadPattern, rejectUpload);
  await page.locator('.composer-file-input').setInputFiles({ name: 'failed.txt', mimeType: 'text/plain', buffer: Buffer.from('failed source') });
  await page.locator('.pending-attachment.is-error').waitFor();
  assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), true, 'failed files alone are not deliverable');
  await composer.press('Enter');
  await page.waitForTimeout(100);
  assert.equal(sends.length, 1, 'failed files alone do not send through Enter');
  await composer.fill('有效正文');
  assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isEnabled(), true, 'a failed file does not block valid text');
  await composer.press('Enter');
  await page.waitForFunction(() => document.querySelector('.composer-error')?.textContent === 'input boundary smoke');
  await page.waitForTimeout(100);
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[1].attachmentIds || [], [], 'failed files are excluded from delivery');
  await page.getByRole('button', { name: '移除附件 failed.txt', exact: true }).click();
  await composer.fill('');
  await page.unroute(failedUploadPattern, rejectUpload);
  await page.unroute('**/api/rpc', rejectSend);
  const created = await (await page.request.post(`${baseUrl}/api/live-sessions`, { data: { name: '草稿B', model: 'kimi-coding/k2p7' } })).json();
  const b = created.session;
  let releaseUpload;
  const heldUpload = new Promise((resolve) => { releaseUpload = resolve; });
  const uploadPattern = `**/api/live-sessions/${a}/attachments*`;
  let uploadCount = 0;
  const holdUpload = async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    uploadCount++;
    await heldUpload;
    await route.continue();
  };
  await page.route(uploadPattern, holdUpload);
  await composer.fill('A 会话未发送的草稿');
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '添加附件', exact: true }).focus();
  await page.keyboard.press('Enter');
  await (await picker).setFiles({ name: 'draft-source.md', mimeType: 'text/markdown', buffer: Buffer.from('# 已上传草稿资料\n\n交通资料。') });
  await page.locator('.pending-attachment.is-uploading').waitFor();
  assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), true, 'uploading blocks delivery');
  await page.route('**/api/rpc', rejectSend);
  await composer.press('Enter');
  await page.waitForTimeout(100);
  assert.equal(sends.length, 2, 'uploading blocks Enter as well');
  await page.unroute('**/api/rpc', rejectSend);
  await page.locator('.live-tab-select', { hasText: '草稿B' }).click();
  await composer.waitFor();
  assert.equal(await composer.inputValue(), '', 'B does not inherit A text');
  assert.equal(await page.locator('.pending-attachment').count(), 0, 'B does not inherit A uploads');
  await composer.fill('B 会话独立草稿');
  releaseUpload();
  await page.locator('.live-tab-select').first().click();
  await page.locator('.pending-attachment.is-ready', { hasText: 'draft-source.md' }).waitFor();
  await composer.fill('');
  assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isEnabled(), true, 'ready attachments can be sent without text');
  await page.route('**/api/rpc', rejectSend);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.composer-error', { hasText: 'input boundary smoke' }).waitFor();
  assert.equal(sends.length, 3);
  assert.equal(sends[2].attachmentIds.length, 1, 'attachment-only delivery includes the ready file');
  await page.unroute('**/api/rpc', rejectSend);
  await composer.fill('A 会话未发送的草稿');
  assert.equal(await composer.inputValue(), 'A 会话未发送的草稿');
  const library = page.locator('.session-attachment-library');
  await library.locator('summary').click();
  await library.getByRole('button', { name: '查看已上传文件 draft-source.md', exact: true }).waitFor();
  assert.match(await library.innerText(), /attachments\/att_.*draft-source\.md/);
  await page.getByRole('button', { name: '移除附件 draft-source.md', exact: true }).click();
  assert.equal(await library.getByRole('button', { name: '查看已上传文件 draft-source.md', exact: true }).count(), 1, 'deselecting an input does not delete an uploaded source');
  await page.locator('.live-tab-select', { hasText: '草稿B' }).click();
  await composer.waitFor();
  assert.equal(await composer.inputValue(), 'B 会话独立草稿');
  await page.locator('.session-attachment-library summary').click();
  assert.equal(await page.getByRole('button', { name: '查看已上传文件 draft-source.md', exact: true }).count(), 0, 'uploaded sources remain session-scoped');
  await page.locator('.live-tab-select').first().click();
  await composer.waitFor();
  await page.reload({ waitUntil: 'networkidle' });
  await composer.waitFor();
  assert.equal(await composer.inputValue(), 'A 会话未发送的草稿', 'refresh restores unsent text');
  await library.locator('summary').click();
  await library.getByRole('button', { name: '本轮使用 draft-source.md', exact: true }).click();
  await page.locator('.pending-attachment.is-ready', { hasText: 'draft-source.md' }).waitFor();
  assert.equal(uploadCount, 1, 'reusing a source does not upload it again');
  await library.getByRole('button', { name: '查看已上传文件 draft-source.md', exact: true }).click();
  await page.locator('.document-workspace h1', { hasText: '已上传草稿资料', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭视图：draft-source.md', exact: true }).click();
  const rejectPrompt = async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== 'prompt' || command.sessionId !== a) return route.continue();
    await route.fulfill({ json: { success: false, error: 'smoke prompt rejected' } });
  };
  await page.route('**/api/rpc', rejectPrompt);
  await composer.press('Enter');
  await page.locator('.composer-error', { hasText: 'smoke prompt rejected' }).waitFor();
  assert.equal(await composer.inputValue(), 'A 会话未发送的草稿', 'rejected commands preserve text');
  assert.equal(await page.locator('.pending-attachment.is-ready').count(), 1, 'rejected commands preserve attachment selection');
  await page.unroute('**/api/rpc', rejectPrompt);
  // Audit the delivered attachment through the authoritative snapshot.
  await composer.press('Enter');
  await page.waitForFunction(() => document.querySelector('.conversation-composer textarea')?.value === '');
  assert.equal(await page.evaluate((sessionId) => localStorage.getItem(`tau-composer-draft:${sessionId}`), a), null);
  await page.waitForFunction(async (sessionId) => {
    const response = await fetch(`/api/live-sessions/${sessionId}/snapshot`);
    const snapshot = await response.json();
    return snapshot.entries?.some((entry) => entry.message?.role === 'user' && entry.message?.attachmentIds?.length);
  }, a);
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  let releaseAck, ackArrived, ackSent;
  const heldAck = new Promise((resolve) => { releaseAck = resolve; });
  const ackStarted = new Promise((resolve) => { ackArrived = resolve; });
  const ackFinished = new Promise((resolve) => { ackSent = resolve; });
  const delayPromptAck = async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== 'prompt' || command.sessionId !== a) return route.continue();
    const response = await route.fetch();
    ackArrived(); await heldAck;
    await route.fulfill({ response }); ackSent();
  };
  await page.route('**/api/rpc', delayPromptAck);
  await composer.fill('延迟确认A'); await composer.press('Enter');
  await ackStarted;
  await composer.fill('A 新草稿');
  await page.locator('.live-tab-select', { hasText: '草稿B' }).click();
  await composer.waitFor();
  releaseAck(); await ackFinished;
  await page.waitForTimeout(100);
  assert.equal(await composer.inputValue(), 'B 会话独立草稿', 'late A acknowledgement does not clear B');
  await page.unroute('**/api/rpc', delayPromptAck);
  await page.locator('.live-tab-select').first().click(); await composer.waitFor();
  assert.equal(await composer.inputValue(), 'A 新草稿', 'late acknowledgement preserves text edited after submission');
  await composer.fill('');
  await page.unroute(uploadPattern, holdUpload);
  await page.request.delete(`${baseUrl}/api/live-sessions/${b.id}`);
  await page.reload({ waitUntil: 'networkidle' });
  await composer.waitFor();
  assert.equal(await composer.inputValue(), '', 'successfully sent drafts stay cleared after refresh');
  console.log('Composer smoke: IME events, delivery conditions, isolated drafts/uploads, refresh recovery, source preview/reuse, rejected prompts and late acknowledgement isolation passed.');
}

export async function conversationStyleSmoke(page) {
  const directory = '.plans/style-upgrade-phase-one/validation';
  fs.mkdirSync(directory, { recursive: true });
  const originalTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  const copy = page.locator('.message-copy').last();
  await copy.focus();
  assert.equal(await copy.evaluate((node) => getComputedStyle(node).opacity), '1', 'keyboard focus reveals copy');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await copy.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.message-copy')].at(-1)?.textContent === '已复制');
  const touchContext = await page.context().browser().newContext({ hasTouch: true, storageState: await page.context().storageState() });
  try {
    const touchPage = await touchContext.newPage();
    await touchPage.goto(page.url());
    await touchPage.locator('.message-copy').last().waitFor();
    assert.equal(await touchPage.evaluate(() => matchMedia('(hover: none)').matches), true);
    assert.equal(await touchPage.locator('.message-copy').last().evaluate((node) => getComputedStyle(node).opacity), '1', 'copy remains discoverable without hover');
  } finally { await touchContext.close(); }
  const composer = page.getByLabel('消息输入');
  await composer.fill('对比度检查');
  const evidence = [];
  const failures = [];
  for (const theme of ['light', 'dark', 'sand']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await page.waitForTimeout(180);
    const samples = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d');
      const rgba = (color) => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].map((value) => value / 255); };
      const over = (a, b) => {
        const alpha = a[3] + b[3] * (1 - a[3]);
        return alpha ? [0, 1, 2].map((i) => (a[i] * a[3] + b[i] * b[3] * (1 - a[3])) / alpha).concat(alpha) : [0, 0, 0, 0];
      };
      const pixel = (node, foreground) => {
        let color = foreground ? rgba(getComputedStyle(node).color) : [0, 0, 0, 0];
        for (let current = node; current; current = current.parentElement) {
          const style = getComputedStyle(current);
          color = over(color, rgba(style.backgroundColor)); color[3] *= Number(style.opacity);
        }
        return over(color, [1, 1, 1, 1]);
      };
      const luminance = (color) => color.slice(0, 3).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      return ['.session-row-main small', '.session-row-meta', '.message-attachment-card small', '.tool-duration', '.tool-argument-size', '.tool-output-actions', '.tool-pending', '.tool-read-unavailable', '.citation-marker', '.message-artifacts > header span', '.citation-footer > header span', '.citation-source-heading > span', '.citation-number', '.composer-send:not(:disabled)'].flatMap((selector) => [...document.querySelectorAll(selector)].filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden').map((node) => {
        const a = luminance(pixel(node, true)), b = luminance(pixel(node, false));
        return { selector, size: parseFloat(getComputedStyle(node).fontSize), contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
      }));
    });
    assert.ok(samples.some((sample) => sample.selector === '.composer-send:not(:disabled)'));
    assert.ok(samples.some((sample) => sample.selector === '.citation-footer > header span'), 'real citation counts are checked');
    for (const sample of samples) {
      if (sample.size < 11 || sample.contrast < 4.5) failures.push(`${theme} ${sample.selector}: ${sample.size}px, ${sample.contrast.toFixed(2)}:1`);
    }
    evidence.push({ theme, samples });
    await page.screenshot({ path: `${directory}/conversation-${theme}.png`, animations: 'disabled' });
  }
  fs.writeFileSync(`${directory}/contrast.json`, JSON.stringify(evidence, null, 2));
  assert.deepEqual(failures, [], failures.join('\n'));
  await composer.fill('');
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, originalTheme);
  console.log('Conversation style smoke: keyboard copy, non-hover copy and three-theme rendered text contrast passed.');
}
