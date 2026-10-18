const { test } = require('node:test') as typeof import('node:test');

test('Session, task, Geo, Citation and Bridge contracts validate versions and preserve context', async () => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');

  function fixture(name: string) {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'contracts', `${name}.json`), 'utf8'));
  }

  function diagnosticCodes(result: { diagnostics?: Array<{ code: string }> }) {
    return result.diagnostics?.map((item) => item.code) || [];
  }

  // Presentation is optional and never changes runtime identity or Skill instructions.
  {
    const { parseModuleManifestStructured } = await import('../../src/contracts/module.ts');
    const { modulePresentation, moduleSearchText } = await import('../../src/web/lib/module-presentation.ts');
    const manifest = { manifestVersion: 2, id: 'local.bilingual', name: 'Machine-facing name', version: '1.0.0', type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [], entrypoints: { skills: ['skill/SKILL.md'] }, contributes: { assets: [{ id: 'data:example', kind: 'data', path: 'assets/example' }] } };
    assert.equal(parseModuleManifestStructured(manifest).ok, true);
    assert.equal(modulePresentation(manifest, 'zh-CN').name, manifest.name);
    const presentation = { defaultLocale: 'zh-CN' as const, locales: { 'zh-CN': { name: '站点分析', description: '研究站点覆盖范围。', features: ['计算覆盖范围'] }, 'en-US': { name: 'Station Analysis', description: 'Analyze station coverage.', features: ['Calculate coverage'] } } };
    const asset = { defaultLocale: 'en-US', locales: { 'en-US': { name: 'Station Data', description: 'Station records.' } } };
    const parsed = parseModuleManifestStructured({ ...manifest, presentation: { ...presentation, skills: { 'skill/SKILL.md': presentation }, assets: { 'data:example': asset } } });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error('Valid bilingual presentation was rejected');
    assert.equal(parsed.value.name, manifest.name);
    assert.deepEqual(parsed.value.entrypoints, manifest.entrypoints);
    assert.equal(modulePresentation(parsed.value, 'zh-Hans').name, '站点分析');
    assert.equal(modulePresentation(parsed.value, 'en-GB').name, 'Station Analysis');
    assert.equal(modulePresentation(parsed.value, 'fr-FR').name, '站点分析');
    assert.equal(modulePresentation(parsed.value, 'zh-CN', { assetId: 'data:example' }).name, 'Station Data');
    assert.match(moduleSearchText(parsed.value), /Station Analysis/);
    assert.match(moduleSearchText(parsed.value), /站点分析/);
    assert.equal(parseModuleManifestStructured({ ...manifest, presentation: { ...presentation, defaultLocale: 'en-US', locales: { 'zh-CN': presentation.locales['zh-CN'] } } }).ok, false);
    assert.equal(parseModuleManifestStructured({ ...manifest, presentation: { ...presentation, assets: { 'data:undeclared': asset } } }).ok, false);
    assert.equal(parseModuleManifestStructured({ ...manifest, presentation: { ...presentation, skills: { '../undeclared.md': presentation } } }).ok, false);
    assert.equal(parseModuleManifestStructured({ ...manifest, presentation: { ...presentation, locales: { 'zh-CN': { name: '站点分析', description: '说明', features: 'invalid' } } } }).ok, false);

    // Previously installed official data packages have no presentation field.
    const { LEGACY_MODULE_PRESENTATIONS } = await import('../../src/web/lib/legacy-module-presentation.ts');
    for (const [id, metadata] of Object.entries(LEGACY_MODULE_PRESENTATIONS)) {
      const legacy = { id, name: 'Original package name' };
      for (const language of ['zh-CN', 'en-US'] as const) {
        assert.deepEqual(modulePresentation(legacy, language), metadata.locales[language]);
        for (const assetId of Object.keys(metadata.assets ?? {})) assert.equal(modulePresentation(legacy, language, { assetId }).name, metadata.locales[language]?.name);
      }
      assert.equal(modulePresentation({ ...legacy, presentation }, 'zh-CN').name, '站点分析', 'package-provided display text overrides legacy defaults');
      assert.match(moduleSearchText(legacy), new RegExp(metadata.locales['zh-CN']!.name));
      assert.equal('presentation' in legacy, false, 'compatibility does not modify the package');
    }

    for (const parent of ['modules/capabilities', 'modules/official']) {
      if (!fs.existsSync(parent)) continue;
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        const manifestPath = path.join(parent, entry.name, 'manifest.json');
        if (!entry.isDirectory() || !fs.existsSync(manifestPath)) continue;
        const current = parseModuleManifestStructured(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
        assert.equal(current.ok, true, manifestPath);
        if (!current.ok) continue;
        assert.ok(current.value.presentation?.locales['zh-CN'], manifestPath);
        assert.ok(current.value.presentation?.locales['en-US'], manifestPath);
      }
    }
  }

  // SessionProfile v1 validates task range, outputs and exact Module versions
  {
    const { parseSessionProfileStructured } = await import('../../src/contracts/session-profile.ts');
    const valid = parseSessionProfileStructured({ schemaVersion: 1, task: { kind: 'spatial-analysis', city: '上海', timeRange: { start: '2025-08-22T00:00:00+08:00', end: '2025-08-21T15:00:00+08:00', timezone: 'Asia/Shanghai' }, expectedOutputs: ['map', 'report'] }, modules: { selectionMode: 'explicit', selected: [{ id: 'com.transportx.shanghaidata', version: '2.0.1' }] } });
    assert.equal(valid.ok, false, 'end time cannot precede start time');
    const accepted = parseSessionProfileStructured({ schemaVersion: 1, task: { kind: 'data-query', timeRange: { start: '2025-08-21T15:00:00+08:00', end: '2025-08-22T00:00:00+08:00', timezone: 'Asia/Shanghai' }, expectedOutputs: ['answer'] }, modules: { selectionMode: 'explicit', selected: [{ id: 'com.transportx.shanghaidata', version: '2.0.1' }] } });
    assert.equal(accepted.ok, true);
    const duplicate = parseSessionProfileStructured({ schemaVersion: 1, task: { kind: 'data-query', expectedOutputs: ['answer'] }, modules: { selectionMode: 'explicit', selected: [{ id: 'module', version: '1' }, { id: 'module', version: '2' }] } });
    assert.equal(duplicate.ok, false);
  }

  // Attachment context is built and stripped by the shared contract
  {
    const { ATTACHMENT_CONTEXT_BEGIN, ATTACHMENT_CONTEXT_END, buildAttachmentContext, stripAttachmentContext } = await import('../../src/contracts/attachments.ts');
    const context = buildAttachmentContext([{
      id: 'att_1234567890ab',
      name: 'demand.csv',
      relativePath: 'attachments/demand.csv',
      mimeType: 'text/csv',
      size: 1536,
      sha256: 'a'.repeat(64),
      kind: 'table',
      source: 'picker',
      status: 'ready',
    }]);
    assert.ok(context.startsWith(`\n\n${ATTACHMENT_CONTEXT_BEGIN}\n`));
    assert.ok(context.includes('大小：1.5 KB'));
    assert.ok(context.endsWith(`\n${ATTACHMENT_CONTEXT_END}`));
    assert.equal(stripAttachmentContext(`分析早高峰${context}`), '分析早高峰');
    assert.equal(stripAttachmentContext('没有附件上下文'), '没有附件上下文');
  }

  // SessionSnapshot contract accepts v1 and diagnoses unknown versions explicitly
  {
    const session = fixture('session');
    const contract = await import('../../src/contracts/session.ts');
    const server = require('../../bin/session-projection.js');
    const valid = contract.parseSessionSnapshot(session.valid);
    assert.equal(valid.ok, true);
    if (!valid.ok) throw new Error('valid SessionSnapshot fixture was rejected');
    assert.equal(valid.value.entries.length, 2);
    assert.equal(server.SESSION_SNAPSHOT_SCHEMA_VERSION, 1);

    const invalidVersion = contract.parseSessionSnapshot(session.invalidVersion);
    assert.equal(invalidVersion.ok, false);
    assert.deepEqual(diagnosticCodes(invalidVersion), ['unknown_schema_version']);
    assert.equal(invalidVersion.diagnostics[0].path, 'session.schemaVersion');

    const invalidEntries = contract.parseSessionSnapshot(session.invalidEntries);
    assert.equal(invalidEntries.ok, false);
    assert.deepEqual(diagnosticCodes(invalidEntries), ['invalid_type']);
  }

  // TaskSnapshot contract is shared by Web and diagnoses version/revision failures
  {
    const task = fixture('task');
    const contract = await import('../../src/contracts/task.ts');
    const web = await import('../../src/contracts/task.ts');
    const valid = contract.parseTaskSnapshotStructured(task.valid);
    assert.equal(valid.ok, true);
    if (!valid.ok) throw new Error('valid TaskSnapshot fixture was rejected');
    assert.deepEqual(web.parseTaskSnapshot(task.valid), valid.value);

    const invalidVersion = contract.parseTaskSnapshotStructured(task.invalidVersion);
    assert.equal(invalidVersion.ok, false);
    assert.deepEqual(diagnosticCodes(invalidVersion), ['unknown_schema_version']);

    const invalidRevision = contract.parseTaskSnapshotStructured(task.invalidRevision);
    assert.equal(invalidRevision.ok, false);
    assert.ok(diagnosticCodes(invalidRevision).includes('out_of_range'));

    const stale = contract.parseTaskSnapshot({ ...task.valid, revision: task.staleRevision });
    assert.ok(stale);
    if (!stale) throw new Error('stale TaskSnapshot fixture was not structurally valid');
    const regression = contract.acceptTaskSnapshotRevision(valid.value, stale);
    assert.equal(regression.accepted, false);
    assert.equal(regression.diagnostic?.code, 'revision_regression');
  }

  // Geo envelope contract is shared by Extension/Web and diagnoses version/revision failures
  {
    const geo = fixture('geo');
    const contract = await import('../../src/contracts/geo.ts');
    const web = await import('../../src/contracts/geo.ts');
    const valid = contract.parseVisualizationEnvelopeStructured(geo.valid);
    assert.equal(valid.ok, true);
    if (!valid.ok) throw new Error('valid Geo envelope fixture was rejected');
    assert.deepEqual(web.parseVisualizationEnvelope(geo.valid), valid.value);

    const invalidVersion = contract.parseVisualizationEnvelopeStructured(geo.invalidVersion);
    assert.equal(invalidVersion.ok, false);
    assert.deepEqual(diagnosticCodes(invalidVersion), ['unknown_schema_version']);
    assert.equal(invalidVersion.diagnostics[0].path, 'envelope.version');

    const invalidRevision = contract.parseVisualizationEnvelopeStructured(geo.invalidRevision);
    assert.equal(invalidRevision.ok, false);
    assert.ok(diagnosticCodes(invalidRevision).includes('out_of_range'));

    const stale = contract.parseVisualizationEnvelope({ ...geo.valid, revision: geo.staleRevision });
    assert.ok(stale);
    if (!stale) throw new Error('stale Geo envelope fixture was not structurally valid');
    const regression = contract.acceptEnvelopeRevision(valid.value, stale);
    assert.equal(regression.accepted, false);
    assert.equal(regression.diagnostic?.code, 'revision_regression');
  }

  // Citation v3 stores two record types and rejects old or dangling references.
  {
    const { parseCitationEnvelopeStructured } = await import('../../src/contracts/citation.ts');
    const valid = { protocol: 'pi-citation', version: '3.0', sources: [{ sourceVersionId: 'sv_test', sourceKey: 'session:file.md', title: '交通报告', acquiredAt: '2026-10-16', content: { kind: 'file', scope: 'session', path: 'report.md', mimeType: 'text/markdown', sha256: 'a'.repeat(64), size: 100 } }], evidence: [{ evidenceId: 'e_test', sourceVersionId: 'sv_test', locator: { kind: 'document', section: '结论' }, contentKind: 'summary' }] };
    const parsed = parseCitationEnvelopeStructured(valid);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error('Citation v3 rejected');
    assert.equal(parsed.value.evidence[0].evidenceId, 'e_test');
    assert.equal(parseCitationEnvelopeStructured({ ...valid, version: '2.0' }).ok, false);
    const broken = parseCitationEnvelopeStructured({ ...valid, evidence: [{ ...valid.evidence[0], sourceVersionId: 'missing' }] });
    assert.equal(broken.ok, false); assert.ok(diagnosticCodes(broken).includes('invalid_type'));
  }

  // Bridge compat parser and structured parser share fixtures, capabilities, and diagnostics
  {
    const bridge = fixture('bridge');
    const contract = await import('../../src/contracts/bridge.ts');
    const valid = contract.parsePiWebBridgeEnvelopeStructured(bridge.valid);
    assert.equal(valid.ok, true);
    if (!valid.ok) throw new Error('valid Bridge envelope fixture was rejected');
    assert.deepEqual(contract.parsePiWebBridgeEnvelope(bridge.valid), valid.value);
    assert.equal(valid.value.capabilities.bridgeVersion, 1);
    assert.equal(valid.value.capabilities.geoSceneVersion, '1.0');

    const invalidVersion = contract.parsePiWebBridgeEnvelopeStructured(bridge.invalidVersion);
    assert.equal(invalidVersion.ok, false);
    assert.deepEqual(diagnosticCodes(invalidVersion), ['unknown_schema_version']);

    const invalidRevision = contract.parsePiWebBridgeEnvelopeStructured(bridge.invalidRevision);
    assert.equal(invalidRevision.ok, false);
    assert.ok(diagnosticCodes(invalidRevision).includes('out_of_range'));

    const invalidCapability = contract.parsePiWebBridgeEnvelopeStructured(bridge.invalidCapabilityVersion);
    assert.equal(invalidCapability.ok, false);
    assert.ok(diagnosticCodes(invalidCapability).includes('unknown_schema_version'));

    const stale = contract.parsePiWebBridgeEnvelope({ ...bridge.valid, revision: bridge.staleRevision });
    assert.ok(stale);
    if (!stale) throw new Error('stale Bridge envelope fixture was not structurally valid');
    const regression = contract.acceptBridgeRevision(valid.value, stale);
    assert.equal(regression.accepted, false);
    assert.equal(regression.diagnostic?.code, 'revision_regression');
  }

  // Server refreshes context usage after Pi settles without losing a compaction estimate
  {
    const { LiveSessionManager, PiRpcSession } = require('../../bin/sessions.js');
    const session = new PiRpcSession(new LiveSessionManager(), { cwd: process.cwd() });
    const commands: Array<{ type: string }> = [];
    session.contextUsage = { tokens: 23000, contextWindow: 100000, percent: 23 };
    session.send = async (command: { type: string }) => { commands.push(command); return { success: true }; };
    session.updateStateFromResponse({ command: 'get_session_stats', data: { contextUsage: { tokens: null, contextWindow: 100000, percent: null } } });
    assert.equal(session.metadata().contextUsage.tokens, 23000);
    session.handleEvent({ type: 'agent_settled' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(commands, [{ type: 'get_session_stats' }]);
  }
});
