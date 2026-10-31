import { createHostConversation, nativeSnapshot, protocolHeaders } from './harness/workspace-client.mjs';
// Opt-in acceptance with an actual configured model. Never a fixed provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-real-authoring-'));
const appRoot = process.cwd();
const configRoot = process.env.TRANSPORTX_AUTHORING_CONFIG_DIR;
if (!configRoot) throw new Error('Set TRANSPORTX_AUTHORING_CONFIG_DIR to an authorized configured user-data directory');
const model = process.env.TRANSPORTX_AUTHORING_MODEL || 'deepseek/deepseek-v4-flash';
for (const name of ['models.json', 'auth.json']) if (fs.existsSync(path.join(configRoot, name))) fs.copyFileSync(path.join(configRoot, name), path.join(root, name));
let output = '', errors = '';
const child = spawn(process.execPath, ['bin/tau.js', '--desktop', '--parent-pid', String(process.pid)], { cwd: appRoot, env: { ...process.env, TAU_USER_DATA_DIR: root, PI_CODING_AGENT_DIR: root, TAU_APP_ROOT: appRoot, TAU_RESOURCES_DIR: appRoot, TAU_PI_ENTRYPOINT: path.join(appRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js') }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
child.stdout.on('data', (value) => { output += value; });
child.stderr.on('data', (value) => { errors = (errors + value).slice(-4000); });
child.on('message', (message) => {
  if (message.type !== 'transportx-module-trust-request') return;
  assert.ok(['local.p4-csv', 'local.p4-missing', 'local.p4-api'].includes(message.request.id));
  child.send({ type: 'transportx-module-trust-response', id: message.id, accepted: true });
});
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check(); if (value) return value;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Host exited: ${errors}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
let endpoint;
async function json(url, body) {
  const response = await fetch(endpoint + url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', ...protocolHeaders }, body: JSON.stringify(body) } : {});
  const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value)); return value;
}
const rpc = (body) => json('/api/rpc', body);
const sessions = [], report = [];
const csv = 'road,hour,volume\nA,08,10\nA,08,20\nA,09,15\nB,08,7\n';
const program = `import csv,json,sys\nfrom collections import defaultdict\ncounts=defaultdict(float)\nwith open(sys.argv[1],newline='',encoding='utf-8') as handle:\n for row in csv.DictReader(handle): counts[(row['road'],row['hour'])]+=float(row['volume'])\npeaks={}\nfor (road,hour),volume in counts.items():\n if road not in peaks or volume>peaks[road]['volume']: peaks[road]={'road':road,'hour':hour,'volume':volume}\nprint(json.dumps(list(peaks.values())))\n`;
const scope = '只读本任务提供的资料，不读取任务外的认证文件，不输出环境变量值。不要安装依赖或修改平台/内置 Python。优先使用模块制作技能。请实际完成，不只给建议。';
async function run(session, message) {
  const before = (await nativeSnapshot(json, session.conversationId)).entries.length;
  assert.equal((await rpc({ type: 'prompt', sessionId: session.id, message })).success, true);
  const state = await until(async () => { const value = await nativeSnapshot(json, session.conversationId); return !value.isStreaming && value.entries.length > before && value; }, 'real model authoring turn', 300000);
  const failed = state.entries.filter((entry) => entry.message?.role === 'assistant').at(-1)?.message;
  if (failed?.stopReason === 'error') throw new Error(`Real model failed: ${String(failed.errorMessage).slice(0, 1000)}`);
  return state;
}
try {
  const ready = await until(() => output.split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((value) => value?.type === 'transportx-agent-host-ready'), 'Host ready');
  endpoint = `http://127.0.0.1:${ready.port}`;
  await until(async () => (await json('/api/health')).dataState === 'ready', 'Host data inventory');
  for (const name of ['csv', 'missing', 'api']) {
    const session = await createHostConversation(json, { parentDirectory: path.join(root, 'scenario'), model, name: `Real authoring ${name}` });
    sessions.push(session);
    fs.mkdirSync(path.join(session.cwd, 'provided'));
    let prompt;
    if (name === 'csv') {
      fs.writeFileSync(path.join(session.cwd, 'provided/peak.py'), program); fs.writeFileSync(path.join(session.cwd, 'provided/volumes.csv'), csv);
      prompt = `把 provided/peak.py 和给定 CSV 样例封装成可安装、可复用的道路高峰小时统计工具。保留原脚本业务逻辑，样例 A 道路08时应为30。模块 ID 使用 local.p4-csv，版本1.0.0。请完成包、样例验证、静态检查并请求安装；本任务授权安装这个测试包。${scope}`;
    } else if (name === 'missing') {
      fs.writeFileSync(path.join(session.cwd, 'provided/solve.py'), 'from ortools.sat.python import cp_model\nprint(cp_model.CpModel())\n');
      prompt = `把 provided/solve.py 封装为可复用工具包 local.p4-missing。先核查当前 Python 是否有 ortools。缺依赖时不要安装依赖，不要声称运行通过或安装工具，只交付草稿包与明确的缺失说明。${scope}`;
    } else {
      fs.writeFileSync(path.join(session.cwd, 'provided/api.md'), '# Private traffic API\nGET https://traffic.example.invalid/counts?road=A\nAuthorization: Bearer <TRANSPORTX_TRAFFIC_API_TOKEN>\nResponse: {"road":"A","volume":30}\nNo token has been supplied.\n');
      prompt = `根据 provided/api.md 制作私有交通 API 工具包 local.p4-api。用户尚未提供凭据；将运行时配置名称固定为 TRANSPORTX_TRAFFIC_API_TOKEN，缺配置时明确说明未执行，不发网络请求、不寻找其他账号密钥，不把密钥写进包或日志。交付可配置草稿，不安装。${scope}`;
    }
    fs.writeFileSync(path.join(session.cwd, 'acceptance-input.txt'), prompt);
    const state = await run(session, prompt);
    const results = state.entries.filter((entry) => entry.message?.role === 'toolResult').map((entry) => entry.message);
    const text = JSON.stringify(state.entries.map((entry) => entry.message?.content || []));
    if (name === 'csv') {
      assert.ok(results.some((item) => item.toolName === 'tau_module_package' && item.details?.action === 'inspect' && !item.isError));
      assert.ok(results.some((item) => item.toolName === 'tau_module_package' && item.details?.installed === true && !item.isError));
    } else {
      assert.ok(!results.some((item) => item.toolName === 'tau_module_package' && item.details?.installed === true));
      assert.match(text, name === 'missing' ? /ortools/ : /TRANSPORTX_TRAFFIC_API_TOKEN/);
    }
    report.push({ case: name, model, sessionFile: state.sessionFile, toolCalls: results.map((item) => ({ name: item.toolName, isError: !!item.isError })), installationVerified: name === 'csv', remaining: name === 'missing' ? 'ortools is unavailable; execution not claimed' : name === 'api' ? 'credential not supplied; API execution not claimed' : null });
    console.log(JSON.stringify({ completed: name, evidenceRoot: session.cwd }));
  }
  const execution = await createHostConversation(json, { parentDirectory: path.join(root, 'scenario'), model, name: 'Execute agent-created module' }); sessions.push(execution);
  fs.writeFileSync(path.join(execution.cwd, 'volumes.csv'), csv);
  const state = await run(execution, '使用刚安装的 local.p4-csv 模块工具处理 volumes.csv。必须调用该工具，不用 bash/python 代替计算。报告 A 道路高峰小时和流量。');
  const results = state.entries.filter((entry) => entry.message?.role === 'toolResult').map((entry) => entry.message);
  const installedRoot = path.join(root, 'modules/local.p4-csv/1.0.0');
  const manifest = JSON.parse(fs.readFileSync(path.join(installedRoot, 'manifest.json'), 'utf8'));
  const sources = manifest.entrypoints.piExtensions.map((entry) => fs.realpathSync(path.join(installedRoot, entry)));
  const bridge = state.entries.filter((entry) => entry.customType === 'pi-web-bridge').at(-1).data;
  const names = new Set(bridge.tools.filter((tool) => tool.sourceInfo?.path && sources.includes(fs.realpathSync(tool.sourceInfo.path))).map((tool) => tool.name));
  assert.ok(results.some((item) => names.has(item.toolName) && !item.isError && /30/.test(JSON.stringify(item.content))), 'a newly assembled real Pi calls the model-created package itself');
  report.push({ case: 'execute_generated_package', sessionFile: state.sessionFile, realCallVerified: true });
  fs.writeFileSync(path.join(root, 'acceptance-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ realModelAuthoring: true, model, evidenceRoot: root, reportFile: path.join(root, 'acceptance-report.json') }));
} finally {
  if (child.exitCode === null && child.signalCode === null) { const exited = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; }
  // Retain generated packages, prompts and Pi JSONL for review; credentials are
  // removed from the isolated acceptance root before it is reported as evidence.
  for (const name of ['models.json', 'auth.json']) fs.rmSync(path.join(root, name), { force: true });
}
