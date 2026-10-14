import assert from 'node:assert/strict';
import fs from 'node:fs';

export async function workingDisplaySmoke(page) {
  const directory = '.plans/working-display/validation';
  fs.mkdirSync(directory, { recursive: true });
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  const setting = page.getByRole('switch', { name: '显示执行详情', exact: true });
  assert.equal(await setting.getAttribute('aria-checked'), 'true');
  await setting.click();
  assert.equal(await page.getByRole('switch', { name: '默认展开思考内容' }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.locator('.settings-workspace').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.tool-card').count(), 0, 'compact mode hides tool lists');
  assert.equal(await page.locator('.thinking-block').count(), 0, 'compact mode hides reasoning labels');
  const composer = page.getByLabel('消息输入');
  await composer.fill('Working-验收'); await composer.press('Enter');
  const initial = page.locator('.working-toggle.is-active').last();
  await initial.waitFor();
  await page.waitForTimeout(50);
  assert.ok(await page.locator('.conversation-scroll').evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight <= 1), 'the delayed Working row remains visible to a reader following the bottom');
  assert.equal(await initial.isDisabled(), true, 'waiting before model activity has no empty detail action');
  assert.match(await initial.innerText(), /Working · · ·\s*· \d+\.\d+ 秒/, 'independent timing starts before the first model response');
  const seconds = async (toggle) => Number((await toggle.innerText()).match(/(\d+\.\d+) 秒/)[1]);
  const initialSeconds = await seconds(initial);
  const originalTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const theme of ['light', 'dark', 'sand']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    const style = await initial.locator('.working-label').evaluate((node) => {
      const css = getComputedStyle(node);
      return { gradient: css.backgroundImage, position: css.backgroundPosition, size: css.fontSize, weight: css.fontWeight, opacity: getComputedStyle(node.closest('button')).opacity };
    });
    assert.ok(style.gradient.includes(theme === 'dark' ? '255, 255, 255' : '0, 0, 0'), 'Working uses neutral black/white according to the theme');
    assert.ok(style.gradient.includes('0.12'), 'the moving sweep includes transparency');
    assert.equal(style.size, '14px'); assert.equal(style.weight, '600'); assert.equal(style.opacity, '1');
    await page.waitForTimeout(120);
    assert.notEqual(await initial.locator('.working-label').evaluate((node) => getComputedStyle(node).backgroundPosition), style.position, 'the sweep actually moves');
    await initial.screenshot({ path: `${directory}/active-${theme}.png` });
  }
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, originalTheme);
  assert.ok(await seconds(initial) > initialSeconds, 'waiting for the first response continues counting');
  assert.equal(await page.locator('.compaction-status', { hasText: '等待模型响应' }).count(), 0);
  assert.doesNotMatch(await initial.innerText(), /—/);
  await page.locator('.assistant-prose', { hasText: '我先确认轨道 GIS 资产里线路数据' }).waitFor();
  await page.waitForTimeout(250);
  const toggle = page.locator('.working-toggle').last();
  assert.ok(await seconds(toggle) < await seconds(page.locator('.working-toggle').nth(await page.locator('.working-toggle').count() - 2)), 'the second Working segment starts its own clock instead of accumulating the first segment');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.match(await toggle.innerText(), /Working · · ·/);
  const label = toggle.locator('.working-label');
  assert.equal(await label.evaluate((node) => getComputedStyle(node).animationName), 'working-shimmer', 'active Working uses the gradient animation');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await label.evaluate((node) => getComputedStyle(node).animationName), 'none', 'reduced motion disables the animation');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('.conversation-scroll').evaluate((node) => node.scrollTo({ top: node.scrollHeight, behavior: 'instant' }));
  await page.screenshot({ path: `${directory}/working-active.png` });
  await toggle.focus(); await toggle.press('Enter');
  const group = page.locator('.execution-group').last();
  const read = group.locator('[data-tool-call-id="working-read"]');
  await read.waitFor();
  await read.click();
  await group.locator('.tool-state-label', { hasText: '已完成' }).first().waitFor();
  assert.equal(await toggle.locator('.working-label').evaluate((node) => getComputedStyle(node).animationName), 'working-shimmer', 'Working remains active after the tool ends, while the model is waiting');
  const waitingSeconds = await seconds(toggle);
  await page.waitForTimeout(250);
  assert.ok(await seconds(toggle) > waitingSeconds, 'the independent clock continues between tools and model messages');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'model waiting does not replace the expanded group');
  assert.equal(await page.locator('.compaction-status', { hasText: '等待模型响应' }).count(), 0);
  await page.locator('.assistant-prose', { hasText: 'Working 验收完成' }).waitFor();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'group stays expanded while later tools and thinking join it');
  assert.equal(await group.locator('.tool-card').count(), 3, 'consecutive tools and thinking share one group');
  assert.equal(await group.locator('.thinking-block').count(), 1);
  assert.equal(await read.getAttribute('aria-expanded'), 'true', 'tool detail selection survives group updates');
  assert.match(await toggle.innerText(), /Working\s*· \d+\.\d+ 秒/);
  await toggle.click();
  const completed = await toggle.innerText();
  assert.doesNotMatch(completed, /出错/, 'compact summary omits error labels');
  assert.equal(await toggle.locator('.working-label').evaluate((node) => getComputedStyle(node).animationName), 'none', 'completed activity is static');
  assert.doesNotMatch(await group.innerText(), /smoke-private-error-detail/);
  assert.equal(await page.locator('.tool-card').count(), 0);
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const value of ['light', 'dark', 'sand']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, value);
    await page.locator('.conversation-scroll').evaluate((node) => node.scrollTo({ top: node.scrollHeight, behavior: 'instant' }));
    await page.screenshot({ path: `${directory}/collapsed-${value}.png`, animations: 'disabled' });
  }
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
  await toggle.click();
  assert.equal(await read.getAttribute('aria-expanded'), 'true', 'reopening a group preserves individual tool selection');
  assert.match(await group.locator('.tool-card', { has: page.locator('[data-tool-call-id="working-error"]') }).innerText(), /出错/, 'error status remains available in tool details');
  await group.evaluate((node) => { const viewport = node.closest('.conversation-scroll'); viewport.scrollTo({ top: viewport.scrollTop + node.getBoundingClientRect().top - viewport.getBoundingClientRect().top, behavior: 'instant' }); });
  await page.screenshot({ path: `${directory}/expanded.png`, animations: 'disabled' });
  await page.reload();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  assert.equal(await page.locator('.working-toggle').last().getAttribute('aria-expanded'), 'false', 'refresh restores compact defaults');
  assert.equal(await page.locator('.working-toggle').last().innerText(), completed, 'history reload preserves exact segment timing');
  assert.equal(await page.locator('.assistant-prose', { hasText: '我先确认轨道 GIS 资产里线路数据' }).count(), 1);
  fs.writeFileSync(`${directory}/result.json`, JSON.stringify({ completed, restored: await page.locator('.working-toggle').last().innerText() }, null, 2));
  await composer.fill('Working-旧计时'); await composer.press('Enter');
  await page.locator('.assistant-prose', { hasText: '旧计时记录验收完成。' }).waitFor();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  assert.equal((await page.locator('.working-toggle').last().innerText()).trim(), 'Working', 'missing historical timing omits the separator and placeholder');
  await composer.fill('Working-正文流式'); await composer.press('Enter');
  const streamedBody = page.locator('.assistant-prose', { hasText: '流式正文验收：' }).last();
  await streamedBody.waitFor();
  const partialBody = await streamedBody.innerText();
  assert.ok(!partialBody.includes('最后一部分确认完成。'), 'body appears before the final text/message_end');
  assert.equal(await page.locator('.working-toggle').last().getAttribute('aria-expanded'), 'false', 'body is visible with Working collapsed');
  await page.waitForFunction((length) => {
    const body = [...document.querySelectorAll('.assistant-prose')].find((node) => node.textContent.includes('流式正文验收：'));
    return body && body.textContent.length > length;
  }, partialBody.length);
  assert.equal(await page.locator('.working-toggle').last().getAttribute('aria-expanded'), 'false');
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  assert.match(await streamedBody.innerText(), /最后一部分确认完成。/);
  console.log('Streaming body smoke: visible before message_end, grows across deltas and needs no Working expansion.');
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await page.getByRole('switch', { name: '显示执行详情', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.locator('.settings-workspace').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.working-toggle').count(), 0, 'detailed mode restores the original tool/thinking presentation');
  assert.ok(await page.locator('.tool-card').count() >= 3);
  console.log('Working display smoke: independent prompt clock, model-wait continuity, no missing-time placeholder, moving monochrome/transparent themes, body retained, collapse/reduced motion, keyboard expansion, live/history timing, error details, choices and settings passed.');
}

export async function streamingScrollSmoke(page) {
  if (process.env.TAU_STYLE_STAGE === 'before' || process.env.TAU_STYLE_STAGE === 'tools') return;
  const composer = page.getByLabel('消息输入');
  const viewport = page.locator('.conversation-scroll');
  const reading = page.locator('.assistant-message', { hasText: '阅读验收结束。' }).locator('p').first();
  await composer.fill('样式-滚动'); await composer.press('Enter');
  await page.locator('.assistant-message.is-streaming').waitFor();
  await reading.evaluate((node) => {
    const viewport = node.closest('.conversation-scroll');
    viewport.scrollTo({ top: viewport.scrollTop + node.getBoundingClientRect().top - viewport.getBoundingClientRect().top, behavior: 'instant' });
  });
  const before = await reading.evaluate((node) => node.getBoundingClientRect().top);
  await page.waitForTimeout(600);
  const after = await reading.evaluate((node) => node.getBoundingClientRect().top);
  assert.ok(Math.abs(after - before) < 2, 'streaming does not pull the reader away from earlier text');
  await viewport.evaluate((node) => node.scrollTo({ top: node.scrollHeight, behavior: 'instant' }));
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  await page.waitForTimeout(350);
  const bottomGap = await viewport.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
  assert.ok(bottomGap <= 1, `streaming follows the bottom after the reader returns: ${bottomGap}px`);
  fs.writeFileSync('.plans/style-upgrade-phase-two/validation/scroll.json', JSON.stringify({ before, after, bottomGap }, null, 2));
  console.log(`Streaming scroll smoke: earlier reading stable; final bottom gap ${bottomGap}px.`);
}

export async function toolStateSmoke(page, baseUrl) {
  if (process.env.TAU_STYLE_STAGE === 'before') return;
  const composer = page.getByLabel('消息输入');
  const originalSession = await page.evaluate(() => localStorage.getItem('tau-active-live-session-id'));
  const reading = page.locator('.assistant-message', { hasText: '已生成的部分正文' }).first();
  await composer.fill('样式-工具'); await composer.press('Enter');
  const open = page.locator('.tool-card', { has: page.locator('[data-tool-call-id="style-open"]') });
  const closed = page.locator('.tool-card', { has: page.locator('[data-tool-call-id="style-closed"]') });
  await open.locator('.tool-state-label', { hasText: '准备' }).waitFor();
  assert.equal(await open.getByRole('button').first().getAttribute('aria-expanded'), 'false');
  await open.getByRole('button').first().click();
  await reading.evaluate((node) => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
  const before = await reading.evaluate((node) => node.getBoundingClientRect().top);
  await open.locator('.tool-state-label', { hasText: '执行中' }).waitFor();
  assert.equal(await open.getByRole('button').first().getAttribute('aria-expanded'), 'true', 'preparing choice survives live/history reparenting');
  await open.locator('.tool-state-label', { hasText: '完成' }).waitFor();
  assert.equal(await open.getByRole('button').first().getAttribute('aria-expanded'), 'true', 'completion preserves manual expansion');
  await closed.locator('.tool-state-label', { hasText: '准备' }).waitFor();
  await closed.getByRole('button').first().click();
  await closed.getByRole('button').first().click();
  await reading.evaluate((node) => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await closed.locator('.tool-state-label', { hasText: '执行中' }).waitFor();
  assert.equal(await closed.getByRole('button').first().getAttribute('aria-expanded'), 'false', 'running preserves a manual collapse');
  await page.locator('.assistant-message', { hasText: '样式工具验收完成。' }).waitFor();
  const after = await reading.evaluate((node) => node.getBoundingClientRect().top);
  assert.ok(Math.abs(after - before) < 2, `reading position preserved: ${before} -> ${after}`);
  const failed = page.locator('.tool-card', { has: page.locator('[data-tool-call-id="style-error"]') });
  assert.match(await failed.locator('header').innerText(), /出错/);
  assert.match(await failed.locator('header').innerText(), /custom_tool/);
  assert.doesNotMatch(await failed.locator('header').innerText(), /smoke-private|smoke-secret|private-output/);
  assert.equal(await failed.locator('.tool-card-toggle').getAttribute('aria-expanded'), 'false');
  await open.evaluate((node) => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await page.evaluate(() => { for (let node = document.querySelector('.conversation-pane'); node; node = node.parentElement) node.scrollLeft = 0; });
  await page.screenshot({ path: '.plans/style-upgrade-phase-two/validation/tool-states.png', animations: 'disabled' });
  const created = await (await page.request.post(`${baseUrl}/api/live-sessions`, { data: { name: '工具隔离B', model: 'kimi-coding/k2p7' } })).json();
  const session = created.session;
  await page.locator('.live-tab-select', { hasText: '工具隔离B' }).click();
  await composer.fill('样式-隔离'); await composer.press('Enter');
  const isolated = page.locator('[data-tool-call-id="style-open"]');
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  assert.equal(await isolated.getAttribute('aria-expanded'), 'false', 'the same tool ID in another session has independent state');
  await page.locator('.live-tab-select').first().click();
  await open.locator('.tool-card-toggle').waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('tau-active-live-session-id')), originalSession);
  assert.equal(await open.locator('.tool-card-toggle').getAttribute('aria-expanded'), 'true', 'returning to a session restores manual expansion');
  assert.equal(await closed.locator('.tool-card-toggle').getAttribute('aria-expanded'), 'false');
  await page.request.delete(`${baseUrl}/api/live-sessions/${session.id}`);
  console.log('Tool state smoke: preparing/running/completion, live/history transition, read-above scroll, safe failure summary and session isolation/return passed.');
}

export async function conversationLayoutSmoke(page) {
  await page.evaluate(() => { for (let node = document.querySelector('.conversation-pane'); node; node = node.parentElement) node.scrollLeft = 0; });
  const stage = process.env.TAU_STYLE_STAGE || 'after';
  const directory = `.plans/style-upgrade-phase-two/validation/${stage}`;
  fs.mkdirSync(directory, { recursive: true });
  await page.waitForTimeout(450);
  const composer = page.getByLabel('消息输入');
  const originalTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  const files = page.getByRole('button', { name: '打开或关闭文件栏', exact: true });
  const filesOpen = await files.getAttribute('aria-pressed') === 'true';
  if (filesOpen) await files.click();
  await composer.fill('样式-阅读'); await composer.press('Enter');
  const message = page.locator('.assistant-message', { hasText: '阅读验收结束。' });
  await message.waitFor();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  const measurements = [];
  for (const mode of ['wide', 'narrow']) {
    await page.setViewportSize({ width: 1600, height: 1000 });
    if (mode === 'narrow') {
      await page.locator('.message-artifacts button', { hasText: '引用报告' }).last().click();
      const splitter = page.getByTestId('conversation-resizer');
      await splitter.waitFor();
      await splitter.focus();
      for (let i = 0; i < 10; i++) await splitter.press('ArrowRight');
    }
    await page.waitForTimeout(500);
    for (const theme of ['light', 'dark', 'sand']) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      await page.waitForTimeout(180);
      await message.evaluate((node) => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
      const metrics = await message.evaluate((node) => {
        const thread = node.closest('.conversation-thread');
        const threadStyle = getComputedStyle(thread);
        return {
          messageWidth: node.clientWidth,
          available: thread.clientWidth - parseFloat(threadStyle.paddingLeft) - parseFloat(threadStyle.paddingRight),
          paragraphWidth: node.querySelector('p').clientWidth,
          tableWidth: node.querySelector('.table-wrapper').clientWidth,
          tableScroll: node.querySelector('.table-wrapper').scrollWidth,
          codeWidth: node.querySelector('pre').clientWidth,
          codeScroll: node.querySelector('pre').scrollWidth,
          paddingRight: getComputedStyle(node).paddingRight,
          scrollWidth: node.closest('.conversation-scroll').scrollWidth,
          viewportWidth: node.closest('.conversation-scroll').clientWidth,
        };
      });
      measurements.push({ mode, theme, ...metrics });
      if (stage === 'after') {
        assert.ok(Math.abs(metrics.messageWidth - metrics.available) <= 1, 'Assistant uses the available column');
        assert.equal(metrics.paddingRight, '0px');
        assert.ok(metrics.scrollWidth <= metrics.viewportWidth + 1, 'tables and code do not overflow the conversation');
        assert.ok(metrics.codeScroll > metrics.codeWidth, 'long code scrolls locally');
        if (mode === 'narrow') assert.ok(metrics.tableScroll > metrics.tableWidth, 'wide table scrolls locally');
        if (mode === 'wide') assert.ok(metrics.paragraphWidth < metrics.tableWidth - 100, 'wide tables are independent of the prose reading limit');
      }
      await page.evaluate(() => { for (let node = document.querySelector('.conversation-pane'); node; node = node.parentElement) node.scrollLeft = 0; });
      assert.equal(await page.locator('.workspace-header').evaluate((node) => node.getBoundingClientRect().left), 0, 'comparison screenshot keeps the whole workbench in frame');
      await page.screenshot({ path: `${directory}/${mode}-${theme}.png`, animations: 'disabled' });
    }
  }
  fs.writeFileSync(`${directory}/layout.json`, JSON.stringify(measurements, null, 2));
  await page.getByRole('button', { name: '关闭视图：引用报告', exact: true }).click();
  await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, originalTheme);
  await page.setViewportSize({ width: 1280, height: 900 });
  if (filesOpen) await files.click();
  console.log(`Conversation layout ${stage}: wide/narrow three-theme screenshots and dimensions recorded.`);
}
