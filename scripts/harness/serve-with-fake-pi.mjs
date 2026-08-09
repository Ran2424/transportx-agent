#!/usr/bin/env node
// serve-with-fake-pi — 进程内启动真实 Tau server，注入 fake-pi 作为 pi 子进程。
//
// 用法：node scripts/harness/serve-with-fake-pi.mjs --port <端口> [--scenario <场景.json>]
// 启动后 stdout 打印一行：TAU_FAKE_READY {"baseUrl","tempRoot","sessionsDir","resumeFile","longHistoryFile",...}
// 之后保持运行（供 playwright 脚本驱动）；SIGTERM/SIGINT 时清理临时目录并退出。
//
// 使用独立环境目录，但 server 在进程内起以便
// 通过 _setSpawnPiForTest 注入 mock spawn（bin/tau.js 需先 build）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FAKE_PI = path.join(REPO_ROOT, 'scripts', 'harness', 'fake-pi.mjs');

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

const scenarioPath = path.resolve(argValue('--scenario', path.join(REPO_ROOT, 'scripts', 'harness', 'scenarios', 'baseline.json')));
const port = Number(argValue('--port', 0)) || (await freePort());

// ---- 隔离环境（必须在 require bin/tau.js 之前设置，config 在加载时读取） ----
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-fake-pi-'));
const agentDir = path.join(tempRoot, 'agent');
const sessionsDir = path.join(agentDir, 'sessions');
const projectsDir = path.join(tempRoot, 'projects');
fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(projectsDir, { recursive: true });
fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'kimi-coding': { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', models: [{ id: 'k2p7', name: 'Fake K2P7', reasoning: true }] } } }));
fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({ 'kimi-coding': { type: 'api_key', key: 'fake-smoke-key' } }));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_SESSION_DIR = sessionsDir;
process.env.TAU_PROJECTS_DIR = projectsDir;
process.env.TAU_STATIC_DIR = path.join(REPO_ROOT, 'public');
process.env.TAU_HOST = '127.0.0.1';
process.env.PI_OFFLINE = '1';

// ---- 预置会话文件：resume 基线（straight fixture，cwd 重写进临时任务目录） ----
function sessionDirName(tag) { return `--tau-fake-${tag}--`; }

function writeSeededSession(tag, lines) {
  const dir = path.join(sessionsDir, sessionDirName(tag));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

function loadStraightFixture(cwd) {
  const fixture = path.join(REPO_ROOT, 'test', 'fixtures', 'sessions', 'straight-session.jsonl');
  return fs.readFileSync(fixture, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const entry = JSON.parse(line);
    if (entry.type === 'session') entry.cwd = cwd;
    return entry;
  });
}

const resumeCwd = path.join(projectsDir, 'resume-task');
fs.mkdirSync(resumeCwd, { recursive: true });
const resumeFile = writeSeededSession('resume', loadStraightFixture(resumeCwd));

// ---- 预置长会话（200 条消息历史，首次渲染性能基线） ----
function buildLongHistory(cwd, turns = 100) {
  const lines = [{ type: 'session', version: 3, id: 'fake-long-history', timestamp: '2026-07-20T04:00:00.000Z', cwd }];
  let parentId = null;
  for (let turn = 0; turn < turns; turn++) {
    const userId = `lh-u-${String(turn).padStart(4, '0')}`;
    lines.push({ type: 'message', id: userId, parentId, timestamp: `2026-07-20T04:${String(turn).padStart(2, '0')}:00.000Z`, message: { role: 'user', content: [{ type: 'text', text: `第 ${turn + 1} 轮：查一下路段 ${turn + 1} 的拥堵情况` }], timestamp: 1784565600000 + turn * 2000 } });
    const assistantId = `lh-a-${String(turn).padStart(4, '0')}`;
    lines.push({ type: 'message', id: assistantId, parentId: userId, timestamp: `2026-07-20T04:${String(turn).padStart(2, '0')}:01.000Z`, message: { role: 'assistant', content: [{ type: 'thinking', thinking: `思考第 ${turn + 1} 轮查询。`, thinkingSignature: 'FAKE' }, { type: 'text', text: `路段 ${turn + 1} 拥堵指数 1.${turn % 9}，平均车速 ${30 - (turn % 15)}km/h。` }], provider: 'kimi-coding', model: 'k2p7', usage: { input: 500, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 540, cost: { total: 0 } }, stopReason: 'stop', timestamp: 1784565601000 + turn * 2000 } });
    parentId = assistantId;
  }
  return lines;
}
const longCwd = path.join(projectsDir, 'long-history-task');
fs.mkdirSync(longCwd, { recursive: true });
const longHistoryFile = writeSeededSession('long-history', buildLongHistory(longCwd));

// ---- 启动 server 并注入 fake-pi ----
const tau = require(path.join(REPO_ROOT, 'bin', 'tau.js'));
const children = new Set();
tau._setSpawnPiForTest((cmd, args, opts) => {
  const child = spawn(process.execPath, [FAKE_PI, ...args], {
    cwd: opts.cwd,
    env: { ...opts.env, FAKE_PI_SCENARIO: scenarioPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  child.stderr.on('data', (chunk) => process.stderr.write(`[fake-pi:${child.pid}] ${chunk}`));
  return child;
});

let cleanedUp = false;
async function shutdown(exitCode) {
  if (cleanedUp) return;
  cleanedUp = true;
  try { await tau.liveManager.shutdown(); } catch {}
  for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  process.exit(exitCode);
}
process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));

tau.listen(port);
const baseUrl = `http://127.0.0.1:${port}`;
// listen 是异步绑定；健康检查后再宣布 ready
const deadline = Date.now() + 10000;
for (;;) {
  try {
    const response = await fetch(`${baseUrl}/api/health`);
    if (response.ok) break;
  } catch {}
  if (Date.now() > deadline) {
    process.stderr.write('[serve-with-fake-pi] health check timed out\n');
    await shutdown(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
process.stdout.write(`TAU_FAKE_READY ${JSON.stringify({
  baseUrl,
  tempRoot,
  sessionsDir,
  projectsDir,
  scenarioPath,
  resumeFile,
  resumeCwd,
  longHistoryFile,
  longHistoryCwd: longCwd,
})}\n`);
