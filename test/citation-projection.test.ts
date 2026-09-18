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

test('mixed artifact and data citations remain clickable and copy with matching references', async () => {
  const { citationCopyText, projectMessageCitations, projectCitationText } = await import('../src/web/features/citation/citation-projection.ts');
  const { renderMarkdown } = await import('../src/public/markdown.ts');
  const sources = ['report', 'chart', 'map', 'roads', 'segments', 'trips', 'grid'];
  const envelope: import('../src/contracts/citation.ts').CitationEnvelope = {
    protocol: 'pi-citation', version: '2.0', citationSetId: 'mixed', generatedAt: '2026-09-18T00:00:00.000Z',
    works: sources.map((id) => ({ workId: id, type: 'REPORT', title: `${id} source` })),
    resources: sources.map((id, index) => ({ resourceId: id, workId: id, kind: 'document', scope: index < 3 ? 'artifact' : 'dataset', relativePath: `${id}.md`, mimeType: 'text/markdown', sha256: 'a'.repeat(64) })),
    locators: sources.map((id) => ({ locatorId: id, resourceId: id })),
    occurrences: [...sources.map((id) => ({ occurrenceId: id, locatorId: id, containerType: 'message' as const, containerId: 'mixed' })), { occurrenceId: 'report-again', locatorId: 'report', containerType: 'message', containerId: 'mixed' }],
    provenance: [],
  };
  const text = '[[cite:chart,roads,report,map,segments,trips,grid]] Again [[cite:chart,report-again]] Missing [[cite:missing]]';
  const entry = { message: { role: 'assistant', content: text } } as any;
  const projected = projectMessageCitations([entry], envelope);
  for (const projection of [projected.byEntry.get(entry), projectCitationText(text, projected.available)]) {
    assert.ok(projection);
    assert.deepEqual(projection!.numbers, { chart: 1, roads: 2, report: 3, map: 4, segments: 5, trips: 6, grid: 7, 'report-again': 3 });
    assert.deepEqual(projection!.unavailableIds, ['missing']);
    assert.equal(projection!.citations.length, 4);
    assert.equal(projection!.artifacts.length, 4);
    const html = renderMarkdown(text, projection!.numbers);
    assert.equal((html.match(/class="citation-marker"/g) || []).length, 9);
    assert.equal((html.match(/class="citation-unavailable"/g) || []).length, 1);
    const copied = citationCopyText(text, projection);
    assert.match(copied, /^\[1\]\[2\]\[3\]\[4\]\[5\]\[6\]\[7\] Again \[1\]\[3\]/);
    const references = copied.split('\n').filter((line) => /^\d+\. /.test(line));
    assert.equal(references.length, 7);
    ['chart', 'roads', 'report', 'map', 'segments', 'trips', 'grid'].forEach((id, index) => {
      assert.ok(references[index].startsWith(`${index + 1}. `));
      assert.ok(references[index].includes(`${id} source`));
    });
  }
  const artifactOnly = projectCitationText('[[cite:report]]', projected.available);
  const copiedArtifact = citationCopyText('[[cite:report]]', artifactOnly);
  assert.match(copiedArtifact, /^\[1\]/);
  assert.match(copiedArtifact, /1\. \*\*(?:《)?report source/);
});
