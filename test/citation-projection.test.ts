const { test } = require('node:test');
const assert = require('node:assert/strict');

test('projects manually inserted user citations from the session registry with work-level numbers', async () => {
  const { citationCopyText, projectMessageCitations } = await import('../src/web/features/citation/citation-projection.ts');
  const envelope: import('../src/contracts/citation.ts').CitationEnvelope = {
    protocol: 'pi-citation', version: '2.0', citationSetId: 'set_manual', generatedAt: '2026-08-16T00:00:00.000Z',
    works: [{ workId: 'work_standard', type: 'standard', title: '测试标准' }],
    resources: [{ resourceId: 'resource_standard', workId: 'work_standard', kind: 'pdf', scope: 'knowledge', relativePath: 'standard.pdf', mimeType: 'application/pdf', sha256: 'a'.repeat(64) }],
    locators: [{ locatorId: 'locator_1', resourceId: 'resource_standard', page: 12 }, { locatorId: 'locator_2', resourceId: 'resource_standard', page: 15 }],
    occurrences: [{ occurrenceId: 'occ_1', locatorId: 'locator_1', containerType: 'message', containerId: 'composer' }, { occurrenceId: 'occ_2', locatorId: 'locator_2', containerType: 'message', containerId: 'composer' }],
    provenance: [],
  };
  const entry = { id: 'user_1', message: { role: 'user', content: '请依据 [[cite:occ_1]] 与 [[cite:occ_2]] 分析。' } } as any;
  const projection = projectMessageCitations([entry], envelope).byEntry.get(entry);

  if (!projection) throw new Error('Expected a citation projection for the user message.');
  assert.deepEqual(projection.numbers, { occ_1: 1, occ_2: 1 });
  assert.equal(projection.citations.length, 2);
  assert.match(citationCopyText(String(entry.message.content), projection), /^请依据 \[1\] 与 \[1\]/);
  assert.equal((citationCopyText(String(entry.message.content), projection).match(/\*\*(?:《)?测试标准(?:》)?\*\*/g) || []).length, 1);
});
