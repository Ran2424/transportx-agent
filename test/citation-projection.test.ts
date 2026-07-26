const { test } = require('node:test');
const assert = require('node:assert/strict');

const envelope = {
  protocol: 'pi-citation',
  version: '1.0',
  citationSetId: 'citations:projection',
  generatedAt: '2026-07-26T00:00:00.000Z',
  sources: [{
    sourceId: 'knowledge:DOC',
    kind: 'pdf',
    scope: 'knowledge',
    title: '测试标准',
    relativePath: 'standards/test.pdf',
    mimeType: 'application/pdf',
    sha256: 'b'.repeat(64),
  }],
  locators: [{ locatorId: 'locator:K-DOC-000001', sourceId: 'knowledge:DOC', page: 7, quote: '测试原文' }],
  citations: [{ citationId: 'K-DOC-000001', sourceId: 'knowledge:DOC', locatorId: 'locator:K-DOC-000001' }],
};

test('citation projection associates a tool result with the final assistant message in the same turn', async () => {
  const { projectMessageCitations, citationCopyText } = await import('../src/web/features/citation/citation-projection.ts');
  const entries: any[] = [
    { type: 'message', message: { role: 'user', content: '查依据' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-cite', name: 'tau_cite', arguments: {} }] } },
    { type: 'message', message: { role: 'toolResult', toolCallId: 'call-cite', toolName: 'tau_cite', details: { kind: 'tau-citations', citations: envelope } } },
    { type: 'message', id: 'final', message: { role: 'assistant', content: '结论。[[cite:K-DOC-000001]] 再次引用。[[cite:K-DOC-000001]]' } },
  ];
  const projection = projectMessageCitations(entries).byEntry.get(entries[3]);
  assert.ok(projection);
  if (!projection) throw new Error('citation projection missing');
  assert.equal(projection.citations.length, 1);
  assert.equal(projection.citations[0].number, 1);
  assert.equal(projection.citations[0].locator.page, 7);
  assert.equal(citationCopyText(entries[3].message.content, projection), '结论。[1] 再次引用。[1]\n\n引用依据：\n[1] 测试标准，PDF 第7页');
});

test('citation projection does not inherit registered sources into the next user turn', async () => {
  const { projectMessageCitations } = await import('../src/web/features/citation/citation-projection.ts');
  const entries: any[] = [
    { type: 'message', message: { role: 'user', content: '第一轮' } },
    { type: 'message', message: { role: 'toolResult', details: { citations: envelope } } },
    { type: 'message', message: { role: 'user', content: '第二轮' } },
    { type: 'message', message: { role: 'assistant', content: '旧引用。[[cite:K-DOC-000001]]' } },
  ];
  const projection = projectMessageCitations(entries).byEntry.get(entries[3]);
  assert.deepEqual(projection?.unavailableIds, ['K-DOC-000001']);
});

test('session artifacts become outputs instead of numbered evidence', async () => {
  const { citationDisplayText, projectMessageCitations } = await import('../src/web/features/citation/citation-projection.ts');
  const artifactEnvelope = {
    ...envelope,
    sources: [{
      sourceId: 'artifact:report',
      kind: 'document',
      scope: 'session',
      title: '交通保障预案.md',
      relativePath: 'scenario/report.md',
      mimeType: 'text/markdown',
      sha256: 'a'.repeat(64),
    }],
    locators: [{ locatorId: 'locator:artifact', sourceId: 'artifact:report', sourceUnit: '完整文档' }],
    citations: [{ citationId: 'artifact-report', sourceId: 'artifact:report', locatorId: 'locator:artifact' }],
  };
  const entries: any[] = [
    { type: 'message', message: { role: 'user', content: '生成预案' } },
    { type: 'message', message: { role: 'toolResult', details: { citations: envelope } } },
    { type: 'message', message: { role: 'toolResult', details: { citations: artifactEnvelope } } },
    { type: 'message', message: { role: 'assistant', content: '依据。[[cite:K-DOC-000001]]\n报告已生成。' } },
  ];
  const projection = projectMessageCitations(entries).byEntry.get(entries[3]);
  assert.ok(projection);
  if (!projection) throw new Error('citation projection missing');
  assert.equal(projection.citations.length, 1);
  assert.equal(projection.artifacts.length, 1);
  assert.deepEqual(projection.numbers, { 'K-DOC-000001': 1 });
  assert.equal(projection.available.size, 2);
  assert.equal(citationDisplayText(entries[3].message.content, projection), '依据。[[cite:K-DOC-000001]]\n报告已生成。');
});

test('a report can resolve registered citations that the final chat answer did not use', async () => {
  const { projectCitationText, projectMessageCitations } = await import('../src/web/features/citation/citation-projection.ts');
  const secondEnvelope = {
    ...envelope,
    sources: [{ ...envelope.sources[0], sourceId: 'knowledge:DOC-2', title: '第二份标准' }],
    locators: [{ ...envelope.locators[0], locatorId: 'locator:K-DOC-000002', sourceId: 'knowledge:DOC-2', page: 12 }],
    citations: [{ ...envelope.citations[0], citationId: 'K-DOC-000002', sourceId: 'knowledge:DOC-2', locatorId: 'locator:K-DOC-000002' }],
  };
  const entries: any[] = [
    { type: 'message', message: { role: 'user', content: '生成报告' } },
    { type: 'message', message: { role: 'toolResult', details: { citations: envelope } } },
    { type: 'message', message: { role: 'toolResult', details: { citations: secondEnvelope } } },
    { type: 'message', message: { role: 'assistant', content: '聊天仅引用第一项。[[cite:K-DOC-000001]]' } },
  ];
  const messageProjection = projectMessageCitations(entries).byEntry.get(entries[3]);
  assert.ok(messageProjection);
  if (!messageProjection) throw new Error('citation projection missing');
  const reportProjection = projectCitationText(
    '报告使用第二项。[[cite:K-DOC-000002]]',
    messageProjection.available,
  );
  assert.equal(reportProjection?.citations[0].source.title, '第二份标准');
  assert.deepEqual(reportProjection?.numbers, { 'K-DOC-000002': 1 });
  assert.deepEqual(reportProjection?.unavailableIds, []);
});

test('detailed Markdown references are an ordered list sorted by citation number', async () => {
  const { citationReferenceMarkdown } = await import('../src/web/features/citation/citation-projection.ts');
  const projection: any = {
    citations: [
      {
        number: 2,
        citation: { citationId: 'K-DOC-000002' },
        source: { title: '第二项' },
        locator: { page: 12, quote: '第二项原文' },
      },
      {
        number: 1,
        citation: { citationId: 'K-DOC-000001' },
        source: { title: '第一项' },
        locator: { page: 7, quote: '第一项原文' },
      },
    ],
  };
  const markdown = citationReferenceMarkdown(projection);
  assert.ok(markdown.indexOf('1. **《第一项》**') < markdown.indexOf('2. **《第二项》**'));
});

test('system reference rendering removes a trailing model-written reference section', async () => {
  const { stripManualCitationReferenceTail } = await import('../src/web/features/citation/citation-projection.ts');
  const markdown = [
    '# 报告',
    '',
    '正文。[[cite:K-DOC-000001]]',
    '',
    '## 参考依据',
    '',
    '| 模型生成的索引 |',
    '|---|',
    '| 不应保留 |',
    '',
    '<!-- tau:references:start -->',
    '## 引用依据（逐条出处）',
    '',
    '1. 系统索引',
    '<!-- tau:references:end -->',
  ].join('\n');
  const normalized = stripManualCitationReferenceTail(markdown);
  assert.doesNotMatch(normalized, /模型生成的索引/);
  assert.match(normalized, /1\. 系统索引/);
});
