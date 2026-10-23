// Locked real Pi + actual HTTP provider requests. Responses are controlled;
// these checks do not claim autonomous model decisions or production Host proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CORE_TOOL_BINDINGS } from '../src/contracts/tool-interface.ts';
import { piRpc } from './harness/activation-pi-rpc.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-activation-p0-'));
const base = ['read', 'write', 'edit', 'bash', 'manage_capabilities'].sort();
const requests = [];
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 100, reserveTokens: 1024 } }));
let pending = [], label = '';
const provider = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const tools = (body.tools || []).map((tool) => tool.function.name).sort();
  requests.push({ label, tools, schemaBytes: Buffer.byteLength(JSON.stringify(body.tools || [])) });
  const next = pending.shift();
  if (next) assert.ok(tools.includes(next.name), `Provider cannot call inactive ${next.name}`);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'activation', object: 'chat.completion.chunk', created: 1, model: 'smoke', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  emit(next ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: next.name, arguments: JSON.stringify(next.input) } }] } : { role: 'assistant', content: 'done' });
  emit({}, next ? 'tool_calls' : 'stop'); res.end('data: [DONE]\n\n');
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ providers: { activation: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: 'local-only', models: [{ id: 'smoke', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
const modules = ['tool-activation', 'geo'].map((name) => {
  const directory = path.resolve('modules/capabilities', name);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  return { id: manifest.id, version: manifest.version, name: manifest.name, description: '', searchText: JSON.stringify(manifest.presentation), extensions: manifest.entrypoints.piExtensions.map((entry) => path.join(directory, entry)), skills: [], contractFiles: (CORE_TOOL_BINDINGS[manifest.id] || []).map((binding) => path.join(directory, binding.file)) };
});
const fixture = path.join(root, 'lifecycle.mjs');
fs.writeFileSync(fixture, `export default function(pi) {
  pi.registerCommand('activation_reload', { handler: async (_,ctx) => { await ctx.reload(); } });
  pi.registerCommand('activation_tree', { handler: async (id,ctx) => { await ctx.navigateTree(id.trim(), {summarize:false}); } });
  pi.registerCommand('activation_compact', { handler: async (_,ctx) => { ctx.compact(); } });
  pi.on('session_before_compact', () => ({ compaction: { summary:'Activation smoke summary', firstKeptEntryId:undefined, tokensBefore:1 } }));
}`);
fs.writeFileSync(path.join(root, 'roads.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [121, 31] } }] }));
let pi = piRpc(root, modules, [fixture]);
const manage = (input) => ({ name: 'manage_capabilities', input });
const active = () => requests.at(-1).tools;
const run = async (name, calls = []) => { label = name; pending = calls; await pi.prompt(name); assert.equal(pending.length, 0); };
try {
  await pi.send('get_state');
  await run('first'); assert.deepEqual(active(), base);
  const initial = (await pi.entries()).find((entry) => entry.customType === 'transportx-tool-activation/v1').id;
  for (const action of ['discover', 'inspect', 'status']) {
    await run(action, [manage({ action, ...(action === 'discover' ? { query: '地图' } : { moduleId: 'com.transportx.geo' }) })]); assert.deepEqual(active(), base);
  }
  await run('enable-and-execute', [manage({ action: 'enable', moduleId: 'com.transportx.geo' }), { name: 'publish_geodata', input: { path: 'roads.geojson' } }]);
  const enabled = active(); assert.equal(enabled.length, 10);
  const entries = await pi.entries();
  assert.ok(entries.some((entry) => entry.message?.toolName === 'publish_geodata' && !entry.message.isError));
  const tip = entries.at(-1).id;
  const recordCount = entries.filter((entry) => entry.data?.kind === 'enable').length;
  await run('enable-repeat', [manage({ action: 'enable', moduleId: 'com.transportx.geo' })]);
  assert.equal((await pi.entries()).filter((entry) => entry.data?.kind === 'enable').length, recordCount);
  await pi.prompt('/activation_reload'); await run('after-reload'); assert.deepEqual(active(), enabled);
  await pi.prompt(`/activation_tree ${initial}`); await run('other-branch'); assert.deepEqual(active(), base);
  await pi.prompt(`/activation_tree ${tip}`); await run('enabled-branch'); assert.deepEqual(active(), enabled);
  const state = (await pi.send('get_state')).response.data;
  const file = state.sessionFile;
  assert.ok(file);
  await pi.close(); pi = piRpc(root, modules, [fixture], file); await pi.send('get_state');
  await run('resume'); assert.deepEqual(active(), enabled);
  const businessCount = (await pi.entries()).filter((entry) => entry.message?.toolName === 'publish_geodata').length;
  assert.equal(businessCount, 1, 'resume never replays business tools');
  // Native compaction preserves custom branch entries independently of summary.
  await pi.send('compact'); await run('after-compact'); assert.deepEqual(active(), enabled);
  await pi.send('fork', { entryId: (await pi.entries()).find((entry) => entry.message?.role === 'user' && entry.message.content?.some((part) => part.text === 'enable-and-execute')).id });
  await run('fork-before-enable'); assert.deepEqual(active(), base);
  const report = { phase: 'P0', pi: '0.80.10', requests, readOnlyActionsPreserveActive: true, sameTurnEnableExecute: true, reload: true, branchIsolation: true, resumeWithoutReplay: true, compaction: true, fork: true };
  const output = process.env.TRANSPORTX_ACTIVATION_REPORT;
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await pi.close(); provider.closeAllConnections(); await new Promise((resolve) => provider.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}
