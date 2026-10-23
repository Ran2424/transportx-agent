// Opt-in real-model acceptance and paired eager/progressive measurements.
// Copies authorized configuration into an isolated Host; removes credentials on exit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const config = process.env.TRANSPORTX_AUTHORING_CONFIG_DIR;
if (!config) throw new Error('Provide TRANSPORTX_AUTHORING_CONFIG_DIR for real-model acceptance');
const model = process.env.TRANSPORTX_AUTHORING_MODEL || 'deepseek/deepseek-v4-flash';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-activation-model-'));
for (const name of ['models.json', 'auth.json']) if (fs.existsSync(path.join(config, name))) fs.copyFileSync(path.join(config, name), path.join(root, name));
const source = path.join(root, 'sum-module'); fs.mkdirSync(source);
fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ manifestVersion: 2, id: 'local.activation-sum', name: 'Road volume sum', version: '1.0.0', type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [], entrypoints: { piExtensions: ['index.ts'], skills: ['SKILL.md'] } }));
fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: road-volume-sum\ndescription: Sum road volumes in a task JSON file using the module tool.\n---\nUse road_volume_sum with a task-relative JSON file containing an array of numbers.\n');
fs.writeFileSync(path.join(source, 'index.ts'), `import fs from 'node:fs'; import path from 'node:path';
export default function(pi) {
 pi.registerCommand('acceptance_eager', {handler:async()=>pi.setActiveTools(pi.getAllTools().filter(t=>!['find','grep','ls','manage_capabilities'].includes(t.name)).map(t=>t.name))});
 pi.registerCommand('acceptance_memory', {handler:async(_,ctx)=>fs.writeFileSync(path.join(ctx.cwd,'.tau','acceptance-memory.json'),JSON.stringify({...process.memoryUsage(),registered:pi.getAllTools().length,active:pi.getActiveTools().length}))});
 pi.registerTool({name:'road_volume_sum',label:'Road volume sum',description:'Sum the numeric road volumes in a task-relative JSON file.',parameters:{type:'object',properties:{inputPath:{type:'string'}},required:['inputPath'],additionalProperties:false},async execute(id,p,signal,update,ctx){
  const file=path.resolve(ctx.cwd,p.inputPath),relative=path.relative(ctx.cwd,file);if(path.isAbsolute(relative)||relative==='..'||relative.startsWith('../'))throw new Error('Use a task-relative file');
  const values=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(values)||!values.every(v=>typeof v==='number'&&Number.isFinite(v)))throw new Error('Expected numeric array');
  const result={sum:values.reduce((a,b)=>a+b,0),count:values.length};return {content:[{type:'text',text:JSON.stringify(result)}],details:{kind:'road-volume-sum',...result}};
 }});
}`);
let stdout = '', stderr = '', endpoint;
const child = spawn(process.execPath, ['bin/tau.js', '--desktop', '--parent-pid', String(process.pid)], { cwd: process.cwd(), env: { ...process.env, TAU_USER_DATA_DIR: root, PI_CODING_AGENT_DIR: root, TAU_APP_ROOT: process.cwd(), TAU_RESOURCES_DIR: process.cwd(), TAU_PI_ENTRYPOINT: path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-3000); });
child.on('message', (message) => {
  if (message.type !== 'transportx-module-trust-request') return;
  assert.equal(message.request.id, 'local.activation-sum');
  child.send({ type: 'transportx-module-trust-response', id: message.id, accepted: true });
});
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check(); if (value) return value;
    if (child.exitCode !== null) throw new Error(`Host exited: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
async function json(url, body) {
  const response = await fetch(endpoint + url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value)); return value;
}
const rpc = (body) => json('/api/rpc', body);
const report = [];
async function run(mode, task, message) {
  const begin = performance.now();
  const session = (await json('/api/live-sessions', { cwd: path.join(root, 'scenario'), model, name: `${mode} ${task}` })).session;
  fs.writeFileSync(path.join(session.cwd, 'volumes.json'), '[10,20,15,7]');
  const snapshot = () => json(`/api/live-sessions/${session.id}/snapshot`);
  assert.equal((await rpc({ type: 'get_state', sessionId: session.id })).success, true);
  const initializedMs = Math.round(performance.now() - begin);
  if (mode === 'eager') assert.equal((await rpc({ type: 'prompt', sessionId: session.id, message: '/acceptance_eager' })).success, true);
  assert.equal((await rpc({ type: 'prompt', sessionId: session.id, message: '/acceptance_memory' })).success, true);
  const piInitializedMemory = JSON.parse(fs.readFileSync(path.join(session.cwd, '.tau/acceptance-memory.json'), 'utf8'));
  const before = (await snapshot()).entries.length;
  const started = performance.now();
  assert.equal((await rpc({ type: 'prompt', sessionId: session.id, message })).success, true);
  const state = await until(async () => { const state = await snapshot(); return !state.isStreaming && state.entries.length > before && state; }, 'real model turn', 300000);
  const messages = state.entries.map((entry) => entry.message).filter(Boolean);
  const assistant = messages.filter((message) => message.role === 'assistant');
  assert.ok(!assistant.some((message) => message.stopReason === 'error'), 'real provider succeeds');
  const tools = messages.filter((message) => message.role === 'toolResult');
  if (task === 'sum') assert.ok(tools.some((tool) => tool.toolName === 'road_volume_sum' && tool.details?.sum === 52 && !tool.isError));
  if (task === 'discovery') {
    assert.ok(tools.some((tool) => tool.toolName === 'manage_capabilities' && ['discover', 'inspect'].includes(tool.details?.action)));
    assert.equal(state.entries.filter((entry) => entry.customType === 'pi-web-bridge').at(-1).data.tools.filter((tool) => tool.active).length, 5);
  }
  if (task === 'geo') assert.ok(tools.some((tool) => tool.toolName === 'inspect_map_context' && !tool.isError));
  const usage = assistant.reduce((sum, message) => { for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) sum[key] += message.usage?.[key] || 0; return sum; }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  report.push({ mode, task, model, initializedMs, piInitializedMemory, elapsedMs: Math.round(performance.now() - started), modelRequests: assistant.length, usage, toolCalls: tools.map((tool) => ({ name: tool.toolName, action: tool.details?.action, isError: !!tool.isError })), sessionFile: state.sessionFile, success: true });
  console.log(JSON.stringify(report.at(-1)));
  await fetch(`${endpoint}/api/live-sessions/${session.id}`, { method: 'DELETE' });
}
try {
  const ready = await until(() => stdout.split('\n').map((line) => { try { return JSON.parse(line); } catch {} }).find((line) => line?.type === 'transportx-agent-host-ready'), 'Host ready');
  endpoint = `http://127.0.0.1:${ready.port}`;
  assert.equal((await rpc({ type: 'install_module', sourcePath: source })).success, true);
  fs.rmSync(source, { recursive: true });
  for (const mode of ['eager', 'progressive']) await run(mode, 'sum', '请使用已装配的 local.activation-sum 模块工具计算 volumes.json 中流量总和与条数。必须调用该模块的业务工具，不用 bash 或自己计算代替。读取 Skill 仅在需要时进行。');
  await run('progressive', 'discovery', '请用能力管理工具查询并介绍本任务地图模块提供哪些工具，只做查询与介绍，不启用模块，不执行地图业务，不创建文件。');
  await run('progressive', 'geo', '请使用本任务的地图模块检查是否收到地图上下文。实际调用其上下文检查工具，不使用 bash 替代；如没有上下文，说明当前没有地图输入。');
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  if (process.env.TRANSPORTX_ACTIVATION_REPORT) fs.writeFileSync(process.env.TRANSPORTX_ACTIVATION_REPORT, JSON.stringify({ evidenceRoot: root, report }, null, 2));
} finally {
  if (child.exitCode === null) { const exited = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; }
  for (const name of ['models.json', 'auth.json']) fs.rmSync(path.join(root, name), { force: true });
  console.log(JSON.stringify({ evidenceRoot: root, credentialsRemoved: true }));
}
