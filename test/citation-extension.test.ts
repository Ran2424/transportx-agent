const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const KNOWLEDGE_ROOT = process.env.TRANSPORTX_KNOWLEDGE_ROOT || path.join(process.cwd(), 'modules', 'official', 'traffic-knowledge', 'assets');
const KNOWLEDGE_CATALOG = path.join(KNOWLEDGE_ROOT, '_catalog', 'documents.jsonl');
process.env.TRANSPORTX_KNOWLEDGE_ROOT ||= KNOWLEDGE_ROOT;

function extensionHarness() {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const citationExtension = require('../extensions/pi-citation/index.ts').default;
  citationExtension({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
  } as any);
  return { handlers, tools };
}

test('citation extension maps Python-facing ASAR paths to unpacked files', (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-citation-asar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packed = path.join(root, 'app.asar', 'modules', 'search.py');
  const unpacked = path.join(root, 'app.asar.unpacked', 'modules', 'search.py');
  fs.mkdirSync(path.dirname(packed), { recursive: true });
  fs.mkdirSync(path.dirname(unpacked), { recursive: true });
  fs.writeFileSync(packed, 'packed');
  fs.writeFileSync(unpacked, 'unpacked');
  const { externalProcessPath } = require('../extensions/pi-citation/index.ts');
  assert.equal(externalProcessPath(packed), unpacked);
});

test('citation extension registers current-task reports and rejects files outside the task', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-citation-extension-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'report.md'), '# 报告\n\n拥堵集中在入口。');
  fs.writeFileSync(path.join(cwd, 'heatmap.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(cwd, 'summary.csv'), 'name,value\n入口,42\n');
  const { handlers, tools } = extensionHarness();
  const tool = tools.get('tau_cite');
  const result = await tool.execute('call-cite', {
    artifacts: [
      { path: 'report.md', title: '交通分析报告', section: '结论', quote: '拥堵集中在入口。' },
      { path: 'heatmap.png', title: '拥堵热力图', quote: '入口区域拥堵最集中。' },
      { path: 'summary.csv', title: '交通汇总数据' },
    ],
  }, undefined, undefined, { cwd });
  assert.equal(result.details.kind, 'tau-citations');
  assert.equal(result.details.citations.sources[0].scope, 'session');
  assert.equal(result.details.citations.sources[0].relativePath, 'report.md');
  assert.equal(result.details.citations.sources[1].kind, 'image');
  assert.equal(result.details.citations.sources[1].relativePath, 'heatmap.png');
  assert.equal(result.details.citations.sources[2].mimeType, 'text/csv');
  assert.match(result.content[0].text, /\[\[cite:artifact:/);
  await assert.rejects(
    tool.execute('call-outside', { artifacts: [{ path: path.join(cwd, '..', 'outside.md') }] }, undefined, undefined, { cwd }),
    /outside|ENOENT/,
  );
  const prompt = await handlers.get('before_agent_start')!({ systemPrompt: 'BASE' });
  assert.match(prompt.systemPrompt, /call tau_cite first/);
});

test('citation extension turns a verified knowledge ID into a path-free browser envelope', { skip: !fs.existsSync(KNOWLEDGE_CATALOG) }, async () => {
  const { tools } = extensionHarness();
  const result = await tools.get('tau_cite').execute(
    'call-knowledge',
    { knowledgeIds: ['K-GBT33170.2-2016-000058'] },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );
  const envelope = result.details.citations;
  assert.equal(envelope.citations[0].knowledgeId, 'K-GBT33170.2-2016-000058');
  assert.equal(envelope.locators[0].page, 9);
  assert.equal(envelope.sources[0].scope, 'knowledge');
  assert.equal(path.isAbsolute(envelope.sources[0].relativePath), false);
  assert.doesNotMatch(JSON.stringify(envelope), /\/Users\/ran\/WorkSpace\/2 Unit Project/);
});

test('citation extension injects detailed knowledge references into Markdown artifacts idempotently', { skip: !fs.existsSync(KNOWLEDGE_CATALOG) }, async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-citation-report-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const reportPath = path.join(cwd, 'report.md');
  fs.writeFileSync(
    reportPath,
    '# 交通保障报告\n\n先引用场地标识要求。[[cite:K-GBT33170.3-2016-000002]]\n\n再引用安全要求。[[cite:K-GBT33170.2-2016-000058]]\n\n---\n\n## 参考依据\n\n| 模型生成的旧索引 |\n|---|\n| 不应保留 |\n',
  );
  const { tools } = extensionHarness();
  const tool = tools.get('tau_cite');
  const execute = () => tool.execute(
    'call-report',
    { artifacts: [{ path: 'report.md', title: '交通保障报告' }] },
    undefined,
    undefined,
    { cwd },
  );

  const first = await execute();
  const markdown = fs.readFileSync(reportPath, 'utf8');
  assert.match(markdown, /## 引用依据（逐条出处）/);
  assert.match(markdown, /K-GBT33170\.2-2016-000058/);
  assert.match(markdown, /PDF 第 4 页/);
  assert.match(markdown, /原文摘录/);
  assert.doesNotMatch(markdown, /## 参考依据\n/);
  const firstReference = markdown.indexOf('1. **《大型活动安全要求 第3部分：场地布局和安全导向标识》**');
  const secondReference = markdown.indexOf('2. **《大型活动安全要求 第2部分：人员管控》**');
  assert.ok(firstReference >= 0);
  assert.ok(secondReference > firstReference);
  assert.equal(first.details.citations.citations.some((item: any) => item.knowledgeId === 'K-GBT33170.2-2016-000058'), true);
  const artifactSource = first.details.citations.sources.find((source: any) => source.scope === 'session');
  const actualSha = require('node:crypto').createHash('sha256').update(fs.readFileSync(reportPath)).digest('hex');
  assert.equal(artifactSource.sha256, actualSha);

  await execute();
  const secondMarkdown = fs.readFileSync(reportPath, 'utf8');
  assert.equal((secondMarkdown.match(/<!-- tau:references:start -->/g) || []).length, 1);
  assert.equal((secondMarkdown.match(/## 引用依据（逐条出处）/g) || []).length, 1);
});
