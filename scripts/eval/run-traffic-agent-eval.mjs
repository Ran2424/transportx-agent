#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { gradeRun, loadSuite, summaryMarkdown } from './traffic-eval-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
function value(flag, fallback = '') { const index = process.argv.indexOf(flag); return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback; }
function present(flag) { return process.argv.includes(flag); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function timestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

const suitePath = path.resolve(ROOT, value('--suite', 'evals/traffic-agent/shanghai-v1.json'));
const suite = loadSuite(suitePath);
const model = value('--model', process.env.TAU_EVAL_MODEL || '');
const selectedCase = value('--case');
const kind = value('--kind');
const repeat = Math.max(1, Number(value('--repeat', '1')) || 1);
const timeoutMs = Math.max(10_000, Number(value('--timeout-ms', '300000')) || 300_000);
const keepWorkspace = present('--keep-workspace');
const requestedOutputRoot = value('--output-dir');
const sourceAgentDir = path.resolve(value('--pi-agent-dir', process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent')));
const dataRoot = value('--data-root', process.env.TAU_DATA_ROOT || '');
if (!model) throw new Error('--model provider/model is required for a real Headless Eval');
if (!dataRoot || !fs.existsSync(path.resolve(dataRoot))) throw new Error('--data-root must point to the Shanghai Data asset directory');

let cases = suite.cases;
if (selectedCase) cases = cases.filter((item) => item.id === selectedCase);
if (kind) cases = cases.filter((item) => item.kind === kind);
if (!cases.length) throw new Error('No eval cases matched the requested filters');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close((error) => error ? reject(error) : resolve(port)); });
  });
}

function copyAgentConfig(source, target) {
  fs.mkdirSync(target, { recursive: true });
  if (fs.existsSync(source)) for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isFile() && !['settings.json'].includes(entry.name)) fs.copyFileSync(path.join(source, entry.name), path.join(target, entry.name));
  }
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(path.join(source, 'settings.json'), 'utf8')); } catch {}
  settings.tau = { ...(settings.tau || {}), enabledModuleIds: ['com.transportx.shanghaidata'], authEnabled: false };
  fs.writeFileSync(path.join(target, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
}

function installEvalModule(userRoot) {
  const source = path.join(ROOT, 'modules/installable/shanghaidata');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
  const destination = path.join(userRoot, 'modules', manifest.id, manifest.version);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, filter: (candidate) => !candidate.includes(`${path.sep}__pycache__`) && !candidate.endsWith('.pyc') });
  return { id: manifest.id, version: manifest.version };
}

