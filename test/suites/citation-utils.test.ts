const { test } = require('node:test') as typeof import('node:test');

test('Citation numbering, references and registry persistence stay consistent', async (t) => {
  {
    const assert = require('node:assert/strict');

    // Citation compiler assigns report-wide work numbers without mutating source markers
    {
      const { compileCitations } = await import('../../src/contracts/citation-compiler.ts');
      const envelope: import('../../src/contracts/citation.ts').CitationEnvelope = {
        protocol: 'pi-citation', version: '2.0', citationSetId: 'set_1', generatedAt: '2026-08-10T00:00:00.000Z',
        works: [{ workId: 'work_1', type: 'S', title: '大型活动安全要求', issuer: '国家市场监督管理总局', standardNumber: 'GB/T 33170.2-2016' }],
        resources: [{ resourceId: 'resource_1', workId: 'work_1', kind: 'pdf', scope: 'knowledge', relativePath: 'standard.pdf', mimeType: 'application/pdf', sha256: 'a'.repeat(64) }],
        locators: [{ locatorId: 'locator_84', resourceId: 'resource_1', clause: '§8.4', page: 32 }, { locatorId: 'locator_92', resourceId: 'resource_1', clause: '§9.2', page: 36 }],
        occurrences: [{ occurrenceId: 'occ_84', locatorId: 'locator_84', containerType: 'document', containerId: 'report.md' }, { occurrenceId: 'occ_92', locatorId: 'locator_92', containerType: 'document', containerId: 'report.md' }],
        provenance: [],
      };
      const source = '第一项依据 [[cite:occ_84]]。\n\n第二项依据 [[cite:occ_92]]。';
      const compiled = compileCitations(source, envelope);
      assert.equal(compiled.numbers.occ_84, 1);
      assert.equal(compiled.numbers.occ_92, 1);
      assert.equal(compiled.references.length, 1);
      assert.match(compiled.markdown, /\[\[cite:occ_84\]\]/);
      assert.match(compiled.markdown, /GB\/T 33170\.2-2016/);
    }
  }

  {
    const assert = require('node:assert/strict');

    // mixed artifact and data citations remain clickable and copy with matching references
    {
      const { citationCopyText, projectMessageCitations, projectCitationText } = await import('../../src/web/features/citation/citation-projection.ts');
      const { renderMarkdown } = await import('../../src/public/markdown.ts');
      const sources = ['report', 'chart', 'map', 'roads', 'segments', 'trips', 'grid'];
      const envelope: import('../../src/contracts/citation.ts').CitationEnvelope = {
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
    }
  }

  {
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');

    // Citation Registry persists a complete v2 evidence graph atomically
    {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-citation-registry-'));
      t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
      const { CitationRegistryStore } = require('../../bin/citation-registry.js');
      const store = new CitationRegistryStore(cwd, 'session_1');
      const registry = store.register({
        protocol: 'pi-citation', version: '2.0', citationSetId: 'set_1', generatedAt: '2026-08-10T00:00:00.000Z',
        works: [{ workId: 'work_1', type: 'standard', title: '大型活动安全要求', standardNumber: 'GB/T 33170.2-2016' }],
        resources: [{ resourceId: 'resource_1', workId: 'work_1', kind: 'pdf', scope: 'knowledge', relativePath: 'standard.pdf', mimeType: 'application/pdf', sha256: 'a'.repeat(64) }],
        locators: [{ locatorId: 'locator_84', resourceId: 'resource_1', clause: '§8.4', page: 32 }],
        occurrences: [{ occurrenceId: 'occ_1', locatorId: 'locator_84', containerType: 'document', containerId: 'report.md', role: 'support' }],
        provenance: [],
      });
      assert.equal(registry.occurrences[0].locatorId, 'locator_84');
      assert.equal(store.resource('resource_1')?.sha256, 'a'.repeat(64));
      const target = path.join(cwd, '.tau', 'citations.json');
      assert.equal(fs.existsSync(target), true);
      assert.equal(fs.readdirSync(path.dirname(target)).some((name: string) => name.endsWith('.tmp')), false);
    }
  }
});
