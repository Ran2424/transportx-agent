const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function fixture(name: string) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'contracts', `${name}.json`), 'utf8'));
}

function diagnosticCodes(result: { diagnostics?: Array<{ code: string }> }) {
  return result.diagnostics?.map((item) => item.code) || [];
}

caseTest('SessionProfile v1 validates task range, outputs and exact Module versions', async () => {
  const { parseSessionProfileStructured } = await import('../../src/contracts/session-profile.ts');
  const valid = parseSessionProfileStructured({ schemaVersion: 1, task: { kind: 'spatial-analysis', city: '上海', timeRange: { start: '2025-08-22T00:00:00+08:00', end: '2025-08-21T15:00:00+08:00', timezone: 'Asia/Shanghai' }, expectedOutputs: ['map', 'report'] }, modules: { selectionMode: 'explicit', selected: [{ id: 'com.transportx.shanghaidata', version: '2.0.1' }] } });
  assert.equal(valid.ok, false, 'end time cannot precede start time');
  const accepted = parseSessionProfileStructured({ schemaVersion: 1, task: { kind: 'data-query', timeRange: { start: '2025-08-21T15:00:00+08:00', end: '2025-08-22T00:00:00+08:00', timezone: 'Asia/Shanghai' }, expectedOutputs: ['answer'] }, modules: { selectionMode: 'explicit', selected: [{ id: 'com.transportx.shanghaidata', version: '2.0.1' }] } });
  assert.equal(accepted.ok, true);
  const duplicate = parseSessionProfileStructured({ schemaVersion: 1, task: { kind: 'data-query', expectedOutputs: ['answer'] }, modules: { selectionMode: 'explicit', selected: [{ id: 'module', version: '1' }, { id: 'module', version: '2' }] } });
  assert.equal(duplicate.ok, false);
});

caseTest('Attachment context is built and stripped by the shared contract', async () => {
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
});

caseTest('SessionSnapshot contract accepts v1 and diagnoses unknown versions explicitly', async () => {
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
});

caseTest('TaskSnapshot contract is shared by Web and diagnoses version/revision failures', async () => {
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
});

caseTest('Geo envelope contract is shared by Extension/Web and diagnoses version/revision failures', async () => {
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
});

caseTest('Citation v2 envelope separates work, resource, locator and occurrence identity', async () => {
  const { parseCitationEnvelopeStructured } = await import('../../src/contracts/citation.ts');
  const valid = {
    protocol: 'pi-citation',
    version: '2.0',
    citationSetId: 'citations:test',
    generatedAt: '2026-07-26T00:00:00.000Z',
    works: [{
      workId: 'work:traffic-report',
      type: 'report',
      title: '交通分析报告',
      author: ['TransportX'],
    }],
    resources: [{
      resourceId: 'resource:report',
      workId: 'work:traffic-report',
      kind: 'document',
      scope: 'artifact',
      relativePath: 'reports/traffic.md',
      mimeType: 'text/markdown',
      sha256: 'a'.repeat(64),
    }],
    locators: [{ locatorId: 'locator:report-conclusion', resourceId: 'resource:report', section: '结论', quote: '拥堵集中在入口。' }],
    occurrences: [{ occurrenceId: 'occ:report-conclusion', locatorId: 'locator:report-conclusion', containerType: 'document', containerId: 'reports/traffic.md', role: 'support' }],
    provenance: [],
  };
  const parsed = parseCitationEnvelopeStructured(valid);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('valid Citation v2 envelope was rejected');
  assert.equal(parsed.value.occurrences[0].occurrenceId, 'occ:report-conclusion');
  const broken = parseCitationEnvelopeStructured({
    ...valid,
    occurrences: [{ occurrenceId: 'occ:report-conclusion', locatorId: 'locator:missing', containerType: 'document', containerId: 'reports/traffic.md' }],
  });
  assert.equal(broken.ok, false);
  assert.ok(diagnosticCodes(broken).includes('invalid_type'));
});

caseTest('Bridge compat parser and structured parser share fixtures, capabilities, and diagnostics', async () => {
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
});

