#!/usr/bin/env node
// fake-pi — 模拟 `pi --mode rpc` 子进程，用于无真实 pi / API key 的基线测试。
//
// 协议（与 src/server/sessions.ts 的实际消费一一对应）：
//   stdin  <- JSONL 命令：{type, id, ...}（prompt/abort/get_state/get_session_stats/
//             get_commands/set_model/set_thinking_level/compact/extension_ui_response）
//   stdout -> JSONL：响应 {type:'response', id, success, data|error}；
//             事件 agent_start/message_start/message_update(assistantMessageEvent)/
//             tool_execution_*/message_end/entry_appended/extension_ui_request/turn_end/agent_end
//   stderr -> [fake-pi] 诊断
//
// 行为由场景文件驱动（env FAKE_PI_SCENARIO，JSON）：
//   { "rules": [{ "match": "<prompt 子串>", "steps": [...] }], "fallback": { "steps": [...] } }
// 步骤类型：
//   { "delay": ms }
//   { "event": {...} }                                  原样发出一条 pi 事件
//   { "entryAppended": {entry} }                        发 entry_appended 并写入会话文件
//   { "streamText": { text, repeat?, chunks, delayMs, thinking? } }
//   { "tool": { name, args?, result, partialResults?, isError? } }
//   { "ui": { method: select|confirm|input, id, title, options?|message? } }
//   { "writeFile": { path, json?|content?|base64? } }   相对会话 cwd 写文件（geo 资源等）
// 任意字符串值可用 "$fixture": "<相对 test/fixtures 的路径>#<顶层键>" 深替换。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--version')) {
  process.stdout.write('0.80.10\n');
  process.exit(0);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES_DIR = process.env.FAKE_PI_FIXTURES_DIR || path.join(REPO_ROOT, 'test', 'fixtures');
const SCENARIO_PATH = process.env.FAKE_PI_SCENARIO || path.join(REPO_ROOT, 'scripts', 'harness', 'scenarios', 'baseline.json');

function diag(...args) { process.stderr.write(`[fake-pi] ${args.join(' ')}\n`); }

const scenario = JSON.parse(fs.readFileSync(SCENARIO_PATH, 'utf8'));

// ---- argv: 只关心 --session（其余 pi 参数原样接受、忽略） ----
const argv = process.argv.slice(2);
if (process.env.FAKE_PI_LAUNCH_FILE) fs.writeFileSync(process.env.FAKE_PI_LAUNCH_FILE, JSON.stringify({ argv, piAgentDir: process.env.PI_CODING_AGENT_DIR }));
function argValue(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
}
const sessionFile = argValue('--session') || path.join(process.cwd(), 'fake-session.jsonl');
const modelSpec = argValue('--model') || 'kimi-coding/k2p7:high';
const [modelProvider, modelRest] = modelSpec.split('/', 2);
const modelId = (modelRest || modelProvider || 'k2p7').split(':')[0];
const model = { provider: modelRest ? modelProvider : 'kimi-coding', id: modelId, contextWindow: 262144 };

// ---- 会话文件（pi 自己的 JSONL；server 的 SessionProjection 会 reconcile） ----
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
let lastEntryId = null;
let entryCounter = 0;
if (fs.existsSync(sessionFile)) {
  for (const line of fs.readFileSync(sessionFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const entry = JSON.parse(line); if (entry.id) lastEntryId = entry.id; } catch {}
  }
} else {
  const header = { type: 'session', version: 3, id: `fake-${Date.now().toString(36)}`, timestamp: new Date().toISOString(), cwd: process.cwd() };
  fs.appendFileSync(sessionFile, JSON.stringify(header) + '\n');
}

function appendSessionEntry(entry) {
  // 追加到会话文件的条目总是接续当前链尾：忽略 fixture 自带的 id/parentId，
  // 否则 selectCurrentSessionBranch 回溯时会把链尾之前的条目误判为放弃分支。
  const id = `fx${(++entryCounter).toString(16).padStart(6, '0')}`;
  const row = { ...entry, id, parentId: lastEntryId, timestamp: entry.timestamp || new Date().toISOString() };
  lastEntryId = id;
  fs.appendFileSync(sessionFile, JSON.stringify(row) + '\n');
  return row;
}

// ---- stdout 协议 ----
function emit(object) { process.stdout.write(JSON.stringify(object) + '\n'); }
function respond(id, success, data, error) {
  const response = { type: 'response', id, success };
  if (data !== undefined) response.data = data;
  if (error !== undefined) response.error = error;
  emit(response);
}

