// Real Pi runtime + scripted local provider. No external model credentials or user files are changed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CitationService } = require('../bin/citation-service.js');
const { CanvasService } = require('../bin/canvas-service.js');
const { compileCitations } = require('../bin/contracts/citation-compiler.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-citation-pi-'));
const cwd = path.join(root, 'task'), agent = path.join(root, 'agent'), knowledge = path.join(root, 'knowledge');
for (const directory of [cwd, agent, knowledge]) fs.mkdirSync(directory);
fs.writeFileSync(path.join(knowledge, 'one.md'), '# 分流\n\n分流组织。');
fs.writeFileSync(path.join(knowledge, 'two.md'), '# 接驳\n\n接驳组织。');
const realCsv = process.env.TAU_CITATION_SMOKE_CSV;
fs.writeFileSync(path.join(cwd, 'counts.csv'), realCsv ? fs.readFileSync(realCsv) : 'station,count\nA,12\nB,24\n');
const session = { id: 'citation_pi', cwd, citationRegistryId: 'citation_pi', entries: [], resolvedSessionPlan: { assets: [{ id: 'knowledge:smoke', kind: 'knowledge', path: knowledge }], modules: [{ id: 'com.transportx.document', canvasViews: [{ adapterId: 'com.transportx.canvas.document', kind: 'document', protocolVersion: '1.0' }] }] } };
const citation = new CitationService();
const canvas = new CanvasService(citation, (_session, requested) => path.resolve(cwd, requested));
const inputs = [{ path: 'one.md', assetId: 'knowledge:smoke', locator: { kind: 'document', section: '分流' }, contentKind: 'summary', text: '分流与接驳共同支撑结论。' }, { path: 'two.md', assetId: 'knowledge:smoke', locator: { kind: 'document', section: '接驳' }, contentKind: 'summary', text: '分流与接驳共同支撑结论。' }, { path: 'counts.csv', locator: { kind: 'table', rowStart: 1, rowEnd: 2 }, contentKind: 'result', metadata: { querySummary: '已有只读查询结果；未提供受控执行记录' } }];
let providerCalls = 0, acceptedCanvas;
const host = http.createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    if (req.url.startsWith('/api/internal/')) {
      assert.equal(data.token, 'local-citation-smoke'); assert.equal(data.sessionId, session.id);
      const payload = req.url.endsWith('/citations/resolve') ? { citations: citation.resolve(session, data.sources) } : { canvas: acceptedCanvas = canvas.present(session, data) };
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); return;
    }
    const registry = citation.registry(session).load();
    const marker = `[[cite:${registry.evidence.map((item) => item.evidenceId).join(',')}]]`;
    const tool = providerCalls === 0 ? { name: 'tau_resolve_citation', arguments: JSON.stringify({ sources: inputs }) }
      : providerCalls === 1 ? { name: 'canvas_present', arguments: JSON.stringify({ adapterId: 'com.transportx.canvas.document', resource: { scope: 'capability', moduleId: 'com.transportx.citation', resourceId: registry.sources[0].sourceVersionId }, target: { kind: 'locator', section: '分流' } }) }
      : providerCalls === 2 ? { name: 'write', arguments: JSON.stringify({ path: 'report.md', content: `# 多依据报告\n\n结论 ${marker}\n` }) } : undefined;
    providerCalls += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => ({ id: `smoke-${providerCalls}`, object: 'chat.completion.chunk', created: 1, model: 'smoke', choices: [{ index: 0, delta, finish_reason }] });
    res.write(`data: ${JSON.stringify(chunk(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${providerCalls}`, type: 'function', function: tool }] } : { role: 'assistant', content: `已完成核查。${marker}` }))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk({}, tool ? 'tool_calls' : 'stop'))}\n\n`); res.end('data: [DONE]\n\n');
  } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
});
await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${host.address().port}`;
fs.writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { 'citation-smoke': { baseUrl: `${endpoint}/v1`, api: 'openai-completions', apiKey: 'local-only', models: [{ id: 'smoke', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
const child = spawn(process.execPath, [path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--mode', 'rpc', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--approve', '--extension', path.resolve('modules/capabilities/citation/extensions/pi-citation/index.ts'), '--extension', path.resolve('modules/capabilities/canvas/extensions/pi-canvas/index.ts')], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agent, TAU_CITATION_ENDPOINT: endpoint, TAU_CITATION_SESSION_ID: session.id, TAU_CITATION_TOKEN: 'local-citation-smoke', TAU_CANVAS_ENDPOINT: endpoint, TAU_CANVAS_SESSION_ID: session.id, TAU_CANVAS_TOKEN: 'local-citation-smoke' }, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '', stderr = ''; const events = [], listeners = new Set();
child.stderr.on('data', (chunk) => { stderr += chunk; });
child.stdout.on('data', (chunk) => { buffer += chunk; const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ''; for (const line of lines) { try { events.push(JSON.parse(line)); } catch {} } for (const listener of listeners) listener(); });
function send(value) { child.stdin.write(`${JSON.stringify(value)}\n`); }
function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const check = () => { const value = events.find(predicate); if (value) { clearTimeout(timer); listeners.delete(check); resolve(value); } };
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error(`Pi citation smoke timed out: ${stderr}\n${JSON.stringify(events.slice(-3))}`)); }, 30000);
    listeners.add(check); check();
  });
}
try {
  send({ id: 'model', type: 'set_model', provider: 'citation-smoke', modelId: 'smoke' });
  assert.equal((await waitFor((item) => item.id === 'model')).success, true);
  send({ id: 'prompt', type: 'prompt', message: '核对多来源知识及已有表格结果，登记引用，在 Canvas 定位原件，生成有引用标记的报告。' });
  await waitFor((item) => item.type === 'agent_end');
  assert.equal(providerCalls, 4);
  const registry = citation.registry(session).load();
  assert.equal(registry.sources.length, 3); assert.equal(registry.evidence.length, 3);
  assert.ok(acceptedCanvas); assert.equal(acceptedCanvas.resources[0].scope, 'capability');
  assert.equal(citation.detail(session, registry.evidence[2].evidenceId).preview.kind, 'table');
  const report = fs.readFileSync(path.join(cwd, 'report.md'), 'utf8');
  const compiled = compileCitations(report, citation.registry(session).list());
  assert.equal(compiled.references.length, 3); assert.equal(compiled.unavailableIds.length, 0);
  assert.match(compiled.markdown, /分流/); assert.match(compiled.markdown, /接驳/); assert.match(compiled.markdown, /数据行 1–2/);
  assert.equal(new CitationService().registry(session).load().evidence.length, 3, 'Host restart reads persisted evidence');
  console.log(`Citation real-Pi smoke passed: one-step registration, multi-source markers, pinned Canvas, table details, report compilation and restart. Data: ${realCsv ? 'existing real CSV' : 'fixture'}; knowledge: fixtures; model: scripted local provider.`);
} finally {
  child.kill('SIGTERM'); host.closeAllConnections(); await new Promise((resolve) => host.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
}
