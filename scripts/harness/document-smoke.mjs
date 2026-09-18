import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export async function documentSmoke(page, browser) {
  const session = await page.evaluate(async () => (await (await fetch('/api/live-sessions')).json()).sessions[0]);
  const cwd = session.cwd;
  const composer = page.getByLabel('消息输入');
  const canvas = page.locator('[data-testid=agent-canvas]');
  const reader = page.locator('.canvas-panel:not([hidden]) [data-testid=document-workspace]');
  const dock = page.locator('[data-testid=workspace-dock]');
  const report = '# Canvas 报告\n\n![图表](canvas-chart.svg)\n\n$$q=kv$$\n\n```mermaid\ngraph LR\n A-->B\n```\n\n```text\n$literal$\n```\n\n| 路段 | 流量 |\n| --- | --- |\n| A | 12 |\n\n[[cite:canvas:pdf:2]]\n\n' + Array.from({ length: 40 }, (_, i) => `## 章节 ${i + 1}\n\n交通分析内容 ${i + 1}。\n`).join('\n') + '\n## 结论\n\n报告结论。\n\n```mermaid\n<img src=x onerror="window.documentAttack=true">\n```';
  const source = '# 规范\n\n' + Array.from({ length: 30 }, (_, i) => `段落 ${i + 1}。\n\n`).join('') + '## 目标标题\n\n定位到此处。\n\n## 重复\n\n一。\n\n## 重复\n\n二。';
  fs.writeFileSync(path.join(cwd, 'canvas-report.md'), report);
  fs.writeFileSync(path.join(cwd, 'canvas-source.md'), source);
  fs.writeFileSync(path.join(cwd, 'canvas-chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50"><rect width="200" height="50" fill="teal"/></svg>');
  fs.writeFileSync(path.join(cwd, 'canvas-current.md'), '# 当前文件\n\n初始内容。');
  fs.writeFileSync(path.join(cwd, 'canvas-slow.md'), '# 慢请求旧内容');
  const pdfPage = await browser.newPage();
  await pdfPage.setContent('<style>section { break-after:page; height:800px; font:48px sans-serif; } section:last-child {break-after:auto}</style>' + ['#bce8d5', '#c9ddf9', '#ffd2b5'].map((color, index) => `<section style="background:${color}">CANVAS PDF PAGE ${index + 1}</section>`).join(''));
  const pdf = await pdfPage.pdf({ format: 'A4', printBackground: true });
  await pdfPage.close();
  fs.writeFileSync(path.join(cwd, 'canvas-evidence.pdf'), pdf);
  const resource = (id, name, scope, bytes, mimeType) => ({ resourceId: id, workId: id, kind: mimeType === 'application/pdf' ? 'pdf' : 'document', scope, relativePath: name, mimeType, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  const resources = [resource('canvas:report', 'canvas-report.md', 'artifact', report, 'text/markdown'), resource('canvas:source', 'canvas-source.md', 'attachment', source, 'text/markdown'), resource('canvas:pdf', 'canvas-evidence.pdf', 'attachment', pdf, 'application/pdf')];
  const locators = [
    { locatorId: 'canvas:report', resourceId: 'canvas:report' },
    { locatorId: 'canvas:source:target', resourceId: 'canvas:source', section: '目标标题' },
    { locatorId: 'canvas:source:missing', resourceId: 'canvas:source', section: '没有此标题' },
    { locatorId: 'canvas:pdf:2', resourceId: 'canvas:pdf', page: 2 },
    { locatorId: 'canvas:pdf:3', resourceId: 'canvas:pdf', page: 3 },
  ];
  const registry = { protocol: 'pi-citation', version: '2.0', schemaVersion: 1, sessionId: session.citationRegistryId || session.id, citationSetId: 'canvas:smoke', generatedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resources, works: resources.map((item) => ({ workId: item.workId, type: 'REPORT', title: item.relativePath })), locators, occurrences: locators.map((item) => ({ occurrenceId: item.locatorId, locatorId: item.locatorId, containerType: 'message', containerId: 'canvas:smoke' })), provenance: [] };
  fs.mkdirSync(path.join(cwd, '.tau'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.tau', 'citations.json'), JSON.stringify(registry));

  await page.getByRole('button', { name: '打开或关闭文件栏', exact: true }).click();
  await dock.getByRole('button', { name: /canvas-report.md/ }).click();
  await reader.locator('h1', { hasText: 'Canvas 报告' }).waitFor();
  assert.equal(await page.locator('.file-preview-card').count(), 0);
  assert.equal(await canvas.getByRole('tab').count(), 1, 'documents open without map or video tools');
  assert.equal(await reader.locator('.katex').count(), 1);
  assert.equal(await reader.locator('.file-preview-mermaid svg').count(), 1);
  assert.match(await reader.locator('code').innerText(), /\$literal\$/);
  await page.waitForFunction(() => document.querySelector('.canvas-panel:not([hidden]) .file-preview-report img')?.naturalWidth > 0);
  assert.equal(await page.evaluate(() => !!window.documentAttack), false);
  assert.equal(await reader.locator('img[onerror]').count(), 0);
  console.log('Document smoke: report content rendered.');
  await reader.getByRole('button', { name: '目录', exact: true }).click();
  await reader.getByRole('navigation').getByRole('button', { name: '章节 20', exact: true }).click();
  const scrollTop = await reader.locator('.document-scroll').evaluate((node) => node.scrollTop);
  assert.ok(scrollTop > 100);
  await dock.getByRole('button', { name: /canvas-source.md/ }).click();
  await reader.locator('h1', { hasText: '规范', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'canvas-report.md', exact: true }).click();
  assert.ok(Math.abs(await reader.locator('.document-scroll').evaluate((node) => node.scrollTop) - scrollTop) < 2);
  await page.getByRole('tab', { name: 'canvas-report.md', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: 'canvas-source.md', exact: true }).evaluate((node) => document.activeElement === node), true);
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.getByRole('tab', { name: 'canvas-report.md', exact: true }).evaluate((node) => document.activeElement === node), true);
  await dock.getByRole('button', { name: /canvas-report.md/ }).click();
  assert.equal(await canvas.getByRole('tab').count(), 2);
  await page.getByRole('button', { name: '收起画布', exact: true }).click();
  await page.getByRole('button', { name: '切换画布', exact: true }).click();
  assert.ok(Math.abs(await reader.locator('.document-scroll').evaluate((node) => node.scrollTop) - scrollTop) < 2);

  console.log('Document smoke: tab and scroll state preserved.');
  // Refresh reads new bytes for an ordinary file; citation readers remain pinned.
  await dock.getByRole('button', { name: /canvas-current.md/ }).click();
  await reader.getByText('初始内容。', { exact: true }).waitFor();
  fs.writeFileSync(path.join(cwd, 'canvas-current.md'), '# 当前文件\n\n更新内容。');
  await reader.getByRole('button', { name: '刷新文档', exact: true }).click();
  await reader.getByText('更新内容。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭视图：canvas-current.md', exact: true }).click();
  let releaseSlow;
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
  let receivedSlow;
  const slowStarted = new Promise((resolve) => { receivedSlow = resolve; });
  const slowPattern = '**/api/file/content?*canvas-slow.md*';
  await page.route(slowPattern, async (route) => {
    receivedSlow();
    await slowGate;
    await route.fulfill({ json: { content: '# 慢请求旧内容', encoding: 'utf8', size: 30 } });
  });
  await dock.getByRole('button', { name: /canvas-slow.md/ }).click();
  await slowStarted;
  await page.getByRole('button', { name: '关闭视图：canvas-slow.md', exact: true }).click();
  await page.getByRole('tab', { name: 'canvas-report.md', exact: true }).click();
  const slowResponse = page.waitForResponse((response) => response.url().includes('/api/file/content?') && response.url().includes('canvas-slow.md'));
  releaseSlow();
  await slowResponse;
  await page.unroute(slowPattern);
  assert.equal(await reader.locator('h1').innerText(), 'Canvas 报告');

  console.log('Document smoke: refresh passed.');
  await composer.fill('canvas-citations [[cite:canvas:report,canvas:source:target,canvas:source:missing,canvas:pdf:2,canvas:pdf:3]]');
  await composer.press('Enter');
  await page.locator('.assistant-message:not(.is-streaming)', { hasText: '引用导航就绪。' }).waitFor();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  // A citation can also be present in the optimistic prompt while the snapshot settles.
  await page.locator('[data-citation-card="canvas:source:target"]').first().click();
  await reader.locator('h1', { hasText: '规范', exact: true }).waitFor();
  assert.ok(await reader.locator('.document-scroll').evaluate((node) => node.scrollTop) > 100);
  await page.locator('[data-citation-card="canvas:source:missing"]').first().click();
  await reader.getByRole('status').filter({ hasText: '未找到引用位置' }).waitFor();
  await page.getByRole('tab', { name: 'canvas-report.md', exact: true }).click();
  assert.equal(await canvas.getByRole('tab', { name: 'canvas-report.md', exact: true }).count(), 1);

  await page.getByRole('button', { name: '打开引用管理器', exact: true }).click();
  const manager = page.getByRole('dialog', { name: '引用管理器', exact: true });
  const sourceRow = manager.locator('article', { hasText: 'canvas-source.md' });
  await sourceRow.getByRole('combobox').selectOption('canvas:source:target');
  await sourceRow.getByRole('button', { name: '查看证据', exact: true }).click();
  await manager.waitFor({ state: 'hidden' });
  await reader.locator('h1', { hasText: '规范', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'canvas-report.md', exact: true }).click();

  console.log('Document smoke: Markdown citations passed.');
  await reader.locator('[data-citation-id="canvas:pdf:2"]').click();
  await reader.locator('iframe').waitFor();
  assert.match(await reader.locator('iframe').getAttribute('src'), /#page=2&/);
  const pdfFrame = await reader.locator('iframe').elementHandle();
  await page.getByRole('tab', { name: 'canvas-report.md', exact: true }).click();
  await page.getByRole('tab', { name: 'canvas-evidence.pdf', exact: true }).click();
  assert.equal(await reader.locator('iframe').evaluate((node, previous) => node === previous, pdfFrame), true);
  await page.locator('[data-citation-card="canvas:pdf:3"]').first().click();
  await page.waitForFunction(() => document.querySelector('.canvas-panel:not([hidden]) iframe')?.getAttribute('src')?.includes('#page=3&'));
  const thirdPage = await reader.locator('iframe').elementHandle();
  await page.locator('[data-citation-card="canvas:pdf:3"]').first().click();
  assert.equal(await reader.locator('iframe').evaluate((node, previous) => node === previous, thirdPage), false, 'same-page citation requests re-navigate');
  await page.waitForTimeout(700);
  const outputDirectory = path.resolve('.plans/canvas-document-viewer/validation');
  fs.mkdirSync(outputDirectory, { recursive: true });
  await reader.screenshot({ path: path.join(outputDirectory, 'pdf-page-3.png') });
  const downloadPromise = page.waitForEvent('download');
  await reader.getByRole('button', { name: '下载原文件', exact: true }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'canvas-evidence.pdf');
  assert.equal(fs.readFileSync(await download.path()).equals(pdf), true);

  await composer.fill('canvas-document-read'); await composer.press('Enter');
  await page.locator('.assistant-message', { hasText: '文档读取完成。' }).waitFor();
  const readTool = page.locator('.tool-card', { hasText: 'canvas-report.md' });
  await readTool.locator('.tool-card-toggle').click();
  await readTool.locator('.tool-read-open').click();
  await reader.locator('h1', { hasText: 'Canvas 报告', exact: true }).waitFor();
  assert.equal(await canvas.getByRole('tab', { name: 'canvas-report.md', exact: true }).count(), 1);
  assert.match(await reader.locator('.document-source').innerText(), /引用版本/);
  const exportRequest = page.waitForRequest((request) => request.url().endsWith('/api/reports/pdf/download'));
  const exported = page.waitForEvent('download');
  await reader.getByRole('button', { name: '生成并下载 PDF', exact: true }).click();
  const exportHtml = (await exportRequest).postDataJSON().html;
  assert.match(exportHtml, /data:image\/png;base64/);
  assert.doesNotMatch(exportHtml, /document-toolbar|document-outline/);
  assert.equal(fs.readFileSync(await (await exported).path()).subarray(0, 4).toString(), '%PDF');

  // Session switches recreate readers but restore document metadata and MD position.
  await reader.getByRole('navigation').getByRole('button', { name: '章节 20', exact: true }).click();
  const beforeSwitch = await reader.locator('.document-scroll').evaluate((node) => node.scrollTop);
  await page.locator('.live-tab-add').click();
  const newTask = page.getByRole('dialog', { name: '新建交通任务', exact: true });
  await newTask.locator('.menu-select-trigger', { hasText: 'kimi-coding/k2p7' }).waitFor();
  await newTask.getByRole('button', { name: '创建任务', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.live-tab').length === 2);
  assert.equal(await canvas.getByRole('tab').count(), 0, 'new sessions do not inherit document tabs');
  await page.locator('.live-tab').last().locator('.live-tab-close').click();
  await reader.locator('h1', { hasText: 'Canvas 报告', exact: true }).waitFor();
  assert.ok(Math.abs(await reader.locator('.document-scroll').evaluate((node) => node.scrollTop) - beforeSwitch) < 2);

  // The existing artifact scenario provides a real tool result and relative report image.
  await composer.fill('基线-citation-document'); await composer.press('Enter');
  await page.locator('.message-artifacts button', { hasText: '引用报告' }).waitFor();
  await page.locator('.message-artifacts button', { hasText: '引用报告' }).click();
  await reader.locator('h1', { hasText: '引用报告', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.canvas-panel:not([hidden]) .file-preview-report img')?.naturalWidth > 0);

  await page.getByRole('tab', { name: 'canvas-report.md', exact: true }).click();
  for (const theme of ['light', 'dark', 'sand']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await reader.screenshot({ path: path.join(outputDirectory, `markdown-${theme}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '关闭侧栏', exact: true }).click();
  await page.getByRole('button', { name: '打开或关闭文件栏', exact: true }).click();
  await dock.getByRole('button', { name: /canvas-report.md/ }).click();
  await reader.getByRole('button', { name: '目录', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '打开或关闭文件栏', exact: true }).getAttribute('aria-pressed'), 'false');
  await reader.screenshot({ path: path.join(outputDirectory, 'markdown-mobile.png'), animations: 'disabled' });
  assert.ok(await reader.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '展开或收起会话侧栏', exact: true }).click();
  fs.writeFileSync(path.join(cwd, 'canvas-report.md'), '# 修改后的版本');
  await reader.getByRole('button', { name: '刷新文档', exact: true }).click();
  await reader.getByRole('alert').waitFor();
  assert.equal(await reader.locator('h1').count(), 0);

  // Close all documents so existing map/video smoke expectations remain unchanged.
  while (await canvas.locator('.canvas-tab-close').count()) await canvas.locator('.canvas-tab-close').first().click();
  console.log('Document smoke: unified entries, report rendering, outline, navigation, refresh, version errors, downloads and tab preservation passed.');
}