caseTest('Server creates initial capabilities and exposes incompatible Bridge diagnostics at session creation', () => {
  const bridge = fixture('bridge');
  const { LiveSessionManager, PiRpcSession } = require('../../bin/sessions.js');
  const manager = new LiveSessionManager();
  const session = new PiRpcSession(manager, { cwd: process.cwd() });
  const metadata = session.metadata();
  assert.equal(metadata.capabilities.ok, true);
  assert.equal(metadata.capabilities.bridgeVersion, 1);
  assert.equal(metadata.capabilities.taskEnvelopeVersion, 1);
  assert.equal(metadata.capabilities.geoSceneVersion, '1.0');
  assert.deepEqual(metadata.capabilities.mismatches, []);

  const incompatible = new PiRpcSession(manager, {
    cwd: process.cwd(),
    entries: [{ type: 'custom', customType: 'pi-web-bridge', data: bridge.invalidCapabilityVersion }],
  });
  const invalidMetadata = incompatible.metadata();
  assert.equal(invalidMetadata.capabilities.ok, false);
  assert.ok(invalidMetadata.capabilities.diagnostics.some((item: { code: string }) => item.code === 'unknown_schema_version'));
});

caseTest('Server reflects Pi thinking-level change events in live session metadata', () => {
  const { LiveSessionManager, PiRpcSession } = require('../../bin/sessions.js');
  const session = new PiRpcSession(new LiveSessionManager(), { cwd: process.cwd() });
  session.handleEvent({ type: 'thinking_level_changed', level: 'high' });
  assert.equal(session.metadata().thinkingLevel, 'high');
});

caseTest('Server broadcasts only changed live session metadata after the initial snapshot', () => {
  const { LiveSessionManager, PiRpcSession } = require('../../bin/sessions.js');
  const manager = new LiveSessionManager();
  const session = new PiRpcSession(manager, { cwd: process.cwd() });
  manager.sessions.set(session.id, session);
  const broadcasts: Array<{ type?: string; session?: Record<string, unknown> }> = [];
  manager.broadcast = (data: { type?: string; session?: Record<string, unknown> }) => broadcasts.push(data);

  manager.broadcastUpdated(session.id);
  manager.broadcastUpdated(session.id);
  session.handleEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '流式文本' } });
  session.handleEvent({ type: 'agent_start' });
  session.handleEvent({ type: 'agent_start' });

  const updates = broadcasts.filter((item) => item.type === 'live_session_updated');
  assert.equal(updates.length, 2);
  assert.equal(updates[0].session?.resolvedSessionPlan, undefined);
  assert.equal(updates[1].session?.isStreaming, true);
});

caseTest('Server keeps a session busy through compaction until Pi settles', () => {
  const { LiveSessionManager, PiRpcSession } = require('../../bin/sessions.js');
  const session = new PiRpcSession(new LiveSessionManager(), { cwd: process.cwd() });
  session.model = { contextWindow: 100000 };
  session.handleEvent({ type: 'agent_start' });
  session.handleEvent({ type: 'agent_end', willRetry: false });
  assert.equal(session.metadata().isStreaming, true);
  session.handleEvent({ type: 'compaction_start', reason: 'threshold' });
  assert.equal(session.metadata().isCompacting, true);
  session.handleEvent({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false, result: { estimatedTokensAfter: 23000 } });
  assert.equal(session.metadata().isCompacting, false);
  assert.equal(session.metadata().contextUsage.tokens, 23000);
  assert.equal(session.metadata().contextUsage.percent, 23);
  session.handleEvent({ type: 'agent_settled' });
  assert.equal(session.metadata().isStreaming, false);
});

caseTest('Server refreshes context usage after Pi settles without losing a compaction estimate', async () => {
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
});

caseTest('Server keeps context tokens separate from the session usage totals', () => {
  const { LiveSessionManager, PiRpcSession } = require('../../bin/sessions.js');
  const session = new PiRpcSession(new LiveSessionManager(), { cwd: process.cwd() });
  session.updateStateFromResponse({ command: 'get_session_stats', data: {
    contextUsage: { tokens: 9164, contextWindow: 128000, percent: 7.159375 },
    tokens: { input: 2659, output: 361, cacheRead: 6144, cacheWrite: 0, total: 9164 },
  } });
  assert.equal(session.metadata().contextUsage.tokens, 9164);
  assert.equal(session.metadata().contextUsage.percent, 7.159375);
  assert.equal(session.metadata().contextUsage.usage.total, 9164);
});
