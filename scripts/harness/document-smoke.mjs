import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export async function documentSmoke(page, browser) {
  const session = await page.evaluate(async () => (await (await fetch(`/api/conversations/${localStorage.getItem('tau-active-conversation-id')}/snapshot`)).json()).runtime);
  const cwd = session.cwd;
  const composer = page.getByLabel('消息输入');
  const canvas = page.locator('[data-testid=agent-canvas]');
  const reader = page.locator('.canvas-panel:not([hidden]) [data-testid=document-workspace]');
  const dock = page.locator('[data-testid=workspace-dock]');
  const report = '# Canvas 报告\n\n![图表](canvas-chart.svg)\n\n$$q=kv$$\n\n```mermaid\ngraph LR\n A-->B\n```\n\n```text\n$literal$\n```\n\n| 路段 | 流量 |\n| --- | --- |\n| A | 12 |\n\n[[cite:canvas:pdf:2]]\n\n' + Array.from({ length: 40 }, (_, i) => `## 章节 ${i + 1}\n\n交通分析内容 ${i + 1}。\n`).join('\n') + '\n## 结论\n\n报告结论。\n\n```mermaid\n<img src=x onerror="window.documentAttack=true">\n```';
  const source = '# 规范\n\n' + Array.from({ length: 30 }, (_, i) => `段落 ${i + 1}。\n\n`).join('') + '## 目标标题\n\n定位到此处。\n\n## 重复\n\n一。\n\n## 重复\n\n二。';
  async function present(format, operation) {
    const prompt = `canvas-refresh-${format}-${operation}`;
    await composer.fill(prompt); await composer.press('Enter');
    await page.getByText(`${prompt} 完成`, { exact: true }).waitFor();
  }
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
  const sourceVersion = (id, name, bytes, mimeType) => ({ sourceVersionId: id, sourceKey: `session:${name}`, title: name, acquiredAt: new Date().toISOString(), content: { kind: 'file', scope: 'session', path: name, mimeType, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: Buffer.byteLength(bytes) } });
  fs.writeFileSync(path.join(cwd, 'canvas-counts.csv'), '站点,数量\n上海站,12\n上海南站,24\n虹桥站,36\n');
  const sources = [sourceVersion('canvas:report', 'canvas-report.md', report, 'text/markdown'), sourceVersion('canvas:source', 'canvas-source.md', source, 'text/markdown'), sourceVersion('canvas:pdf', 'canvas-evidence.pdf', pdf, 'application/pdf'), sourceVersion('canvas:chart', 'canvas-chart.svg', fs.readFileSync(path.join(cwd, 'canvas-chart.svg')), 'image/svg+xml'), sourceVersion('canvas:counts', 'canvas-counts.csv', fs.readFileSync(path.join(cwd, 'canvas-counts.csv')), 'text/csv')];
  sources[0].title = '2024-05-22订单清洗漏斗与运营指标分析报告：样本筛选、重复订单核验、异常数据处理及分时段统计口径说明';
  sources[3].title = '2024-05-22五档次运营指标均值总表及图表';
  sources[4].title = '2024-05-22_' + 'TrafficOperationsAnalysisAndOrderCleaning'.repeat(4) + '.csv';
  sources[1].metadata = { issuedAt: '2026-10-01', edition: '2026 版', standardNumber: 'TX-01' };
  const evidence = [
    { evidenceId: 'canvas:report', sourceVersionId: 'canvas:report', locator: { kind: 'source' }, contentKind: 'source-only' },
    { evidenceId: 'canvas:chart', sourceVersionId: 'canvas:chart', locator: { kind: 'source' }, contentKind: 'source-only' },
    { evidenceId: 'canvas:source:target', sourceVersionId: 'canvas:source', locator: { kind: 'document', section: '目标标题' }, contentKind: 'summary', text: '定位到此处。知识归纳需要核查原件。' },
    { evidenceId: 'canvas:source:missing', sourceVersionId: 'canvas:source', locator: { kind: 'document', section: '没有此标题' }, contentKind: 'source-only' },
    { evidenceId: 'canvas:pdf:2', sourceVersionId: 'canvas:pdf', locator: { kind: 'document', page: 2 }, contentKind: 'source-only' },
    { evidenceId: 'canvas:pdf:3', sourceVersionId: 'canvas:pdf', locator: { kind: 'document', page: 3 }, contentKind: 'source-only' },
    { evidenceId: 'canvas:counts:rows', sourceVersionId: 'canvas:counts', locator: { kind: 'table', rowStart: 2, rowEnd: 3, columns: ['数量'] }, contentKind: 'result' },
  ];
  const registry = { protocol: 'pi-citation', version: '3.0', schemaVersion: 2, sessionId: JSON.parse(fs.readFileSync(path.join(cwd, '.tau/workspace.json'), 'utf8')).citationRegistryId, sources, evidence };
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
  // Refresh reads new bytes for an ordinary file.
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
  const slowPattern = '**/api/conversations/*/files/content?*canvas-slow.md*';
  await page.route(slowPattern, async (route) => {
    receivedSlow();
    await slowGate;
    await route.fulfill({ json: { content: '# 慢请求旧内容', encoding: 'utf8', size: 30 } });
  });
  await dock.getByRole('button', { name: /canvas-slow.md/ }).click();
  await slowStarted;
  await page.getByRole('button', { name: '关闭视图：canvas-slow.md', exact: true }).click();
  await page.getByRole('tab', { name: 'canvas-report.md', exact: true }).click();
  const slowResponse = page.waitForResponse((response) => response.url().includes('/files/content?') && response.url().includes('canvas-slow.md'));
  releaseSlow();
  await slowResponse;
  await page.unroute(slowPattern);
  assert.equal(await reader.locator('h1').innerText(), 'Canvas 报告');

  await composer.fill('canvas-citations [[cite:canvas:source:target,canvas:pdf:2]] [[cite:canvas:counts:rows]]');
  await composer.press('Enter');
  const citedMessage = page.locator('.assistant-message:not(.is-streaming)', { hasText: '引用导航就绪。' }).last();
  await citedMessage.waitFor();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  const disclosure = citedMessage.locator('.citation-disclosure');
  assert.equal(await disclosure.evaluate((node) => node.open), false, 'the complete reference list starts folded');
  await disclosure.locator('summary').focus(); await page.keyboard.press('Enter');
  assert.equal(await disclosure.evaluate((node) => node.open), true);
  const detail = page.getByRole('dialog', { name: '引用依据', exact: true });
  await citedMessage.locator('[data-citation-card="canvas:source:target"]').click();
  await detail.getByText('知识归纳', { exact: false }).first().waitFor();
  assert.equal(await detail.locator('.citation-detail-item').count(), 1);
  assert.equal(await page.locator('.citation-evidence-peek').count(), 0);
  await detail.getByText('来源与版本信息', { exact: true }).click();
  assert.match(await detail.innerText(), /2026 版/);
  const evidenceDirectory = path.resolve('.plans/citation-minimal-loop/validation');
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  for (const theme of ['light', 'dark', 'sand']) {
    await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
    await detail.screenshot({ path: path.join(evidenceDirectory, `detail-${theme}.png`), animations: 'disabled' });
  }
  await detail.getByRole('button', { name: '在 Canvas 查看定位', exact: true }).click();
  await detail.waitFor({ state: 'hidden' });
  await reader.locator('h1', { hasText: '规范', exact: true }).waitFor();
  assert.ok(await reader.locator('.document-scroll').evaluate((node) => node.scrollTop) > 100);
  const pinnedSourceTabs = await canvas.getByRole('tab').count();
  await citedMessage.locator('[data-citation-card="canvas:source:target"]').click();
  await detail.getByRole('button', { name: '在 Canvas 查看定位', exact: true }).click();
  assert.equal(await canvas.getByRole('tab').count(), pinnedSourceTabs, 'same source version reuses the tab');
  await citedMessage.locator('[data-citation-id="canvas:source:target"]').first().click();
  await detail.waitFor();
  await page.keyboard.press('Escape');
  await detail.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-citation-id') === 'canvas:source:target');
  const user = page.locator('.user-message', { hasText: 'canvas-citations' }).last();
  await user.locator('[data-citation-id="canvas:source:target"]').click();
  await detail.locator('.citation-detail-item').nth(1).waitFor();
  assert.equal(await detail.locator('.citation-detail-item').count(), 2, 'group clicks preserve every supporting source');
  await page.keyboard.press('Escape');
  // A CSV result remains readable without a dedicated JSON evidence file.
  await user.locator('[data-citation-id="canvas:counts:rows"]').click();
  await detail.getByRole('cell', { name: '上海南站', exact: true }).waitFor();
  assert.equal(await detail.locator('tbody .is-cited').count(), 2);
  await detail.getByRole('button', { name: '在 Canvas 查看定位', exact: true }).click();
  await reader.locator('[data-document-row="2"].is-cited').waitFor();
  assert.equal(await reader.locator('tbody .is-cited').count(), 2);
  await citedMessage.locator('[data-citation-card="canvas:source:missing"]').count().then(async (count) => {
    if (count) { await citedMessage.locator('[data-citation-card="canvas:source:missing"]').click(); await detail.getByRole('button', { name: '在 Canvas 查看定位', exact: true }).click(); await reader.getByRole('status').filter({ hasText: '未找到引用位置' }).waitFor(); }
  });
  await page.getByRole('tab', { name: 'canvas-report.md', exact: true }).first().click();
  const markdownDownload = page.waitForEvent('download');
  await reader.getByRole('button', { name: '导出 Markdown', exact: true }).click();
  const markdownText = fs.readFileSync(await (await markdownDownload).path(), 'utf8');
  assert.match(markdownText, /参考文献/); assert.match(markdownText, /第 2 页/); assert.doesNotMatch(markdownText, /\[\[cite:/);
  const exportRequest = page.waitForRequest((request) => request.url().endsWith('/api/reports/pdf/download'));
  const pdfDownload = page.waitForEvent('download');
  await reader.getByRole('button', { name: '生成并下载 PDF', exact: true }).click();
  const exportHtml = (await exportRequest).postDataJSON().html;
  assert.match(exportHtml, /参考文献/); assert.match(exportHtml, /第 2 页/);
  assert.equal(fs.readFileSync(await (await pdfDownload).path()).subarray(0, 4).toString(), '%PDF');
  // Report-to-PDF navigation resolves the pinned PDF and preserves page selection.
  await page.getByRole('tab', { name: 'canvas-report.md', exact: true }).first().click();
  await reader.locator('[data-citation-id="canvas:pdf:2"]').click();
  await detail.getByRole('button', { name: '在 Canvas 查看定位', exact: true }).click();
  await reader.locator('iframe').waitFor();
  assert.match(await reader.locator('iframe').getAttribute('src'), /#page=2&/);
  const downloadPromise = page.waitForEvent('download');
  await reader.getByRole('button', { name: '下载原文件', exact: true }).click();
  assert.equal(fs.readFileSync(await (await downloadPromise).path()).equals(pdf), true);
  // The manager opens the same details and retains its existing bibliography exports.
  await page.getByRole('button', { name: '打开引用管理器', exact: true }).click();
  const manager = page.getByRole('dialog', { name: '引用依据管理', exact: true });
  await manager.locator('article', { hasText: 'canvas-source.md' }).first().getByRole('button', { name: '查看依据', exact: true }).click();
  await detail.getByText('知识归纳', { exact: false }).first().waitFor();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  // Narrow view contains detail scrolling without a hover interaction.
  await user.locator('[data-citation-id="canvas:counts:rows"]').click();
  await detail.getByRole('cell', { name: '虹桥站', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await detail.getByRole('cell', { name: '虹桥站', exact: true }).waitFor();
  assert.ok(await detail.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
  await detail.screenshot({ path: path.join(evidenceDirectory, 'detail-mobile.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 900 });
  // Final deliverables retain their separate card intent while sharing the source version.
  await composer.fill('基线-citation-document'); await composer.press('Enter');
  const artifact = page.locator('.message-artifacts button', { hasText: '引用报告' });
  await artifact.waitFor(); await artifact.click();
  await reader.locator('h1', { hasText: '引用报告', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.canvas-panel:not([hidden]) .file-preview-report img')?.naturalWidth > 0);
  await user.locator('[data-citation-id="canvas:source:target"]').click();
  await detail.getByRole('button', { name: '在 Canvas 查看定位', exact: true }).first().click();
  fs.writeFileSync(path.join(cwd, 'canvas-source.md'), '# 已覆盖原件');
  await reader.getByRole('button', { name: '刷新文档', exact: true }).click();
  await reader.getByRole('alert').waitFor();
  assert.equal(await reader.locator('h1').count(), 0, 'pinned versions never fall back to changed content');
  await reader.getByRole('button', { name: '打开当前文件（非引用版本）', exact: true }).click();
  await reader.getByRole('heading', { name: '已覆盖原件', exact: true }).waitFor();
  assert.match(await reader.locator('.document-source').innerText(), /当前文件/);
  await citedMessage.locator('[data-citation-card="canvas:source:target"]').click();
  await detail.getByRole('alert').waitFor();
  await detail.getByRole('heading', { name: 'canvas-source.md', exact: true }).waitFor();
  assert.equal(await detail.getByRole('link', { name: '下载原件', exact: true }).count(), 0);
  await detail.getByText('来源与版本信息', { exact: true }).click();
  assert.ok((await detail.innerText()).includes(sources[1].content.sha256));
  await detail.getByRole('button', { name: '打开当前文件（非引用版本）', exact: true }).click();
  await reader.getByRole('heading', { name: '已覆盖原件', exact: true }).waitFor();
  // Re-check authorization: an escaped replacement must never expose a recovery action.
  const sourceFile = path.join(cwd, 'canvas-source.md');
  const savedSource = fs.readFileSync(sourceFile);
  fs.rmSync(sourceFile);
  let linked = false;
  try { fs.symlinkSync(path.resolve('package.json'), sourceFile); linked = true; }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
  if (linked) {
    await citedMessage.locator('[data-citation-card="canvas:source:target"]').click();
    await detail.getByRole('alert').waitFor();
    assert.equal(await detail.getByRole('button', { name: '打开当前文件（非引用版本）', exact: true }).count(), 0);
    await detail.getByRole('button', { name: '关闭', exact: true }).click();
    fs.rmSync(sourceFile);
  }
  fs.writeFileSync(sourceFile, savedSource);
  while (await canvas.locator('.canvas-tab-close').count()) await canvas.locator('.canvas-tab-close').first().click();
  fs.writeFileSync(path.join(cwd, 'canvas-auto.md'), '# 自动刷新 A');
  await present('markdown', 'present');
  await reader.getByRole('heading', { name: '自动刷新 A', exact: true }).waitFor();
  fs.writeFileSync(path.join(cwd, 'canvas-auto.md'), '# 自动刷新 B');
  await present('markdown', 'update');
  await reader.getByRole('heading', { name: '自动刷新 B', exact: true }).waitFor();
  let reads = 0;
  const countRead = (request) => { if (request.url().includes('/files/content?') && request.url().includes('canvas-auto.md')) reads++; };
  page.on('request', countRead);
  await present('markdown', 'focus');
  assert.equal(reads, 0, 'focus does not reload the current Markdown');
  page.off('request', countRead);
  fs.writeFileSync(path.join(cwd, 'canvas-auto.pdf'), pdf);
  await present('pdf', 'present');
  await reader.locator('iframe').waitFor();
  await reader.locator('iframe').evaluate((node) => { node.dataset.beforeUpdate = 'true'; });
  await present('pdf', 'update');
  await page.waitForFunction(() => {
    const frame = document.querySelector('.canvas-panel:not([hidden]) .document-pdf');
    return frame && !frame.dataset.beforeUpdate;
  });
  await present('markdown', 'clear');
  await present('pdf', 'clear');
  while (await canvas.locator('.canvas-tab-close').count()) await canvas.locator('.canvas-tab-close').first().click();
  await composer.fill('交付成果-长标题'); await composer.press('Enter');
  const artifacts = page.locator('.assistant-message:not(.is-streaming)', { hasText: '长标题交付验收完成。' }).locator('.message-artifacts');
  await artifacts.waitFor();
  assert.equal(await artifacts.locator('button').count(), 3);
  const originalTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  for (const mode of ['wide', 'split', 'mobile']) {
    await page.setViewportSize({ width: mode === 'mobile' ? 390 : 1280, height: 900 });
    if (mode === 'split') {
      await artifacts.locator('button').first().focus(); await page.keyboard.press('Enter');
      await reader.getByRole('heading', { name: 'Canvas 报告', exact: true }).waitFor();
    }
    if (mode === 'mobile') await page.getByRole('button', { name: '收起画布', exact: true }).click();
    for (const theme of ['light', 'dark', 'sand']) {
      await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
      const metrics = await artifacts.locator('button').evaluateAll((nodes) => nodes.map((node) => {
        const title = node.querySelector('strong'), copy = node.querySelector('.message-artifact-copy');
        const action = node.querySelector('.message-artifact-action'), icon = node.querySelector('.message-artifact-icon');
        const rect = node.getBoundingClientRect(), textRect = title.getBoundingClientRect();
        return { width: rect.width, height: rect.height, titleWidth: textRect.width, titleHeight: textRect.height, lineHeight: parseFloat(getComputedStyle(title).lineHeight), fullTitle: title.title === title.textContent, clamped: title.scrollHeight > title.clientHeight, ordered: icon.getBoundingClientRect().right <= copy.getBoundingClientRect().left && copy.getBoundingClientRect().right <= action.getBoundingClientRect().left, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth, metadata: node.querySelector('small').textContent, action: action.textContent };
      }));
      for (const metric of metrics) {
        assert.ok(metric.titleWidth >= metric.width / 2, 'long titles use the flexible text column');
        assert.ok(metric.titleHeight <= metric.lineHeight * 2 + 1 && metric.height <= 84, 'titles occupy at most two lines');
        assert.ok(metric.fullTitle && metric.ordered, 'full titles remain available and columns do not overlap');
        assert.ok(metric.scrollWidth <= metric.clientWidth + 1, 'cards do not overflow horizontally');
        assert.match(metric.metadata, /(?:MD|SVG|CSV) · .+ · \d+(?:\.\d+)? (?:B|KB|MB)/);
        assert.equal(metric.action, '打开');
      }
      assert.ok(metrics.some((metric) => metric.clamped), 'long filenames exercise the two-line clamp');
      await artifacts.screenshot({ path: path.join(evidenceDirectory, `artifacts-${mode}-${theme}.png`), animations: 'disabled' });
    }
  }
  await page.evaluate((value) => document.documentElement.dataset.theme = value, originalTheme);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '切换画布', exact: true }).click();
  while (await canvas.locator('.canvas-tab-close').count()) await canvas.locator('.canvas-tab-close').first().click();
  console.log('Artifact smoke: Chinese/date/continuous English titles, metadata, two-line bounds, keyboard opening and three-theme wide/split/mobile screenshots passed.');
  console.log('Citation smoke: collapsed references, shared details, multi-source groups, table rows, pinned Canvas navigation, exports and version failures passed.');
}

export async function officeRefreshSmoke(page) {
  const { ZipFile } = await import('yazl');
  const session = await page.evaluate(async () => (await (await fetch(`/api/conversations/${localStorage.getItem('tau-active-conversation-id')}/snapshot`)).json()).runtime);
  const makeDocx = (text) => new Promise((resolve, reject) => {
    const zip = new ZipFile(), chunks = [];
    zip.addBuffer(Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'), '[Content_Types].xml');
    zip.addBuffer(Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'), '_rels/.rels');
    zip.addBuffer(Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`), 'word/document.xml');
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
  const file = path.join(session.cwd, 'canvas-auto.docx');
  const composer = page.getByLabel('消息输入');
  const office = page.locator('.canvas-panel:not([hidden]) [data-testid=office-workspace]');
  async function present(operation) {
    const prompt = `canvas-refresh-docx-${operation}`;
    await composer.fill(prompt); await composer.press('Enter');
    await page.getByText(`${prompt} 完成`, { exact: true }).waitFor();
  }
  fs.writeFileSync(file, await makeDocx('Office revision A'));
  await present('present');
  await office.getByRole('button', { name: '放大', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.canvas-panel:not([hidden]) .office-actions button')?.disabled);
  const revised = await makeDocx('Office revision B');
  fs.writeFileSync(file, revised);
  const loaded = page.waitForResponse((response) => response.request().method() === 'GET' && response.url().includes('/files/raw?') && response.url().includes('canvas-auto.docx'));
  await present('update');
  assert.deepEqual(await (await loaded).body(), revised);
  await page.waitForFunction(() => !document.querySelector('.canvas-panel:not([hidden]) .office-actions button')?.disabled);
  assert.equal(await office.getByRole('alert').count(), 0);
  let reads = 0;
  const countRead = (request) => { if (request.url().includes('canvas-auto.docx') && request.url().includes('/files/raw?')) reads++; };
  page.on('request', countRead);
  await present('focus');
  assert.equal(reads, 0, 'focus does not reload Office bytes');
  page.off('request', countRead);
  await present('clear');
  console.log('Office smoke: DOCX loads revised bytes automatically and focus preserves the viewer.');
}