async function jsonRequest(baseUrl, pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }, ...(init.body && typeof init.body !== 'string' ? { body: JSON.stringify(init.body) } : {}) });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status} ${pathname}`);
  return payload;
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  return Array.isArray(message?.content) ? message.content.filter((item) => item?.type === 'text').map((item) => item.text || '').join('\n') : '';
}

function filesUnder(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(absolute); else files.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
  visit(root);
  return files;
}

function globRegex(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern.slice(index, index + 3) === '**/') { source += '(?:.*/)?'; index += 2; }
    else if (pattern.slice(index, index + 2) === '**') { source += '.*'; index += 1; }
    else if (pattern[index] === '*') source += '[^/]*';
    else source += pattern[index].replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function validateArtifact(cwd, artifact, fileList) {
  const matches = fileList.filter((item) => globRegex(artifact.pathPattern).test(item));
  if (!matches.length) return { kind: artifact.kind, pattern: artifact.pathPattern, valid: false, error: 'not found' };
  for (const relativePath of matches) {
    try {
      const absolute = path.join(cwd, relativePath);
      if (!fs.statSync(absolute).size) throw new Error('empty file');
      if (artifact.kind === 'geojson') { const data = JSON.parse(fs.readFileSync(absolute, 'utf8')); if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error('invalid GeoJSON'); }
      if (artifact.kind === 'spatial-result') { const data = JSON.parse(fs.readFileSync(absolute, 'utf8')); if (data.protocol !== 'transportx-spatial-analysis' || data.schemaVersion !== 1 || !data.output?.sha256) throw new Error('invalid SpatialAnalysisResult v1'); }
      return { kind: artifact.kind, pattern: artifact.pathPattern, path: relativePath, valid: true };
    } catch (error) { return { kind: artifact.kind, pattern: artifact.pathPattern, path: relativePath, valid: false, error: error.message }; }
  }
}

function hasDatasetCitation(cwd) {
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(cwd, '.tau', 'citations.json'), 'utf8'));
    const datasetResources = new Set((registry.resources || []).filter((item) => item.scope === 'dataset').map((item) => item.resourceId));
    const locators = new Set((registry.locators || []).filter((item) => datasetResources.has(item.resourceId)).map((item) => item.locatorId));
    return (registry.occurrences || []).some((item) => locators.has(item.locatorId));
  } catch { return false; }
}

const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-traffic-eval-'));
const userRoot = path.join(runRoot, 'user-data');
const piAgentDir = path.join(runRoot, 'pi-agent');
const sessionsDir = path.join(runRoot, 'sessions');
const projectsDir = path.join(runRoot, 'workspaces');
for (const directory of [userRoot, sessionsDir, projectsDir]) fs.mkdirSync(directory, { recursive: true });
copyAgentConfig(sourceAgentDir, piAgentDir);
const evalModule = installEvalModule(userRoot);
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const host = spawn(process.execPath, [path.join(ROOT, 'bin/tau.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    TAU_USER_DATA_DIR: userRoot,
    PI_CODING_AGENT_DIR: piAgentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionsDir,
    TAU_PROJECTS_DIR: projectsDir,
    TAU_HOST: '127.0.0.1',
    TAU_PORT: String(port),
    TAU_DATA_ROOT: path.resolve(dataRoot),
    TAU_DATA_ASSET_ID: 'data:shanghai-traffic',
    TAU_PYTHON_COMMAND: '/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let hostStdout = '', hostStderr = '';
host.stdout.setEncoding('utf8'); host.stderr.setEncoding('utf8');
host.stdout.on('data', (chunk) => { hostStdout = `${hostStdout}${chunk}`.slice(-200_000); process.stdout.write(chunk); });
host.stderr.on('data', (chunk) => { hostStderr = `${hostStderr}${chunk}`.slice(-200_000); process.stderr.write(chunk); });

let socket;
let currentSessionId = '';
let interrupted = false;
async function closeCurrent() { if (currentSessionId) try { await jsonRequest(baseUrl, `/api/live-sessions/${encodeURIComponent(currentSessionId)}`, { method: 'DELETE' }); } catch {} currentSessionId = ''; }
async function shutdown() { await closeCurrent(); try { socket?.close(); } catch {} if (host.exitCode === null) host.kill('SIGTERM'); }
process.on('SIGINT', () => { interrupted = true; void shutdown(); });
process.on('SIGTERM', () => { interrupted = true; void shutdown(); });

try {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { try { if ((await fetch(`${baseUrl}/api/health`)).ok) break; } catch {} await sleep(100); }
  if (!(await fetch(`${baseUrl}/api/health`).catch(() => null))?.ok) throw new Error(`Agent Host did not start. ${hostStderr}`);
  const events = [];
  socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws`);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.on('message', (data) => { try { events.push(JSON.parse(String(data))); } catch {} });

  const run = { schemaVersion: 1, runId: `traffic-eval-${timestamp()}`, suiteId: suite.id, model, startedAt: new Date().toISOString(), module: evalModule, cases: [], host: { mode: 'headless', desktop: false } };
  for (let attempt = 1; attempt <= repeat; attempt += 1) for (const evalCase of cases) {
    if (interrupted) throw new Error('Eval interrupted');
    const started = Date.now();
    const caseRun = { caseId: evalCase.id, attempt, completed: false, answers: [], toolError: '', pendingExtensionUi: false, plan: null, artifacts: [], hasDatasetCitation: false, durationMs: 0, error: '' };
    process.stdout.write(`\n[Eval] ${evalCase.id} attempt ${attempt}/${repeat}\n`);
    try {
      const created = await jsonRequest(baseUrl, '/api/live-sessions', { method: 'POST', body: { cwd: projectsDir, name: `${evalCase.id}-${attempt}`, model, profile: { schemaVersion: 1, task: { kind: evalCase.kind === 'question' ? 'data-query' : evalCase.category === 'spatial' ? 'spatial-analysis' : 'assurance-analysis', expectedOutputs: evalCase.expectedArtifacts?.some((item) => item.kind === 'report') ? ['report'] : evalCase.expectedArtifacts?.some((item) => item.kind === 'geojson') ? ['map'] : ['answer'] }, modules: { selectionMode: 'explicit', selected: evalCase.requiredModuleVersions } } } });
      currentSessionId = created.session.id;
      caseRun.plan = created.session.resolvedSessionPlan;
      let assistantCount = 0;
      for (const turn of evalCase.turns) {
        const eventStart = events.length;
        const command = await jsonRequest(baseUrl, '/api/rpc', { method: 'POST', body: { type: 'prompt', sessionId: currentSessionId, message: turn.user, clientCommandId: randomUUID() } });
        if (command.success === false) throw new Error(command.error || 'Prompt was rejected');
        const turnDeadline = Date.now() + timeoutMs;
        while (Date.now() < turnDeadline && !events.slice(eventStart).some((item) => item.sessionId === currentSessionId && item.event?.type === 'agent_end')) await sleep(100);
        if (!events.slice(eventStart).some((item) => item.sessionId === currentSessionId && item.event?.type === 'agent_end')) throw new Error(`Turn timed out after ${timeoutMs}ms`);
        const snapshot = await jsonRequest(baseUrl, `/api/live-sessions/${encodeURIComponent(currentSessionId)}/snapshot`);
        const assistants = snapshot.entries.filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant').map((entry) => messageText(entry.message)).filter(Boolean);
        if (assistants.length <= assistantCount) throw new Error('Turn completed without a final assistant answer');
        caseRun.answers.push(assistants.at(-1)); assistantCount = assistants.length;
        const failedTool = snapshot.entries.find((entry) => entry.type === 'message' && entry.message?.role === 'toolResult' && entry.message?.isError === true);
        if (failedTool) caseRun.toolError = messageText(failedTool.message) || 'Tool returned isError=true';
        caseRun.pendingExtensionUi = !!snapshot.session?.pendingExtensionUiRequests?.length;
        caseRun.usage = snapshot.contextUsage || null;
      }
      const metadata = (await jsonRequest(baseUrl, '/api/live-sessions')).sessions.find((item) => item.id === currentSessionId);
      caseRun.plan = metadata?.resolvedSessionPlan || caseRun.plan;
      const cwd = metadata.cwd;
      const fileList = filesUnder(cwd);
      caseRun.artifacts = (evalCase.expectedArtifacts || []).map((artifact) => validateArtifact(cwd, artifact, fileList));
      caseRun.hasDatasetCitation = hasDatasetCitation(cwd);
      caseRun.files = fileList;
      caseRun.completed = !caseRun.toolError && !caseRun.pendingExtensionUi;
    } catch (error) {
      caseRun.error = error.message || String(error);
    } finally {
      caseRun.durationMs = Date.now() - started;
      await closeCurrent();
      run.cases.push(caseRun);
    }
    fs.mkdirSync(path.join(runRoot, 'partial'), { recursive: true });
    fs.writeFileSync(path.join(runRoot, 'partial', `${evalCase.id}-${attempt}.json`), `${JSON.stringify(caseRun, null, 2)}\n`);
  }
  run.completedAt = new Date().toISOString();
  run.host.stdoutTail = hostStdout; run.host.stderrTail = hostStderr;
  const outputRoot = requestedOutputRoot ? path.resolve(requestedOutputRoot) : path.resolve(ROOT, 'eval-results', timestamp());
  fs.mkdirSync(path.join(outputRoot, 'cases'), { recursive: true });
  fs.writeFileSync(path.join(outputRoot, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  for (const caseRun of run.cases) fs.writeFileSync(path.join(outputRoot, 'cases', `${caseRun.caseId}-${caseRun.attempt}.json`), `${JSON.stringify(caseRun, null, 2)}\n`);
  const summary = gradeRun(suite, run);
  fs.writeFileSync(path.join(outputRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(outputRoot, 'summary.md'), summaryMarkdown(summary));
  process.stdout.write(`\n[Eval] ${summary.totals.passed}/${summary.totals.cases} passed. Results: ${outputRoot}\n`);
  if (!summary.passed) process.exitCode = 1;
  if (keepWorkspace) process.stdout.write(`[Eval] Preserved workspace: ${runRoot}\n`);
} finally {
  await shutdown();
  if (!keepWorkspace) fs.rmSync(runRoot, { recursive: true, force: true });
}
