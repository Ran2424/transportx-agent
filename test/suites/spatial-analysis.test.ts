const { test } = require('node:test') as typeof import('node:test');

test('Controlled spatial operations produce auditable results and reject CRS and path misuse', async (t) => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { SpatialAnalysisService } = require('../../bin/spatial-analysis-service.js');
  const { parseSpatialAnalysisResultStructured } = require('../../bin/contracts/spatial.js');
  const PYTHON = process.env.TAU_PYTHON_COMMAND || 'python3';
  const SCRIPT = path.join(process.cwd(), 'modules/capabilities/spatial-analysis/scripts/spatial_analysis.py');

  function collection(features: any[]) { return { type: 'FeatureCollection', features }; }

  function point(id: string, coordinates: number[], properties: Record<string, unknown> = {}) { return { type: 'Feature', id, properties, geometry: { type: 'Point', coordinates } }; }

  function writeGeo(root: string, name: string, value: unknown) { fs.writeFileSync(path.join(root, name), `${JSON.stringify(value)}\n`); }

  function service() { return new SpatialAnalysisService({ command: PYTHON, args: [], version: '3.10' }, SCRIPT); }

  function session(cwd: string) { return { cwd } as any; }

  {
    const { spatialOwner } = require('../../bin/spatial-owner.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-spatial-owner-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const histories = path.join(root, 'sessions'); fs.mkdirSync(histories);
    const file = path.join(histories, 'owner.jsonl');
    const owner = { cwd: root, sessionFile: file, resolvedSessionPlan: { workspace: root } };
    assert.throws(() => spatialOwner(owner, histories), /ENOENT/);
    fs.writeFileSync(file, JSON.stringify({ type: 'session', id: 'persistent_pi_id', cwd: root }) + '\n');
    const original = spatialOwner(owner, histories);
    assert.deepEqual(original, { historyKey: 'owner.jsonl', piSessionId: 'persistent_pi_id' });
    assert.deepEqual(spatialOwner({ ...owner, id: 'another_live_id' }, histories), original);
    fs.appendFileSync(file, JSON.stringify({ type: 'custom', id: 'branch-entry', parentId: null }) + '\n');
    assert.deepEqual(spatialOwner(owner, histories), original, 'branch entries do not change owner');
    const copied = path.join(histories, 'copy.jsonl'); fs.copyFileSync(file, copied);
    assert.notDeepEqual(spatialOwner({ ...owner, sessionFile: copied }, histories), original, 'raw history copies have distinct owners');
    assert.throws(() => spatialOwner({ ...owner, resolvedSessionPlan: { workspace: histories } }, histories), /mismatch/);
    assert.throws(() => spatialOwner({ ...owner, cwd: histories }, histories), /mismatch/);
    assert.throws(() => spatialOwner(owner, path.join(root, 'outside')), /escapes/);

    const { SpatialInvocations } = require('../../bin/spatial-invocations.js');
    const domain = service(), records = path.join(root, 'executions');
    const invocations = new SpatialInvocations(records, histories, domain);
    writeGeo(root, 'points.geojson', collection([point('a', [121.44, 31.19])]));
    const input = { operation: 'buffer', inputPath: 'points.geojson', inputCrs: 'EPSG:4326', metricCrs: 'EPSG:32651', distanceMeters: 10, toolCallId: 'original-call' };
    const first = invocations.prepare(owner, input);
    assert.equal(invocations.prepare(owner, { ...input }).operationId, first.operationId);
    assert.notEqual(invocations.prepare(owner, { ...input, toolCallId: 'new-intent' }).operationId, first.operationId, 'similar parameters do not identify a retry');
    assert.throws(() => invocations.prepare(owner, { ...input, operationId: first.operationId, distanceMeters: 11 }), (error: any) => error.code === 'spatial_operation_conflict');
    let calculations = 0;
    const dispatch = async (signal: AbortSignal, id: string, onJob: (id: string) => void) => { calculations++; onJob('existing-job-id'); return domain.analyze(owner, input, signal, id); };
    const result = await invocations.execute(owner, { ...input, operationId: first.operationId }, new AbortController().signal, dispatch);
    assert.equal(result.result.analysisId, first.operationId);
    assert.equal((await invocations.execute(owner, { ...input, operationId: first.operationId }, new AbortController().signal, dispatch)).reused, true);
    assert.equal(calculations, 1);
    const restored = new SpatialInvocations(records, histories, domain);
    assert.equal(restored.query({ ...owner, id: 'new_live_id' }, { lookupToolCallId: input.toolCallId }).state, 'succeeded');
    assert.throws(() => restored.query({ ...owner, sessionFile: copied }, { operationId: first.operationId }), (error: any) => error.status === 404);
    writeGeo(root, 'points.geojson', collection([point('changed', [121.45, 31.20])]));
    assert.throws(() => restored.prepare(owner, { ...input, operationId: first.operationId }), (error: any) => error.code === 'spatial_operation_conflict');
    // Recovery reads the committed input versions, not the current source file.
    assert.equal(restored.query(owner, { operationId: first.operationId }).state, 'succeeded');
    const output = path.join(root, result.result.output.relativePath), originalBytes = fs.readFileSync(output);
    fs.writeFileSync(output, '{}');
    assert.equal(restored.query(owner, { operationId: first.operationId }).state, 'unknown');
    fs.writeFileSync(output, originalBytes);
    assert.equal(restored.query(owner, { operationId: first.operationId }).state, 'succeeded');
    const prepared = restored.prepare(owner, { ...input, toolCallId: 'cancel-prepared' });
    assert.equal(restored.cancel(owner, { operationId: prepared.operationId }).state, 'cancelled');
  }

  // CAD writes share the persistent task identity and controlled Python lifecycle.
  {
    const { CadService } = require('../../bin/cad-service.js');
    const { CadInvocations } = require('../../bin/cad-invocations.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-cad-confirmation-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const histories = path.join(root, 'sessions'); fs.mkdirSync(histories);
    const history = path.join(histories, 'owner.jsonl');
    fs.writeFileSync(history, JSON.stringify({ type: 'session', id: 'cad-owner', cwd: root }) + '\n');
    const owner = { cwd: root, conversationId: 'conv_00000000-0000-4000-8000-000000000001', sessionFile: history, resolvedSessionPlan: { workspace: root }, activeCanvasContextIds: [] as string[] };
    const records = path.join(root, 'executions');
    const { CanvasService } = require('../../bin/canvas-service.js');
    const canvas = new CanvasService(null, (session: any, relative: string) => path.join(session.cwd, relative));
    const cad = new CadService({ command: PYTHON, args: [], version: '3.10' }, path.join(process.cwd(), 'modules/capabilities/cad/scripts/cad_engine.py'), (session: any, ids: string[]) => canvas.inspectContexts(session, ids));
    const invocations = new CadInvocations(records, histories, cad);
    writeGeo(root, 'input.geojson', collection([point('a', [121.44, 31.19], { kind: 'signal' }), point('b', [121.441, 31.191], { kind: 'signal' })]));
    const base = { protocol: 'tau-cad', version: '1.0' };
    const request = { ...base, kind: 'from-geojson', fileId: 'plan', sourcePath: 'input.geojson', sourceCrs: 'EPSG:4326', target: { kind: 'local', origin: [121.44, 31.19], rotationDeg: 90, scale: 2 }, layerMap: { signal: 'SIGNAL' }, toolCallId: 'create-plan', contractVersion: '1.0.0' };
    let calculations = 0;
    const dispatch = (signal: AbortSignal, record: any) => { calculations++; return cad.draw(owner, record.request, signal, record.operationId, record.inputSha256); };
    const signal = new AbortController().signal;
    const created = await invocations.execute(owner, request, signal, dispatch);
    assert.equal(created.result.ok, true, JSON.stringify(created));
    assert.equal((await invocations.execute(owner, request, signal, dispatch)).reused, true);
    assert.equal(calculations, 1, 'same tool call never redraws');
    const restored = new CadInvocations(records, histories, cad);
    assert.equal(restored.query({ ...owner, id: 'new-live-id' }, { lookupToolCallId: 'create-plan' }).state, 'succeeded');
    await assert.rejects(restored.execute(owner, { ...request, title: 'different-intent' }, signal, dispatch), (error: any) => error.code === 'cad_operation_conflict');
    const copied = path.join(histories, 'copy.jsonl'); fs.copyFileSync(history, copied);
    assert.throws(() => restored.query({ ...owner, sessionFile: copied }, { operationId: created.operationId }));
    const inspected = await cad.inspect(owner, { ...base, fileId: 'plan', include: ['summary', 'entities'] });
    assert.equal(inspected.drawing.revision, 1);
    assert.equal(inspected.drawing.sourceCrs, 'EPSG:4326');
    assert.equal(inspected.drawing.target.rotationDeg, 90);
    // Exercise the built module's model-facing result, not only the Host details.
    const extension = await import(require('node:url').pathToFileURL(path.resolve('dist/tool-modules/cad/extensions/pi-cad/index.ts')).href);
    const registered: any[] = [];
    extension.default({ registerTool: (tool: any) => registered.push(tool), on() {} });
    const originalFetch = globalThis.fetch;
    const environment = { TAU_CAD_ENDPOINT: process.env.TAU_CAD_ENDPOINT, TAU_CAD_SESSION_ID: process.env.TAU_CAD_SESSION_ID, TAU_CAD_TOKEN: process.env.TAU_CAD_TOKEN };
    try {
      Object.assign(process.env, { TAU_CAD_ENDPOINT: 'http://127.0.0.1', TAU_CAD_SESSION_ID: 'inspect', TAU_CAD_TOKEN: 'test' });
      globalThis.fetch = async () => new Response(JSON.stringify({ result: inspected }));
      const query = await registered.find((tool) => tool.name === 'cad_inspect').execute('inspect-details', { fileId: 'plan', include: ['entities'] }, signal);
      const visible = JSON.parse(query.content[0].text);
      assert.deepEqual(visible.entities, inspected.entities);
      assert.equal(visible.summary.sha256, inspected.summary.sha256, 'model receives the full checksum');
      assert.deepEqual(visible.drawing, inspected.drawing, 'model can continue a versioned edit without reading source files');
    } finally {
      globalThis.fetch = originalFetch;
      for (const [name, value] of Object.entries(environment)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    const handle = inspected.entities[0].handle;
    const edit = { ...base, kind: 'edit', fileId: 'plan', baseRevision: 1, expectedSha256: inspected.summary.sha256, operations: [{ op: 'move', selector: { kind: 'handle', handle }, dx: 3, dy: 0 }], toolCallId: 'move-plan', contractVersion: '1.0.0' };
    await assert.rejects(cad.draw(owner, { ...edit, expectedSha256: 'a'.repeat(64) }), /checksum/);
    const contextId = 'canvas_context_00000000-0000-4000-8000-000000000001';
    const context = { protocol: 'pi-canvas-context', version: '1.0', contextId, adapterId: 'com.transportx.canvas.cad', viewId: 'cad:plan', revision: 1, resources: [{ scope: 'session-file', path: 'cad/plan/r1.dxf' }], selection: { kind: 'cad-selection', handles: [handle], layers: ['SIGNAL'], count: 501, truncated: true, drawingSha256: edit.expectedSha256 }, createdAt: new Date().toISOString() };
    owner.activeCanvasContextIds = [contextId];
    const contextsFile = path.join(root, '.tau/conversations', owner.conversationId, 'canvas-contexts.json');
    fs.mkdirSync(path.dirname(contextsFile), { recursive: true });
    fs.writeFileSync(contextsFile, JSON.stringify({ version: 1, contexts: [context] }));
    assert.equal((await cad.draw(owner, { ...edit, contextId, dryRun: true })).ok, true, 'truncated reference selection does not restrict editing');
    context.selection.count = 1; context.selection.truncated = false;
    fs.writeFileSync(contextsFile, JSON.stringify({ version: 1, contexts: [context] }));
    const widerQuery = await cad.inspect(owner, { ...base, contextId, include: ['entities'], selector: { kind: 'layer', layer: 'SIGNAL' } });
    assert.equal(widerQuery.entities.length, 2, 'explicit queries can inspect outside the reference selection');
    assert.equal((await cad.draw(owner, { ...edit, dryRun: true })).ok, true, 'attached context does not require contextId on explicit versioned edits');
    assert.equal((await cad.draw(owner, { ...edit, contextId, dryRun: true, operations: [{ op: 'delete', selector: { kind: 'layer', layer: 'SIGNAL' } }] })).ok, true, 'selectors are not confined to selected handles');
    const moved = await invocations.execute(owner, { kind: 'edit', contextId, operations: [...edit.operations, { op: 'drawText', layer: 'LABEL', position: [0, 0], text: 'Selected feature', height: 2.5 }], toolCallId: edit.toolCallId }, signal, dispatch);
    assert.equal(moved.result.drawing.revision, 2);
    assert.equal(moved.result.preview, undefined, 'ordinary edits do not render PNG/PDF');
    const after = await cad.inspect(owner, { ...base, fileId: 'plan', include: ['entities'] });
    assert.ok(Math.abs(after.entities[0].bounds.min[0] - inspected.entities[0].bounds.min[0] - 3) < 1e-6, 'move follows drawing X even for rotated/scaled local coordinates');
    await assert.rejects(cad.draw(owner, { ...edit, contextId }), /revision mismatch/);
    // Keep the r1 context attached through r2 -> r3; it is reference information.
    const historical = await cad.present(owner, { resource: { scope: 'session-file', path: 'cad/plan/r1.dxf' } });
    assert.equal(historical.viewId, 'cad:plan@r1');
    assert.equal(historical.revision, 1);
    assert.equal(historical.payload.sha256, inspected.summary.sha256);
    const exported = await cad.verify(owner, { fileId: 'plan', exportPreview: true });
    assert.ok(fs.existsSync(path.join(root, exported.preview.png)));
    assert.equal((await cad.inspect(owner, { fileId: 'plan' })).drawing.revision, 2, 'export never revises a drawing');
    const unknownFile = path.join(root, 'unknown.dxf');
    fs.copyFileSync(path.join(process.cwd(), 'test/cad/fixtures/10_units_missing.dxf'), unknownFile);
    const original = fs.readFileSync(unknownFile);
    const opened = await cad.present(owner, { resource: { scope: 'session-file', path: 'unknown.dxf' } });
    assert.equal(opened.payload.units, null, 'viewing does not guess units');
    const repeated = await cad.present(owner, { resource: { scope: 'session-file', path: 'unknown.dxf' } });
    assert.equal(opened.viewId, repeated.viewId);
    assert.equal(repeated.revision, 1);
    assert.deepEqual(fs.readFileSync(path.join(root, opened.payload.path)), original);
    const unknownEdit = { kind: 'edit', fileId: opened.viewId.slice(4), baseRevision: 1, expectedSha256: opened.payload.sha256, operations: [{ op: 'drawText', layer: 'LABEL', position: [1, 1], text: 'Units confirmed', height: 2.5 }] };
    assert.equal((await cad.draw(owner, unknownEdit)).ok, false, 'editing requires units');
    assert.equal((await cad.draw(owner, { ...unknownEdit, units: 'mm' })).drawing.revision, 2);
    assert.deepEqual(fs.readFileSync(unknownFile), original, 'editing never overwrites the original source');

    // A lost confirmation after the manifest commit is recovered without a new draw.
    const originalCommit = cad.commit.bind(cad);
    cad.commit = (...args: any[]) => { originalCommit(...args); throw new Error('simulated lost confirmation after commit'); };
    const next = { ...edit, baseRevision: 2, expectedSha256: after.summary.sha256, operations: [{ op: 'move', selector: { kind: 'handle', handle: inspected.entities[1].handle }, dx: 0, dy: 1 }], toolCallId: 'lost-response' };
    await assert.rejects(invocations.execute(owner, next, signal, dispatch), /lost confirmation/);
    cad.commit = originalCommit;
    const recovery = new CadInvocations(records, histories, cad).query(owner, { lookupToolCallId: next.toolCallId });
    assert.equal(recovery.state, 'succeeded');
    assert.equal(recovery.result.drawing.revision, 3);
    const outsideEntity = (await cad.inspect(owner, { ...base, fileId: 'plan', include: ['entities'] })).entities.find((entity: any) => entity.handle === inspected.entities[1].handle);
    assert.ok(Math.abs(outsideEntity.bounds.min[1] - inspected.entities[1].bounds.min[1] - 1) < 1e-6, 'r3 can modify an existing entity outside the r1 reference selection');
    assert.equal((await invocations.execute(owner, next, signal, dispatch)).reused, true);
    // Interrupt between output rename and manifest publication; only this generation is removed.
    const current = await cad.inspect(owner, { ...base, fileId: 'plan' });
    const rename = fs.renameSync;
    fs.renameSync = (source: string, target: string) => {
      if (target.endsWith('manifest.json') && target.includes('cad-drawings')) throw new Error('simulated commit interruption');
      return rename(source, target);
    };
    try {
      await assert.rejects(invocations.execute(owner, { ...next, baseRevision: 3, expectedSha256: current.summary.sha256, toolCallId: 'interrupted-before-manifest' }, signal, dispatch), /commit interruption/);
    } finally { fs.renameSync = rename; }
    assert.equal(fs.existsSync(path.join(root, 'cad/plan/r4.dxf')), true);
    assert.equal(restored.query(owner, { lookupToolCallId: 'interrupted-before-manifest' }).state, 'failed');
    assert.equal(fs.existsSync(path.join(root, 'cad/plan/r4.dxf')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.tau/cad-drawings/plan/manifest.json'))).currentRevision, 3);
    const output = path.join(root, recovery.result.drawing.path), bytes = fs.readFileSync(output);
    fs.writeFileSync(output, 'changed externally');
    assert.equal(restored.query(owner, { operationId: recovery.operationId }).state, 'unknown');
    await assert.rejects(cad.inspect(owner, { ...base, fileId: 'plan' }), /checksum/);
    fs.writeFileSync(output, bytes);
    const cancelled = invocations.execute(owner, { ...next, baseRevision: 3, expectedSha256: current.summary.sha256, toolCallId: 'cancel-write' }, signal, (jobSignal: AbortSignal) => new Promise((_resolve, reject) => jobSignal.addEventListener('abort', () => reject(Object.assign(new Error('confirmed stopped'), { code: 'cad_cancelled', commit: 'not_committed' })), { once: true })));
    const cancellation = invocations.cancel(owner, { lookupToolCallId: 'cancel-write' });
    assert.equal(cancellation.cancellationRequested, true);
    assert.equal(cancellation.state, 'running', 'requesting cancellation does not claim execution stopped');
    await assert.rejects(cancelled, /confirmed stopped/);
    assert.equal(invocations.query(owner, { lookupToolCallId: 'cancel-write' }).state, 'cancelled');
    // General-purpose Python -> import -> candidate -> native edit -> observe.
    const { execFileSync } = require('node:child_process');
    execFileSync(PYTHON, ['-c', `
import sys, pathlib, ezdxf
sys.path.insert(0, str(pathlib.Path.cwd()/'modules/capabilities/cad/scripts'))
from cad_operations import apply_operations
root=pathlib.Path(sys.argv[1]); d=ezdxf.new('R2010');d.header['$INSUNITS']=4
d.layers.add('EQUIPMENT');d.layers.add('LABELS');d.blocks.new('SYMBOL').add_line((0,0),(1,0))
line=d.modelspace().add_line((0,0),(10,0),dxfattribs={'layer':'EQUIPMENT'})
apply_operations(d,[{'op':'copy','selector':{'kind':'handle','handle':line.dxf.handle},'dx':20,'dy':0,'count':3}, {'op':'drawText','layer':'LABELS','position':[0,5],'text':'Device','height':2.5,'rotationDeg':45}, {'op':'insertBlock','layer':'EQUIPMENT','name':'SYMBOL','position':[5,5],'rotationDeg':90,'scale':2}])
assert [e.dxf.start.x for e in d.modelspace().query('LINE')]==[0,20,40,60]
assert list(d.modelspace().query('TEXT'))[0].dxf.rotation==45
block=list(d.modelspace().query('INSERT'))[0];assert block.dxf.rotation==90 and block.dxf.xscale==2
d.saveas(root/'equipment.dxf')
`, root]);
    const firstDraft = await cad.draw(owner, { kind: 'import', fileId: 'equipment', sourcePath: 'equipment.dxf', units: 'mm' });
    const initialView = firstDraft.canvas.viewId;
    assert.equal((await cad.present(owner, { resource: { scope: 'session-file', path: 'equipment.dxf' } })).viewId, initialView, 'present reuses explicit import identity');
    const details = await cad.inspect(owner, { fileId: 'equipment', include: ['geometry'] });
    assert.equal(details.entities.find((e: any) => e.type === 'TEXT').geometry.rotationDeg, 45);
    assert.equal(details.entities.find((e: any) => e.type === 'INSERT').geometry.scale[0], 2);
    assert.deepEqual(details.entities.find((e: any) => e.type === 'LINE').geometry.start, [0, 0]);
    execFileSync(PYTHON, ['-c', `import sys,pathlib,ezdxf; p=pathlib.Path(sys.argv[1]);d=ezdxf.readfile(p/'cad/equipment/r1.dxf');d.modelspace().add_circle((30,30),5,dxfattribs={'layer':'EQUIPMENT'});d.saveas(p/'equipment.dxf')`, root]);
    const submit = { kind: 'commit-candidate', fileId: 'equipment', sourcePath: 'equipment.dxf', baseRevision: 1, expectedSha256: firstDraft.drawing.sha256, candidateMode: 'based-on-current', toolCallId: 'python-candidate' };
    await assert.rejects(cad.present(owner, { resource: { scope: 'session-file', path: 'equipment.dxf' } }), /commit-candidate/);
    const previewPlan = await cad.draw(owner, { ...submit, dryRun: true });
    assert.equal(previewPlan.drawing, undefined);
    assert.equal((await cad.inspect(owner, { fileId: 'equipment' })).drawing.revision, 1);
    const candidate = await invocations.execute(owner, submit, signal, dispatch);
    assert.equal(candidate.result.drawing.revision, 2);
    assert.equal(candidate.result.canvas.viewId, initialView);
    assert.equal(candidate.result.canvas.operation, 'update');
    assert.equal((await invocations.execute(owner, submit, signal, dispatch)).reused, true, 'candidate retries reuse durable confirmation');
    await assert.rejects(cad.draw(owner, submit), /revision mismatch/);
    assert.equal((await cad.present(owner, { resource: { scope: 'session-file', path: 'equipment.dxf' } })).viewId, initialView);
    const changed = await cad.inspect(owner, { fileId: 'equipment', include: ['geometry'] });
    assert.equal(changed.entities.find((e: any) => e.type === 'CIRCLE').geometry.radius, 5);
    try {
      Object.assign(process.env, { TAU_CAD_ENDPOINT: 'http://127.0.0.1', TAU_CAD_SESSION_ID: 'candidate', TAU_CAD_TOKEN: 'test' });
      globalThis.fetch = async () => new Response(JSON.stringify({ result: candidate.result, operationId: candidate.operationId }));
      const response = await registered.find((tool) => tool.name === 'cad_draw').execute('candidate-visible', submit, signal);
      const receipt = JSON.parse(response.content[0].text.split('\n').at(-1));
      assert.equal(receipt.presentation.viewId, initialView);
      assert.equal(receipt.presentation.browserRenderConfirmed, false);
      assert.equal(receipt.references.requeryRequired, true);
      assert.equal(receipt.drawing.sha256, candidate.result.drawing.sha256);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [name, value] of Object.entries(environment)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    const native = await cad.draw(owner, { kind: 'edit', fileId: 'equipment', baseRevision: 2, expectedSha256: candidate.result.drawing.sha256, operations: [{ op: 'move', selector: { kind: 'handle', handle: changed.entities.find((e: any) => e.type === 'CIRCLE').handle }, dx: 5, dy: 0 }] });
    assert.equal(native.drawing.revision, 3);
    assert.equal(native.canvas.viewId, initialView);
    const observation = await cad.verify(owner, { fileId: 'equipment', exportPreview: true, previewOptions: { bounds: { min: [20, 10], max: [50, 40] }, layers: ['EQUIPMENT'], width: 800, height: 600 } });
    assert.equal(observation.preview.width, 800);
    assert.equal(observation.preview.height, 600);
    const full = await cad.verify(owner, { fileId: 'equipment', exportPreview: true });
    assert.notEqual(observation.preview.png, full.preview.png, 'local and full previews cannot overwrite each other');
    assert.equal((await cad.inspect(owner, { fileId: 'equipment' })).drawing.revision, 3);
    // A rebuilt candidate also continues this identity; no promise about old handles.
    fs.copyFileSync(path.join(root, native.drawing.path), path.join(root, 'rebuilt.dxf'));
    const rebuild = await cad.draw(owner, { ...submit, sourcePath: 'rebuilt.dxf', candidateMode: 'rebuild', baseRevision: 3, expectedSha256: native.drawing.sha256 });
    assert.equal(rebuild.drawing.revision, 4);
    assert.equal(rebuild.canvas.viewId, initialView);
    const wrongUnits = path.join(root, 'wrong-units.dxf');
    execFileSync(PYTHON, ['-c', `import sys,ezdxf;d=ezdxf.new('R2010');d.header['$INSUNITS']=6;d.modelspace().add_line((0,0),(1,0));d.saveas(sys.argv[1])`, wrongUnits]);
    assert.equal((await cad.draw(owner, { ...submit, sourcePath: 'wrong-units.dxf', baseRevision: 4, expectedSha256: rebuild.drawing.sha256 })).ok, false);
    await assert.rejects(cad.draw(owner, { ...submit, sourcePath: rebuild.drawing.path, baseRevision: 4, expectedSha256: rebuild.drawing.sha256 }), /outside the managed/);
    // Source changes during a dispatched candidate cannot be committed.
    const tamperedSubmit = { ...submit, baseRevision: 4, expectedSha256: rebuild.drawing.sha256, toolCallId: 'candidate-changed' };
    const run = cad.runEngine.bind(cad);
    cad.runEngine = async (...args: any[]) => { const result = await run(...args); fs.appendFileSync(path.join(root, 'equipment.dxf'), 'changed'); return result; };
    try { await assert.rejects(cad.draw(owner, tamperedSubmit), /input changed/); }
    finally { cad.runEngine = run; }
    assert.equal((await cad.inspect(owner, { fileId: 'equipment' })).drawing.revision, 4);
    execFileSync(PYTHON, ['-c', `
import sys,pathlib,ezdxf
p=pathlib.Path(sys.argv[1]);d=ezdxf.new('R2010');d.header['$INSUNITS']=4;d.layers.add('SURFACE')
d.modelspace().add_lwpolyline([(0,0),(10,10),(0,10),(10,0)],close=True,dxfattribs={'layer':'SURFACE'})
b=d.blocks.new('EXTERNAL',dxfattribs={'flags':4,'xref_path':'missing.dxf'});d.modelspace().add_blockref('EXTERNAL',(0,0),dxfattribs={'layer':'SURFACE'})
d.saveas(p/'invalid.dxf')
`, root]);
    const problems = await cad.verify(owner, { path: 'invalid.dxf' });
    assert.equal(problems.ok, false);
    assert.ok(problems.diagnostics.find((d: any) => d.code === 'cad.invalid_boundary').details.entityHandles.length);
    assert.ok(problems.diagnostics.some((d: any) => d.code === 'cad.xref'));
    assert.equal(cad.activeCount, 0);
  }

  // spatial result contract rejects unknown schema, operations and unsafe output paths
  {
    const result = parseSpatialAnalysisResultStructured({ protocol: 'transportx-spatial-analysis', schemaVersion: 2, operation: 'route', output: { relativePath: '../outside.geojson' } });
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((item: any) => item.code === 'unknown_schema_version'));
    assert.ok(result.diagnostics.some((item: any) => item.path === 'spatial.operation'));
  }

  // controlled buffer writes WGS84 GeoJSON and an auditable manifest
  {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-spatial-buffer-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    writeGeo(cwd, 'venues.geojson', collection([point('stadium', [121.44, 31.19])]));
    const result = await service().analyze(session(cwd), { operation: 'buffer', inputPath: 'venues.geojson', inputCrs: 'EPSG:4326', metricCrs: 'EPSG:32651', distanceMeters: 1000 });
    assert.equal(result.operation, 'buffer');
    assert.equal(result.counts.output, 1);
    assert.equal(result.output.crs, 'EPSG:4326');
    assert.ok(result.output.geometryTypes.includes('Polygon'));
    assert.ok(fs.existsSync(path.join(cwd, result.output.relativePath)));
    assert.ok(fs.existsSync(path.join(cwd, '.tau/spatial-results', result.analysisId, 'manifest.json')));
    const { CitationService } = require('../../bin/citation-service.js');
    const citation = new CitationService(), owner = { id: 'spatial_owner', cwd };
    const registered = citation.registerSpatialResult(owner, result);
    assert.equal(registered.sources[0].executionRef.inputHashes[0], result.inputs[0].sha256);
    assert.equal(citation.detail(owner, registered.evidence[0].evidenceId).preview.kind, 'table');
    citation.registerSpatialResult(owner, result);
    assert.equal(citation.registry(owner).load().sources.length, 1, 'registration retry is idempotent');
    fs.writeFileSync(citation.registry(owner).filePath, '{"version":"2.0"}');
    assert.throws(() => citation.registerSpatialResult(owner, result), /Unsupported/);
    assert.ok(fs.existsSync(path.join(cwd, result.output.relativePath)), 'citation failure preserves successful analysis output');

  }

  // controlled nearest preserves unmatched left features and reports metric distance
  {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-spatial-nearest-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    writeGeo(cwd, 'venues.geojson', collection([point('near', [121.44, 31.19]), point('far', [121.50, 31.25])]));
    writeGeo(cwd, 'stations.geojson', collection([point('station-1', [121.4405, 31.19], { name: 'Station One' })]));
    const result = await service().analyze(session(cwd), { operation: 'nearest', leftPath: 'venues.geojson', rightPath: 'stations.geojson', leftCrs: 'EPSG:4326', rightCrs: 'EPSG:4326', metricCrs: 'EPSG:32651', maxDistanceMeters: 1000, rightFields: ['name'] });
    const output = JSON.parse(fs.readFileSync(path.join(cwd, result.output.relativePath), 'utf8'));
    assert.equal(result.counts.output, 2);
    assert.equal(result.counts.unmatched, 1);
    assert.equal(output.features[0].properties.match_status, 'matched');
    assert.ok(output.features[0].properties.nearest_distance_m > 40 && output.features[0].properties.nearest_distance_m < 60);
    assert.equal(output.features[1].properties.match_status, 'unmatched');
  }

  // controlled spatial join records point-to-area matches
  {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-spatial-join-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    writeGeo(cwd, 'points.geojson', collection([point('inside', [1, 1]), point('outside', [3, 3])]));
    writeGeo(cwd, 'areas.geojson', collection([{ type: 'Feature', id: 'district-a', properties: { name: 'A' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] } }]));
    const result = await service().analyze(session(cwd), { operation: 'spatial_join', leftPath: 'points.geojson', rightPath: 'areas.geojson', leftCrs: 'EPSG:4326', rightCrs: 'EPSG:4326', predicate: 'within', cardinality: 'one-to-one', rightFields: ['name'] });
    const output = JSON.parse(fs.readFileSync(path.join(cwd, result.output.relativePath), 'utf8'));
    assert.equal(result.counts.output, 2);
    assert.equal(result.counts.unmatched, 1);
    assert.equal(output.features[0].properties.matched_right_id, 'district-a');
    assert.equal(output.features[0].properties.right_name, 'A');
  }

  // spatial service rejects EPSG:4326 distance and session path escape
  {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-spatial-security-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    writeGeo(cwd, 'input.geojson', collection([point('p', [121, 31])]));
    await assert.rejects(service().analyze(session(cwd), { operation: 'buffer', inputPath: 'input.geojson', inputCrs: 'EPSG:4326', metricCrs: 'EPSG:4326', distanceMeters: 10 }), /metricCrs cannot be EPSG:4326/);
    assert.equal(fs.existsSync(path.join(cwd, 'analysis')), false, 'semantic rejection creates no output directory');
    assert.equal(fs.existsSync(path.join(cwd, '.tau')), false, 'semantic rejection creates no manifest directory');
    await assert.rejects(service().analyze(session(cwd), { operation: 'buffer', inputPath: '../outside.geojson', inputCrs: 'EPSG:4326', metricCrs: 'EPSG:32651', distanceMeters: 10 }), /relative \.geojson|Unsafe/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(service().analyze(session(cwd), { operation: 'buffer', inputPath: 'input.geojson', inputCrs: 'EPSG:4326', metricCrs: 'EPSG:32651', distanceMeters: 10 }, controller.signal), /abort|cancel/i);
    assert.equal(fs.existsSync(path.join(cwd, '.tau/citations.json')), false, 'failed and cancelled analyses never create evidence');
    writeGeo(cwd, 'bad.geojson', collection([{ type: 'Feature', geometry: { type: 'Unsupported', coordinates: [] }, properties: {} }]));
    await assert.rejects(service().analyze(session(cwd), { operation: 'buffer', inputPath: 'bad.geojson', inputCrs: 'EPSG:4326', metricCrs: 'EPSG:32651', distanceMeters: 10 }), (error: any) => error.code === 'spatial_execution_failed' && error.commit === 'not_committed');
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.tau/spatial-results')), [], 'confirmed Python failure cleans only this call directories');
    assert.deepEqual(fs.readdirSync(path.join(cwd, 'analysis/spatial')), []);
  }
});
