const { test } = require('node:test') as typeof import('node:test');
test('Citation numbering, references and registry persistence stay consistent', async (t) => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { compileCitations, exportCitationBibliography, citationIdsInText, exportCitationMarkdown } = await import('../../src/contracts/citation-compiler.ts');
  const { citationCopyText, projectCitationText, projectMessageCitations } = await import('../../src/web/features/citation/citation-projection.ts');
  const { renderMarkdown } = await import('../../src/public/markdown.ts');
  const envelope: import('../../src/contracts/citation.ts').CitationEnvelope = {
    protocol: 'pi-citation', version: '3.0',
    sources: [{ sourceVersionId: 'sv_one', sourceKey: 'asset:one:standard.pdf', title: '大型活动安全要求', metadata: { issuer: '测试机构', standardNumber: 'GB/T 33170.2-2016' }, acquiredAt: new Date().toISOString(), content: { kind: 'file', scope: 'asset', assetId: 'one', path: 'standard.pdf', mimeType: 'application/pdf', sha256: 'a'.repeat(64), size: 100 } }],
    evidence: [{ evidenceId: 'e_one', sourceVersionId: 'sv_one', locator: { kind: 'document', section: '§8.4', page: 32 }, contentKind: 'summary', text: '归纳说明' }, { evidenceId: 'e_two', sourceVersionId: 'sv_one', locator: { kind: 'document', section: '§9.2', page: 36 }, contentKind: 'source-only' }],
  };
  const text = '依据 [[cite:e_one,e_two]] 再次 [[cite:e_one]] 缺失 [[cite:missing]]';
  const compiled = compileCitations(text, envelope);
  assert.deepEqual(compiled.numbers, { e_one: 1, e_two: 1 });
  assert.equal(compiled.references.length, 1);
  assert.deepEqual(compiled.references[0].evidence.map((item) => item.evidenceId), ['e_one', 'e_two']);
  assert.match(compiled.markdown, /§8.4/); assert.match(compiled.markdown, /§9.2/);
  assert.deepEqual(citationIdsInText('`[[cite:code]]`\n```\n[[cite:code2]]\n```\n[[cite:e_one]]'), ['e_one']);
  const entry = { message: { role: 'assistant', content: text } } as any;
  const projected = projectMessageCitations([entry], envelope);
  const projection = projectCitationText(text, projected.available)!;
  assert.equal(projection.citations.length, 2); assert.deepEqual(projection.unavailableIds, ['missing']);
  const portable = exportCitationMarkdown(text + '\n`[[cite:e_one]]`', envelope);
  assert.match(portable, /§8.4/); assert.match(portable, /§9.2/); assert.match(portable, /`\[\[cite:e_one\]\]`/);
  const copied = citationCopyText(text, projection);
  assert.match(copied, /§8.4/); assert.match(copied, /§9.2/); assert.match(copied, /知识归纳/); assert.equal(copied.includes('原文摘录'), false);
  const html = renderMarkdown(text, projection.numbers);
  assert.match(html, /data-citation-ids="e_one,e_two"/);
  assert.match(html, /引用不可用/);
  assert.doesNotMatch(renderMarkdown('[[cite:toString]]', {}), /class="citation-marker"/);
  for (const format of ['bibtex', 'ris', 'csl-json'] as const) { const exported = exportCitationBibliography(envelope, format); assert.match(exported, /§8.4/); assert.match(exported, /§9.2/); }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'citation-registry-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { CitationRegistryStore } = require('../../bin/citation-registry.js');
  const store = new CitationRegistryStore(cwd, 'session_one');
  store.register(envelope); store.register(envelope);
  assert.equal(store.load().sources.length, 1); assert.equal(store.load().evidence.length, 2);
  assert.equal(store.list(0, 1).nextOffset, 1); assert.equal(store.list(1, 1).evidence[0].evidenceId, 'e_two');
  assert.equal(new CitationRegistryStore(cwd, 'session_one').load().sources[0].sourceVersionId, 'sv_one');
  assert.throws(() => new CitationRegistryStore(cwd, 'other_session').load(), /another session/);
  assert.equal(fs.readdirSync(path.join(cwd, '.tau')).some((name: string) => name.endsWith('.tmp')), false);
  fs.writeFileSync(store.filePath, JSON.stringify({ version: '2.0', userData: 'keep' }));
  assert.throws(() => store.load(), /Unsupported/); assert.match(fs.readFileSync(store.filePath, 'utf8'), /keep/);
  fs.writeFileSync(store.filePath, Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.throws(() => store.load(), /8 MiB/);
});
