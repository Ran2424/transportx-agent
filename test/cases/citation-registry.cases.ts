const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
import type { TestContext } from 'node:test';

caseTest('Citation Registry persists a complete v2 evidence graph atomically', async (t: TestContext) => {
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
});