// ---- $fixture 深替换 ----
function resolveFixtures(value) {
  if (Array.isArray(value)) return value.map(resolveFixtures);
  if (value && typeof value === 'object') {
    if (typeof value.$fixture === 'string') {
      const [file, key] = value.$fixture.split('#');
      const data = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'));
      return key ? data[key] : data;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveFixtures(v);
    return out;
  }
  return value;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function chunkText(text, chunks) {
  const count = Math.max(1, Math.min(chunks || 1, text.length));
  const size = Math.ceil(text.length / count);
  const parts = [];
  for (let index = 0; index < text.length; index += size) parts.push(text.slice(index, index + size));
  return parts;
}

function registerFakeCitations(envelope) {
  const sessionId = process.env.TAU_CITATION_SESSION_ID;
  if (!sessionId || !envelope) return;
  const registryPath = path.join(process.cwd(), '.tau', 'citations.json');
  const timestamp = new Date().toISOString();
  const registry = fs.existsSync(registryPath)
    ? JSON.parse(fs.readFileSync(registryPath, 'utf8'))
    : { schemaVersion: 1, sessionId, protocol: envelope.protocol, version: envelope.version, citationSetId: envelope.citationSetId, generatedAt: envelope.generatedAt || timestamp, updatedAt: timestamp, works: [], resources: [], locators: [], occurrences: [], provenance: [] };
  for (const [collection, id] of [['works', 'workId'], ['resources', 'resourceId'], ['locators', 'locatorId'], ['occurrences', 'occurrenceId'], ['provenance', 'provenanceId']]) {
    const known = new Set(registry[collection].map((item) => item[id]));
    for (const item of envelope[collection] || []) if (!known.has(item[id])) registry[collection].push(item);
  }
  registry.updatedAt = timestamp;
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

// ---- 回放引擎 ----
let aborted = false;
let replaying = null;
let taskStateRevision = 0;
const pendingUi = new Map();

async function runSteps(steps, promptMessage) {
  aborted = false;
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
  const userMessage = { role: 'user', content: [{ type: 'text', text: promptMessage }], timestamp: Date.now() };
  emit({ type: 'message_start', message: userMessage });
  appendSessionEntry({ type: 'message', message: userMessage });

  let streamOpen = false;
  let streamedText = '';
  let streamedThinking = '';

  const finalizeAborted = () => {
    if (streamOpen) {
      const message = {
        role: 'assistant',
        content: [
          ...(streamedThinking ? [{ type: 'thinking', thinking: streamedThinking, thinkingSignature: 'FAKE_PI_SIGNATURE' }] : []),
          { type: 'text', text: streamedText },
        ],
        provider: model.provider, model: model.id,
        usage: { input: 500, output: Math.ceil(streamedText.length / 2), cacheRead: 0, cacheWrite: 0, totalTokens: 500, cost: { total: 0 } },
        stopReason: 'aborted',
        timestamp: Date.now(),
      };
      emit({ type: 'message_end', message });
      appendSessionEntry({ type: 'message', message });
      streamOpen = false;
    }
    emit({ type: 'turn_end' });
    emit({ type: 'agent_end' });
    emit({ type: 'agent_settled' });
  };

  for (const rawStep of steps) {
    if (aborted) { finalizeAborted(); return; }
    const step = resolveFixtures(rawStep);

    if (step.delay) { await sleep(step.delay); continue; }

    if (step.event) { emit(step.event); continue; }

    if (step.entryAppended) {
      const entry = appendSessionEntry(step.entryAppended);
      emit({ type: 'entry_appended', entry });
      continue;
    }

    if (step.writeFile) {
      const target = path.resolve(process.cwd(), step.writeFile.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const body = step.writeFile.base64 !== undefined
        ? Buffer.from(String(step.writeFile.base64), 'base64')
        : step.writeFile.json !== undefined ? JSON.stringify(step.writeFile.json, null, 2) : String(step.writeFile.content ?? '');
      fs.writeFileSync(target, body);
      diag(`wrote ${target}`);
      continue;
    }

    if (step.geoResource) {
      const raw = Buffer.from(JSON.stringify(step.geoResource.data));
      const directory = path.join(process.cwd(), '.tau', 'geo-resources', step.geoResource.resourceId);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'data.geojson'), raw);
      fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
        resourceId: step.geoResource.resourceId,
        title: step.geoResource.title || step.geoResource.resourceId,
        bytes: raw.byteLength,
        sha256: crypto.createHash('sha256').update(raw).digest('hex'),
        featureCount: step.geoResource.data.features.length,
        ...(step.geoResource.idField ? { idField: step.geoResource.idField } : {}),
      }, null, 2));
      continue;
    }

    if (step.streamText) {
      const { thinking } = step.streamText;
      const text = String(step.streamText.text ?? '').repeat(Math.max(1, step.streamText.repeat ?? 1));
      const chunks = step.streamText.chunks ?? 8;
      const delayMs = step.streamText.delayMs ?? 10;
      streamOpen = true;
      streamedText = '';
      streamedThinking = '';
      emit({ type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: '' }], model: model.id } });
      if (thinking) {
        for (const delta of chunkText(thinking, Math.max(2, Math.floor(chunks / 4)))) {
          if (aborted) break;
          streamedThinking += delta;
          emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta } });
          if (delayMs) await sleep(delayMs);
        }
      }
      for (const delta of chunkText(text, chunks)) {
        if (aborted) break;
        streamedText += delta;
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
        if (delayMs) await sleep(delayMs);
      }
      if (aborted) { finalizeAborted(); return; }
      const content = [
        ...(streamedThinking ? [{ type: 'thinking', thinking: streamedThinking, thinkingSignature: 'FAKE_PI_SIGNATURE' }] : []),
        { type: 'text', text: streamedText },
      ];
      const message = {
        role: 'assistant',
        content,
        provider: model.provider, model: model.id,
        usage: { input: 800, output: Math.ceil(streamedText.length / 2), cacheRead: 0, cacheWrite: 0, totalTokens: 800 + content.length, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 } },
        stopReason: 'stop',
        timestamp: Date.now(),
      };
      emit({ type: 'message_end', message });
      appendSessionEntry({ type: 'message', message });
      streamOpen = false;
      continue;
    }

    if (step.tool) {
      const toolCallId = step.tool.toolCallId || `call_fake_${(++entryCounter).toString(16)}`;
      if (step.tool.result?.details?.kind === 'tau-citations') registerFakeCitations(step.tool.result.details.citations);
      emit({ type: 'tool_execution_start', toolCallId, toolName: step.tool.name, args: step.tool.args || {} });
      for (const partial of step.tool.partialResults || []) {
        if (aborted) { finalizeAborted(); return; }
        emit({ type: 'tool_execution_update', toolCallId, partialResult: partial });
        if (step.tool.delayMs) await sleep(step.tool.delayMs);
      }
      if (step.tool.delayMs) await sleep(step.tool.delayMs);
      const isError = !!step.tool.isError;
      emit({ type: 'tool_execution_end', toolCallId, toolName: step.tool.name, result: step.tool.result, isError });
      // 与真实 pi 一致：toolResult 也会作为 message_end 进入会话投影
      const message = {
        role: 'toolResult',
        toolCallId,
        toolName: step.tool.name,
        content: step.tool.result?.content || [{ type: 'text', text: '' }],
        ...(step.tool.result?.details ? { details: step.tool.result.details } : {}),
        isError,
        timestamp: Date.now(),
      };
      emit({ type: 'message_end', message });
      appendSessionEntry({ type: 'message', message });
      continue;
    }

    if (step.geoHost) {
      const toolCallId = step.geoHost.toolCallId || `call_fake_${(++entryCounter).toString(16)}`;
      const toolName = step.geoHost.path === 'inspect'
        ? 'inspect_map_context'
        : step.geoHost.path === 'screenshot' ? 'capture_geo_screenshot' : 'request_geo_input';
      const args = step.geoHost.args || {};
      emit({ type: 'tool_execution_start', toolCallId, toolName, args });
      const response = await fetch(`${process.env.TAU_GEO_ENDPOINT}/api/internal/geo/${step.geoHost.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...args, sessionId: process.env.TAU_GEO_SESSION_ID, token: process.env.TAU_GEO_TOKEN }),
      });
      const payload = await response.json();
      const detailKind = step.geoHost.path === 'inspect'
        ? 'tau-geo-context'
        : step.geoHost.path === 'screenshot' ? 'tau-geo-screenshot' : 'tau-geo-interaction';
      const result = response.ok
        ? { content: [{ type: 'text', text: JSON.stringify(payload.result) }], details: { kind: detailKind, result: payload.result } }
        : { content: [{ type: 'text', text: payload.error || 'Geo Host request failed' }] };
      emit({ type: 'tool_execution_end', toolCallId, toolName, result, isError: !response.ok });
      const message = { role: 'toolResult', toolCallId, toolName, content: result.content, ...(result.details ? { details: result.details } : {}), isError: !response.ok, timestamp: Date.now() };
      emit({ type: 'message_end', message });
      appendSessionEntry({ type: 'message', message });
      continue;
    }

    if (step.ui) {
      const requestId = step.ui.id || `ui_${(++entryCounter).toString(16)}`;
      const request = { type: 'extension_ui_request', id: requestId, method: step.ui.method };
      if (step.ui.title) request.title = step.ui.title;
      if (step.ui.message) request.message = step.ui.message;
      if (step.ui.options) request.options = step.ui.options;
      if (step.ui.placeholder) request.placeholder = step.ui.placeholder;
      if (step.ui.prefill) request.prefill = step.ui.prefill;
      if (step.ui.notifyType) request.notifyType = step.ui.notifyType;
      if (step.ui.timeout) request.timeout = step.ui.timeout;
      emit(request);
      const response = await new Promise((resolve) => pendingUi.set(requestId, resolve));
      pendingUi.delete(requestId);
      diag(`ui ${requestId} responded: ${JSON.stringify(response)}`);
      if (aborted) { finalizeAborted(); return; }
      continue;
    }

    diag(`unknown step ignored: ${JSON.stringify(rawStep)}`);
  }

  if (aborted) { finalizeAborted(); return; }
  emit({ type: 'turn_end' });
  emit({ type: 'agent_end' });
  emit({ type: 'agent_settled' });
}

// ---- 命令处理 ----
async function handleCommand(command) {
  const id = command.id;
  switch (command.type) {
    case 'get_state':
      respond(id, true, {
        sessionFile,
        sessionName: null,
        model,
        thinkingLevel: 'high',
        isStreaming: !!replaying,
        autoCompactionEnabled: true,
        contextUsage: { tokens: { input: 800, output: 120 } },
      });
      return;
    case 'get_session_stats':
      respond(id, true, { tokens: { input: 800, output: 120, cost: { total: 0.0002 } }, contextUsage: { tokens: { input: 800, output: 120 } } });
      return;
    case 'get_commands':
      respond(id, true, {
        commands: [
          { name: 'task', description: '切换任务模式', source: 'extension' },
          { name: 'shanghai-traffic-data-assets', description: '查询受治理的上海体育馆交通数据', source: 'skill', path: path.join(REPO_ROOT, 'modules', 'official', 'traffic-data', 'skill', 'SKILL.md'), location: 'project' },
        ],
      });
      return;
    case 'get_messages':
      respond(id, true, { entries: [] });
      return;
    case 'set_model': {
      const spec = String(command.model || modelSpec);
      const [provider, rest] = spec.split('/', 2);
      model.provider = rest ? provider : model.provider;
      model.id = (rest || provider).split(':')[0];
      respond(id, true, { model });
      return;
    }
    case 'set_thinking_level':
    case 'cycle_thinking_level':
    case 'cycle_model':
    case 'set_auto_compaction':
      respond(id, true, {});
      return;
    case 'compact':
      respond(id, true, { summary: 'fake compaction' });
      return;
    case 'extension_ui_response': {
      const pending = pendingUi.get(command.id);
      respond(id, true, {});
      if (pending) pending(command);
      return;
    }
    case 'abort': {
      aborted = true;
      respond(id, true, {});
      return;
    }
    case 'prompt':
    case 'steer':
    case 'follow_up': {
      respond(id, true, {});
      const message = String(command.message || '');
      const taskModeMatch = message.trim().match(/^\/task (on|off) --silent$/);
      if (taskModeMatch) {
        const entry = appendSessionEntry({
          type: 'custom',
          customType: 'pi-task-mode',
          data: {
            schemaVersion: 1,
            revision: ++taskStateRevision,
            enabled: taskModeMatch[1] === 'on',
          },
        });
        emit({ type: 'entry_appended', entry });
        return;
      }
      const rule = (scenario.rules || []).find((candidate) => message.includes(candidate.match));
      const steps = (rule || scenario.fallback || { steps: [{ streamText: { text: '（fake-pi 默认回复）', chunks: 4 } }] }).steps;
      replaying = runSteps(steps, message).finally(() => { replaying = null; });
      await replaying;
      return;
    }
    default:
      respond(id, false, undefined, `Unknown command: ${command.type}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let command;
  try { command = JSON.parse(line); } catch { diag(`unparseable command: ${line}`); return; }
  handleCommand(command).catch((error) => diag(`command ${command.type} failed: ${error.stack || error}`));
});

diag(`ready sessionFile=${sessionFile} scenario=${path.basename(SCENARIO_PATH)}`);
