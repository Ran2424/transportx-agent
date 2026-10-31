import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Shape and IDs emitted by the 3.23.0 citation registry, including provenance.
export function writeLegacyCitationFixture(cwd: string) {
  fs.mkdirSync(path.join(cwd, '.tau'), { recursive: true });
  const original = '# 历史依据\n升级前的来源正文';
  fs.writeFileSync(path.join(cwd, 'original.md'), original);
  const sha256 = crypto.createHash('sha256').update(original).digest('hex');
  const timestamp = '2026-10-15T00:00:00.000Z';
  const registry = {
    protocol: 'pi-citation', version: '2.0', schemaVersion: 1, sessionId: 'legacy_session',
    citationSetId: 'set_legacy', generatedAt: timestamp, updatedAt: timestamp,
    works: [{ workId: 'work_legacy', type: 'report', title: '升级前的报告', issuer: '测试机构' }],
    resources: [
      { resourceId: 'resource_legacy', workId: 'work_legacy', kind: 'document', scope: 'artifact', relativePath: 'original.md', mimeType: 'text/markdown', sha256 },
      { resourceId: 'resource_missing', workId: 'work_legacy', kind: 'document', scope: 'attachment', relativePath: 'missing.md', mimeType: 'text/markdown', sha256: 'b'.repeat(64) },
    ],
    locators: [
      { locatorId: 'locator_legacy', resourceId: 'resource_legacy', section: '历史依据', lineStart: 1, lineEnd: 2, quote: '升级前的归纳' },
      { locatorId: 'locator_missing', resourceId: 'resource_missing', page: 3 },
    ],
    occurrences: [
      { occurrenceId: 'occurrence_legacy', locatorId: 'locator_legacy', containerType: 'message', containerId: 'assistant_legacy', role: 'support' },
      { occurrenceId: 'occurrence_missing', locatorId: 'locator_missing', containerType: 'message', containerId: 'assistant_legacy', role: 'support' },
    ],
    provenance: [{ provenanceId: 'provenance_legacy', fromResourceId: 'resource_legacy', toResourceId: 'resource_missing', relation: 'derived-from' }],
  };
  const file = path.join(cwd, '.tau', 'citations.json'), bytes = JSON.stringify(registry);
  fs.writeFileSync(file, bytes);
  const entries = [
    { type: 'session', version: 3, id: 'legacy_pi_session', timestamp, cwd },
    { type: 'message', id: 'user_legacy', parentId: null, timestamp, message: { role: 'user', content: [{ type: 'text', text: '读取历史报告' }], timestamp: Date.parse(timestamp) } },
    { type: 'message', id: 'assistant_legacy', parentId: 'user_legacy', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: '历史结论 [[cite:occurrence_legacy,occurrence_missing]]' }], timestamp: Date.parse(timestamp) } },
  ];
  return { file, bytes, original, sha256, registry, entries };
}
