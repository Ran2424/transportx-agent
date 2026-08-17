const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
import type { TestContext } from 'node:test';

test('Citation Service registers controlled dataset results without exposing data rows', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-citation-service-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'peak-hour.csv'), 'road_id,flow\nA001,1830\n');
  const { CitationService } = require('../bin/citation-service.js');
  const service = new CitationService();
  const citations = service.resolveDatasets({ id: 'session_1', cwd }, [{
    path: 'peak-hour.csv', assetId: 'shanghai.flow.2026', version: '2026.08', timeRange: '07:00-09:00', querySummary: '工作日早高峰流量',
  }]);

  assert.equal(citations.resources[0].scope, 'dataset');
  assert.equal(citations.resources[0].kind, 'dataset');
  assert.match(citations.resources[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(citations.locators[0].sourceUnit, 'shanghai.flow.2026 · 2026.08 · 07:00-09:00 · 工作日早高峰流量');
  assert.equal(JSON.stringify(citations).includes('A001,1830'), false);
});

test('Citation Service resolves knowledge cards to verified original PDF resources', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-citation-knowledge-session-'));
  const knowledgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-citation-knowledge-asset-'));
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(knowledgeRoot, { recursive: true, force: true }); });
  const documentRoot = path.join(knowledgeRoot, 'standards', 'sample');
  const original = Buffer.from('%PDF-1.7 sample');
  fs.mkdirSync(path.join(documentRoot, 'source'), { recursive: true });
  fs.mkdirSync(path.join(documentRoot, 'data'), { recursive: true });
  fs.mkdirSync(path.join(knowledgeRoot, '_catalog'), { recursive: true });
  fs.writeFileSync(path.join(documentRoot, 'source', 'original.pdf'), original);
  fs.writeFileSync(path.join(documentRoot, 'document.yaml'), `source_file: source/original.pdf\nsource_sha256: ${crypto.createHash('sha256').update(original).digest('hex')}\nissuer: 测试机构\n`);
  fs.writeFileSync(path.join(knowledgeRoot, '_catalog', 'documents.jsonl'), `${JSON.stringify({ doc_id: 'SAMPLE', path: 'standards/sample', title: '测试规范', document_class: 'STANDARD_SPEC', validation_status: 'accepted' })}\n`);
  fs.writeFileSync(path.join(documentRoot, 'data', 'knowledge.jsonl'), `${JSON.stringify({ knowledge_id: 'K-SAMPLE-000001', statement: '必须分流。', normative_force: 'must', verification_status: 'manual_verified', source_refs: [{ node_id: 'SAMPLE@8.2', pdf_page: 12, printed_page: '10' }] })}\n`);
  const { CitationService } = require('../bin/citation-service.js');
  const citations = new CitationService().resolveKnowledge({ id: 'session_knowledge', cwd, resolvedSessionPlan: { assets: [{ id: 'knowledge:test', kind: 'knowledge', path: knowledgeRoot }] } as any }, ['K-SAMPLE-000001']);

  assert.deepEqual(citations.resources.map((item: any) => ({ scope: item.scope, kind: item.kind, relativePath: item.relativePath })), [{ scope: 'knowledge', kind: 'pdf', relativePath: 'knowledge:test/standards/sample/source/original.pdf' }]);
  assert.deepEqual(citations.locators.map((item: any) => ({ page: item.page, printedPage: item.printedPage, nodeId: item.nodeId })), [{ page: 12, printedPage: '10', nodeId: 'SAMPLE@8.2' }]);
});

test('Citation Service registers JSONL evidence once with multiple line locators', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-citation-jsonl-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'evidence.jsonl'), '{"road":"A001","flow":1830}\n{"road":"A002","flow":920}\n');
  const { CitationService } = require('../bin/citation-service.js');
  const citations = new CitationService().resolveArtifacts({ id: 'session_jsonl', cwd }, [
    { path: 'evidence.jsonl', quote: 'A001 流量 1830', lineStart: 1, lineEnd: 1 },
    { path: 'evidence.jsonl', quote: 'A002 流量 920', lineStart: 2, lineEnd: 2 },
  ]);

  assert.deepEqual(citations.resources.map((item: any) => ({ kind: item.kind, mimeType: item.mimeType })), [{ kind: 'dataset', mimeType: 'application/x-ndjson' }]);
  assert.equal(citations.works.length, 1);
  assert.deepEqual(citations.locators.map((item: any) => [item.lineStart, item.lineEnd]), [[1, 1], [2, 2]]);
});

test('Citation Service reuses an equivalent locator when the same artifact is resolved again', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-citation-repeat-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'result.csv'), 'road_id,flow\nA001,1830\n');
  const { CitationService } = require('../bin/citation-service.js');
  const service = new CitationService();
  service.resolveArtifacts({ id: 'session_repeat', cwd }, [{ path: 'result.csv', quote: 'A001 流量 1830', lineStart: 2, lineEnd: 2 }]);
  const citations = service.resolveArtifacts({ id: 'session_repeat', cwd }, [{ path: 'result.csv', quote: 'A001 流量 1830', lineStart: 2, lineEnd: 2 }]);

  assert.equal(citations.resources.length, 1);
  assert.equal(citations.locators.length, 1);
});

test('Citation Service rejects private and non-HTTPS web targets before fetch', async () => {
  const { publicCitationUrl } = require('../bin/citation-service.js');
  await assert.rejects(publicCitationUrl('http://example.com/report'), /public HTTPS/i);
  await assert.rejects(publicCitationUrl('https://127.0.0.1/report'), /public HTTPS/i);
  await assert.rejects(publicCitationUrl('https://[::1]/report'), /public HTTPS/i);
});
