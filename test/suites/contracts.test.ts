const { test } = require('node:test') as typeof import('node:test');

test('Session, Geo, Citation, Bridge and CAD contracts validate versions and preserve context', async () => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');

  function fixture(name: string) {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'contracts', `${name}.json`), 'utf8'));
  }

  function diagnosticCodes(result: { diagnostics?: Array<{ code: string }> }) {
    return result.diagnostics?.map((item) => item.code) || [];
  }

  // Persistent identity is independent from live metadata and never accepts a client history path.
  {
    const workspace = await import('../../src/contracts/workspace.ts');
    const { defaultSessionProfile } = await import('../../src/contracts/session-profile.ts');
    const id = 'ws_00000000-0000-4000-8000-000000000001';
    const conversationId = 'conv_00000000-0000-4000-8000-000000000002';
    const input = { requestId: 'create-1', workspace: { kind: 'new', name: '上海分析' }, name: '首次分析', domainId: 'com.transportx.workbench', model: 'probe/model', profile: defaultSessionProfile() };
    assert.equal(workspace.parseCreateConversationStructured(input).ok, true);
    assert.equal(workspace.parseCreateConversationStructured({ ...input, cwd: '/tmp/arbitrary' }).ok, false);
    assert.equal(workspace.parseCreateConversationStructured({ ...input, model: undefined }).ok, false);
    assert.equal(workspace.parseCreateConversationStructured({ ...input, profile: defaultSessionProfile([], 'compat-default') }).ok, false);
    assert.equal(workspace.parseCreateConversationStructured({ ...input, workspace: { kind: 'existing', workspaceId: id, expectedRevision: 0, defaultsRevision: 0 }, model: undefined, profile: undefined, domainId: undefined }).ok, true);
    assert.equal(workspace.parseCreateConversationStructured({ ...input, workspace: { kind: 'existing', workspaceId: id, defaultsRevision: 0 } }).ok, false, 'existing workspace creation checks management and defaults revisions');
    assert.equal(workspace.parseCreateConversationStructured({ ...input, workspace: { kind: 'existing', workspaceId: id, expectedRevision: 0, defaultsRevision: 0, parentDirectory: '/tmp' } }).ok, false);
    assert.equal(workspace.parseCreateConversationStructured({ ...input, name: 'x'.repeat(121) }).ok, false);
    const at = '2026-10-25T00:00:00.000Z';
    const record = { id: conversationId, creationRequestId: null, creationInputSha256: null, name: '旧历史', createdAt: at, updatedAt: at, defaultsRevision: null, modelSpec: null, appendSystemPrompt: '', state: 'ready', history: { key: 'old/history.jsonl', headerId: 'pi-original-id' }, plan: null, privateState: 'needs-review', lastStartFailure: null, deletion: null };
    const manifest = { schemaVersion: 1, id, revision: 0, name: '工作区', createdAt: at, updatedAt: at, defaultsRevision: 0, defaults: { domainId: null, modelSpec: null, profile: null }, citationRegistryId: 'legacy-registry', conversations: [record] };
    assert.equal(workspace.parseWorkspaceManifestStructured(manifest).ok, true, 'unknown original plans remain unknown during migration');
    assert.equal(workspace.parseWorkspaceManifestStructured({ ...manifest, conversations: [{ ...record, creationRequestId: 'new', creationInputSha256: 'a'.repeat(64) }] }).ok, false, 'newly committed conversations require their own plan');
    assert.equal(workspace.parseWorkspaceManifestStructured({ ...manifest, conversations: [{ ...record, plan: { path: `conversations/${conversationId}/plan.json`, source: 'legacy-workspace' } }] }).ok, true);
    assert.equal(workspace.parseWorkspaceManifestStructured({ ...manifest, conversations: [{ ...record, history: { ...record.history, key: '../outside.jsonl' } }] }).ok, false);
    assert.equal(workspace.parseWorkspaceManifestStructured({ ...manifest, conversations: [record, record] }).ok, false);
    assert.equal(workspace.parseWorkspaceManifestStructured({ ...manifest, token: 'never-persist' }).ok, false);
    const tombstone = { workspaceId: id, path: '/managed/original', creationRequestId: null, creationInputSha256: null, state: 'deleted', deletion: { requestId: 'delete-1', manifestRevision: 1, historyKeys: ['old/history.jsonl'], invocationOwnerKeys: [], stage: 'workspace-cleaned' } };
    assert.equal(workspace.parseWorkspaceCatalogStructured({ schemaVersion: 1, revision: 2, entries: [tombstone] }).ok, true);
    assert.equal(workspace.parseWorkspaceCatalogStructured({ schemaVersion: 1, revision: 2, entries: [{ ...tombstone, deletion: null }] }).ok, false, 'deleted catalog entries retain deletion targets');
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

  // CAD contracts keep the draw/edit/verify authoritative shapes and reject unsafe input
  {
    const cad = await import('../../src/contracts/cad.ts');
    const canvas = await import('../../src/contracts/canvas.ts');
    const canvasCad = await import('../../src/contracts/canvas-cad.ts');
    const sha = 'a'.repeat(64);
    const base = { protocol: 'tau-cad', version: '1.0' };

    const request = {
      ...base,
      kind: 'from-geojson',
      sourcePath: 'analysis/spatial/result.geojson',
      sourceCrs: 'EPSG:4326',
      target: { kind: 'epsg', code: 'EPSG:32651' },
      layerMap: { roads: 'ROAD-CENTERLINE', buffers: 'LANDUSE-300' },
      fileId: 'junction_plan',
      dryRun: true,
    };
    const candidateRequest = { protocol: 'tau-cad', version: '1.0', kind: 'commit-candidate', fileId: 'layout', sourcePath: 'candidate.dxf', baseRevision: 1, expectedSha256: 'a'.repeat(64), candidateMode: 'rebuild' };
    assert.equal(cad.parseCadDrawRequestStructured(candidateRequest).ok, true);
    assert.equal(cad.parseCadDrawRequestStructured({ ...candidateRequest, expectedSha256: undefined }).ok, false);
    assert.equal(cad.parseCadDrawRequestStructured({ ...candidateRequest, candidateMode: 'preserve-handles-guaranteed' }).ok, false);
    assert.equal(cad.parseCadVerifyRequestStructured({ protocol: 'tau-cad', version: '1.0', fileId: 'layout', exportPreview: true, previewOptions: { width: 4097 } }).ok, false);
    assert.equal(cad.parseCadVerifyRequestStructured({ protocol: 'tau-cad', version: '1.0', fileId: 'layout', previewOptions: { width: 800 } }).ok, false);
    assert.equal(cad.parseCadVerifyRequestStructured({ protocol: 'tau-cad', version: '1.0', fileId: 'layout', exportPreview: true, previewOptions: { bounds: { min: [1, 0], max: [0, 1] } } }).ok, false);
    const parsedRequest = cad.parseCadDrawRequestStructured(request);
    assert.equal(parsedRequest.ok, true);
    if (!parsedRequest.ok || parsedRequest.value.kind !== 'from-geojson') throw new Error('Valid CAD GeoJSON request was rejected');
    assert.equal(parsedRequest.value.units, 'm');
    assert.equal(parsedRequest.value.dryRun, true);
    assert.equal(cad.parseCadDrawRequestStructured({ ...request, surprise: true }).ok, false);
    assert.ok(diagnosticCodes(cad.parseCadDrawRequestStructured({ ...request, sourcePath: '../secret.geojson' })).includes('unsafe_value'));
    assert.equal(cad.parseCadDrawRequestStructured({ ...request, units: 'mm' }).ok, false);
    assert.equal(cad.parseCadDrawRequestStructured({ ...request, target: undefined }).ok, false);

    const edit = {
      ...base,
      kind: 'edit',
      fileId: 'junction_plan',
      baseRevision: 3,
      expectedSha256: sha,
      operations: [
        { op: 'move', selector: { kind: 'layer', layer: 'SIGNAL' }, dx: 2, dy: 0 },
        { op: 'drawPolyline', layer: 'MARKING', points: [[0, 0], [10, 0]], closed: false },
        { op: 'drawText', layer: 'LABEL', position: [0, 0], text: '路口', height: 2.5 },
        { op: 'drawHatch', layer: 'PAVEMENT', boundary: [[0, 0], [10, 0], [10, 10]] },
        { op: 'insertBlock', layer: 'SIGNAL', name: 'SIGNAL_HEAD', position: [0, 0] },
      ],
      dryRun: false,
    };
    assert.equal(cad.parseCadDrawRequestStructured(edit).ok, true);
    assert.equal(cad.parseCadDrawRequestStructured({ ...edit, baseRevision: undefined }).ok, false);
    assert.equal(cad.parseCadDrawRequestStructured({ ...edit, expectedSha256: undefined }).ok, false);
    assert.equal(cad.parseCadDrawRequestStructured({ ...request, sourceCrs: undefined }).ok, false);
    assert.equal(cad.parseCadDrawRequestStructured({ ...edit, operations: [{ op: 'copy', selector: { kind: 'layer', layer: 'SIGNAL' }, dx: 0, dy: 0, count: 101 }] }).ok, false);
    assert.equal(cad.parseCadDrawRequestStructured({ ...base, kind: 'import', sourcePath: 'uploads/plan.dxf', units: 'mm' }).ok, true);
    assert.equal(cad.parseCadDrawRequestStructured({ ...base, kind: 'import', sourcePath: 'uploads/plan.dwg' }).ok, false);

    assert.equal(cad.parseCadInspectRequestStructured({ ...base, fileId: 'junction_plan', include: ['summary', 'layers'], limit: 50 }).ok, true);
    assert.equal(cad.parseCadInspectRequestStructured({ ...base, fileId: 'junction_plan', path: 'cad/junction_plan/r1.dxf' }).ok, false);
    assert.equal(cad.parseCadVerifyRequestStructured({ ...base, fileId: 'junction_plan', revision: 2 }).ok, true);
    assert.equal(cad.parseCadVerifyRequestStructured({ ...base, path: 'cad/junction_plan/r1.dxf', revision: 2 }).ok, false);

    const drawResult = {
      ...base,
      ok: true,
      dryRun: false,
      drawing: {
        fileId: 'junction_plan',
        revision: 1,
        path: 'cad/junction_plan/r1.dxf',
        sha256: sha,
        bytes: 100,
        units: 'm',
        extents: { min: [0, 0], max: [10, 10] },
        layerCount: 3,
        entityCount: 4,
      },
      preview: { png: 'cad/junction_plan/r1.png', width: 1200, height: 800, dpi: 150 },
      checks: [{ id: 'units', status: 'pass', message: 'units ok' }],
      warnings: [],
      diagnostics: [],
    };
    const parsedDrawResult = cad.parseCadDrawResultStructured(drawResult);
    assert.equal(parsedDrawResult.ok, true);
    if (!parsedDrawResult.ok) throw new Error('Valid CAD draw result was rejected');
    assert.equal(parsedDrawResult.value.drawing?.revision, 1);
    const missingUnits = { ...drawResult, drawing: { ...drawResult.drawing, units: undefined } };
    assert.equal(cad.parseCadDrawResultStructured(missingUnits).ok, false);
    assert.ok(diagnosticCodes(cad.parseCadDrawResultStructured(missingUnits)).includes('missing_required_field'));
    assert.equal(cad.parseCadDrawResultStructured({ ...drawResult, drawing: { ...drawResult.drawing, sha256: 'not-a-hash' } }).ok, false);

    const inspectResult = {
      ...base,
      summary: { units: 'm', extents: { min: [0, 0], max: [10, 10] }, layerCount: 2, entityCount: 2, blockCount: 0, sha256: sha },
      layers: [{ name: 'SIGNAL', entityCount: 1, color: 3, linetype: 'CONTINUOUS' }],
      entities: [{ handle: '2F', type: 'POINT', layer: 'SIGNAL', bounds: { min: [0, 0], max: [0, 0] } }],
      blocks: [],
      textStyles: [{ name: 'CJK', font: 'Microsoft YaHei' }],
      warnings: [],
    };
    assert.equal(cad.parseCadInspectResultStructured(inspectResult).ok, true);
    assert.equal(cad.parseCadInspectResultStructured({ ...inspectResult, entities: [{ handle: '2F', type: 'FOO', layer: 'SIGNAL' }] }).ok, false);
    assert.equal(cad.parseCadVerifyResultStructured({ ...base, ok: true, checks: [{ id: 'units', status: 'pass', message: 'ok' }], diagnostics: [] }).ok, true);

    const manifest = {
      protocol: 'tau-cad-drawing',
      version: '1.0',
      drawingId: 'junction_plan',
      fileId: 'junction_plan',
      title: '路口平面图',
      currentRevision: 1,
      revisions: [{ revision: 1, path: 'cad/junction_plan/r1.dxf', sha256: sha, bytes: 100, createdAt: '2026-10-23T00:00:00Z' }],
      units: 'm',
      target: { kind: 'epsg', code: 'EPSG:32651' },
      createdAt: '2026-10-23T00:00:00Z',
      updatedAt: '2026-10-23T00:00:00Z',
    };
    assert.equal(cad.parseCadDrawingManifestStructured(manifest).ok, true);
    assert.equal(cad.parseCadDrawingManifestStructured({ ...manifest, currentRevision: 2 }).ok, false);

    // CAD Canvas payloads are bounded adapter-owned values and reject unsafe paths.
    const cadPayload = {
      format: 'dxf', path: 'cad/junction_plan/r1.dxf', sha256: sha, units: 'm',
      layerCount: 3, entityCount: 4, preview: 'cad/junction_plan/r1.png',
    };
    assert.equal(canvasCad.parseCadCanvasPayload(cadPayload)?.format, 'dxf');
    assert.equal(canvasCad.parseCadCanvasPayload({ ...cadPayload, path: '../secret.dxf' }), null);
    assert.equal(canvasCad.parseCadCanvasPayload({ ...cadPayload, preview: 'C:/secret.png' }), null);
    assert.deepEqual(canvasCad.parseCadCanvasTarget({ kind: 'viewport', center: [10, 20], zoom: 1, units: 'm' })?.center, [10, 20]);
    assert.equal(canvasCad.parseCadCanvasTarget({ kind: 'viewport', center: [10, 20], zoom: 0, units: 'm' }), null);
    const selection = { kind: 'cad-selection', handles: ['2F', 'A1'], layers: ['SIGNAL'], count: 2, truncated: false };
    assert.deepEqual(canvasCad.parseCadCanvasSelection(selection)?.handles, ['2F', 'A1']);
    assert.equal(canvasCad.parseCadCanvasSelection({ ...selection, handles: ['not-a-handle'] }), null);
    assert.equal(canvasCad.parseCadCanvasSelection({ ...selection, count: 1 }), null);

    const canvasPresentation = {
      protocol: 'pi-canvas', version: '1.0', presentationId: 'cad_pres_test', adapterId: canvasCad.CAD_CANVAS_ADAPTER_ID,
      kind: 'cad', viewId: 'cad:junction_plan', revision: 1, operation: 'present', title: '路口平面图',
      resources: [{ scope: 'session-file', path: 'cad/junction_plan/r1.dxf' }],
      payload: cadPayload, target: { kind: 'viewport', center: [10, 20], zoom: 1, units: 'm' },
      generatedAt: '2026-10-23T00:00:00Z',
    };
    assert.equal(canvas.parseCanvasPresentation(canvasPresentation)?.adapterId, canvasCad.CAD_CANVAS_ADAPTER_ID);
    assert.equal(cad.parseCadDrawResultStructured({ ...drawResult, canvas: canvasPresentation }).ok, true);
  }

  // Server refreshes context usage after Pi settles without losing a compaction estimate
  {
    const { LiveSessionManager, PiRpcSession } = require('../../bin/sessions.js');
    const session = new PiRpcSession(new LiveSessionManager(), { conversationId: 'conv_00000000-0000-4000-8000-000000000001', cwd: process.cwd() });
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
