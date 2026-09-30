const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');

caseTest('Citation compiler assigns report-wide work numbers without mutating source markers', async () => {
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
});

caseTest('Citation compiler exports bibliography exchange formats from Work metadata', async () => {
  const { exportCitationBibliography } = await import('../../src/contracts/citation-compiler.ts');
  const envelope: import('../../src/contracts/citation.ts').CitationEnvelope = {
    protocol: 'pi-citation', version: '2.0', citationSetId: 'set_1', generatedAt: '2026-08-10T00:00:00.000Z',
    works: [{ workId: 'work_1', citekey: 'GBT33170_2_2016', type: 'standard', title: '大型活动安全要求', issuer: '国家市场监督管理总局', issuedAt: '2016', standardNumber: 'GB/T 33170.2-2016' }],
    resources: [], locators: [], occurrences: [], provenance: [],
  };
  assert.match(exportCitationBibliography(envelope, 'bibtex'), /@misc\{GBT33170_2_2016/);
  assert.equal(JSON.parse(exportCitationBibliography(envelope, 'csl-json'))[0].number, 'GB/T 33170.2-2016');
  assert.match(exportCitationBibliography(envelope, 'ris'), /SN  - GB\/T 33170\.2-2016/);
});
