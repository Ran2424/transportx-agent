#!/usr/bin/env node
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline/promises';
import WebSocket from 'ws';
import { defaultUserDataDir } from './app-paths.js';

type CliOptions = {
  command: 'chat' | 'modules' | 'help' | 'version';
  prompt: string;
  print: boolean;
  json: boolean;
  jsonl: boolean;
  verbose: boolean;
  noModules: boolean;
  modules: string[];
  model: string;
  name: string;
  cwd: string;
  appendSystemPromptFile: string;
};

type JsonObject = Record<string, any>;
const DEFAULT_MODULES: string[] = [];
const CLI_DOMAIN_ID = 'com.transportx.cli';
const VERSION = require(path.join(__dirname, '..', 'package.json')).version as string;

class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) { super(message); }
}

function optionValue(argv: string[], index: number, option: string) {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) throw new CliError(`${option} requires a value`, 2);
  return value;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = { command: 'chat', prompt: '', print: false, json: false, jsonl: false, verbose: false, noModules: false, modules: [], model: '', name: '', cwd: process.cwd(), appendSystemPromptFile: '' };
  const positional: string[] = [];
  let index = 0;
  if (argv[0] === 'modules') {
    if (argv[1] && argv[1] !== 'list') throw new CliError('Usage: transportx modules list', 2);
    options.command = 'modules';
    index = argv[1] === 'list' ? 2 : 1;
  } else if (argv[0] === 'chat') index = 1;
  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.command = 'help';
    else if (arg === '--version' || arg === '-v') options.command = 'version';
    else if (arg === '--print' || arg === '-p') options.print = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--jsonl') options.jsonl = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--no-modules') options.noModules = true;
    else if (arg === '--module' || arg === '-m') { options.modules.push(optionValue(argv, index, arg)); index += 1; }
    else if (arg === '--model') { options.model = optionValue(argv, index, arg); index += 1; }
    else if (arg === '--append-system-prompt-file') { options.appendSystemPromptFile = path.resolve(optionValue(argv, index, arg)); index += 1; }
    else if (arg === '--name' || arg === '-n') { options.name = optionValue(argv, index, arg); index += 1; }
    else if (arg === '--cwd') { options.cwd = path.resolve(optionValue(argv, index, arg)); index += 1; }
    else if (arg.startsWith('-')) throw new CliError(`Unknown option: ${arg}`, 2);
    else positional.push(arg);
  }
  if (options.json && options.jsonl) throw new CliError('--json and --jsonl cannot be used together', 2);
  if ((options.json || options.jsonl) && !options.print && options.command === 'chat') throw new CliError('--json and --jsonl require --print', 2);
  if (options.noModules && options.modules.length) throw new CliError('--no-modules cannot be combined with --module', 2);
  options.prompt = positional.join(' ').trim();
  return options;
}

function help() {
  return `TransportX Traffic Agent ${VERSION}

Usage:
  transportx [chat] [options] [prompt]
  transportx modules list [--json]

Options:
  -p, --print             Run one prompt and exit
  -m, --module <id[@ver]> Select a Module (repeatable)
      --no-modules        Load no optional Modules
      --model <provider/model>
      --append-system-prompt-file <path>
                           Append a UTF-8 system prompt file
  -n, --name <name>       Name the task workspace
      --cwd <directory>   Parent directory for the task workspace
      --json              Print one final JSON object
      --jsonl             Print streaming JSON events
      --verbose           Show tool arguments
  -h, --help
  -v, --version

Default Modules:
  ${DEFAULT_MODULES.join('\n  ') || '(none)'}`;
}

type HostHandle = { child: ChildProcess; baseUrl: string; authorization: string };

async function startHost(): Promise<HostHandle> {
  const appRoot = path.resolve(__dirname, '..');
  const userDataDir = path.resolve(process.env.TAU_USER_DATA_DIR || defaultUserDataDir(process.platform, process.env));
  const piAgentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || userDataDir);
  const user = 'transportx-cli';
  const pass = crypto.randomBytes(24).toString('base64url');
  const child = spawn(process.execPath, [path.join(__dirname, 'tau.js'), '--host', '127.0.0.1', '--port', '0', '--parent-pid', String(process.pid), '--ready-json'], {
    cwd: appRoot,
    env: { ...process.env, TAU_APP_ROOT: appRoot, TAU_RESOURCES_DIR: appRoot, TAU_USER_DATA_DIR: userDataDir, PI_CODING_AGENT_DIR: piAgentDir, TAU_USER: user, TAU_PASS: pass },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
  const ready = await new Promise<JsonObject>((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new CliError(`Agent Host startup timed out${stderr ? `: ${stderr.trim()}` : ''}`, 3)), 15_000);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        try {
          const value = JSON.parse(line);
          if (value.type === 'transportx-agent-host-ready') { clearTimeout(timer); resolve(value); }
        } catch {}
      }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(new CliError(`Cannot start Agent Host: ${error.message}`, 3)); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new CliError(`Agent Host exited during startup (${code})${stderr ? `: ${stderr.trim()}` : ''}`, 3)); });
  }).catch((error) => {
    if (child.exitCode === null) child.kill('SIGTERM');
    throw error;
  });
  return { child, baseUrl: `http://127.0.0.1:${ready.port}`, authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
}

function loadAppendSystemPrompt(filePath: string) {
  if (!filePath) return '';
  try {
    const prompt = fs.readFileSync(filePath, 'utf8').trim();
    if (!prompt) throw new CliError(`Appended system prompt file is empty: ${filePath}`, 2);
    return prompt;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Cannot read appended system prompt file: ${filePath}`, 2);
  }
}

async function jsonRequest(host: HostHandle, pathname: string, init: RequestInit = {}) {
  const response = await fetch(`${host.baseUrl}${pathname}`, {
    ...init,
    headers: { Authorization: host.authorization, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await response.text();
  let payload: JsonObject = {};
  try { payload = JSON.parse(text); } catch {}
  if (!response.ok) throw new CliError(payload.error || `HTTP ${response.status} ${pathname}`, response.status === 401 ? 3 : 1);
  return payload;
}

async function rpc(host: HostHandle, command: JsonObject) {
  const response = await jsonRequest(host, '/api/rpc', { method: 'POST', body: JSON.stringify(command) });
  if (response.success === false) throw new CliError(response.error || `Command failed: ${command.type}`);
  return response.data || {};
}

async function moduleCatalog(host: HostHandle) {
  const [overview, options] = await Promise.all([
    rpc(host, { type: 'get_platform_overview' }),
    jsonRequest(host, '/api/platform/session-options'),
  ]);
  const byKey = new Map<string, JsonObject>();
  for (const module of overview.modules || []) byKey.set(`${module.id}@${module.version}`, module);
  for (const module of options.modules || []) {
    const key = `${module.id}@${module.version}`;
    byKey.set(key, { ...(byKey.get(key) || {}), ...module });
  }
  return [...byKey.values()].map((module) => ({
    id: module.id,
    name: module.name,
    version: module.version,
    type: module.type,
    origin: module.origin,
    enabled: module.enabled,
    enabledForNewSessions: module.enabledForNewSessions,
    dependencies: module.dependencies || [],
    assets: module.assets || [],
  })).sort((left, right) => String(left.id).localeCompare(String(right.id)) || String(left.version).localeCompare(String(right.version)));
}

async function resolveModules(host: HostHandle, options: CliOptions) {
  const requested = options.noModules ? [] : options.modules.length ? options.modules : DEFAULT_MODULES;
  if (!requested.length) return [];
  const catalog = await moduleCatalog(host);
  const selectedModules = requested.map((spec) => {
    const separator = spec.lastIndexOf('@');
    const id = separator > 0 ? spec.slice(0, separator) : spec;
    const version = separator > 0 ? spec.slice(separator + 1) : '';
    const candidates = catalog.filter((module) => module.id === id && (!version || module.version === version));
    const selected = version ? candidates[0] : candidates.find((module) => module.enabled !== false && module.enabledForNewSessions !== false) || candidates.at(-1);
    if (!selected) throw new CliError(`Module is unavailable: ${spec}`, 2);
    if (selected.origin === 'installed' && selected.enabledForNewSessions === false) throw new CliError(`Module is not enabled for new sessions: ${spec}`, 2);
    if (selected.type === 'domain') throw new CliError(`A Domain cannot be selected as an optional Module: ${spec}`, 2);
    return { id: String(selected.id), version: String(selected.version) };
  });
  if (new Set(selectedModules.map((module) => module.id)).size !== selectedModules.length) throw new CliError('Each Module may be selected only once', 2);
  return selectedModules;
}

function messageText(message: JsonObject) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter((item: JsonObject) => item?.type === 'text').map((item: JsonObject) => item.text || '').join('\n');
}

async function finalAnswer(host: HostHandle, sessionId: string) {
  const snapshot = await jsonRequest(host, `/api/live-sessions/${encodeURIComponent(sessionId)}/snapshot`);
  return (snapshot.entries || []).filter((entry: JsonObject) => entry.type === 'message' && entry.message?.role === 'assistant').map((entry: JsonObject) => messageText(entry.message)).filter(Boolean).at(-1) || '';
}

async function runPrompt(host: HostHandle, socket: WebSocket, sessionId: string, prompt: string, options: CliOptions) {
  let streamed = '';
  let cancelWait = () => {};
  const completion = new Promise<void>((resolve, reject) => {
    const configuredTimeoutSeconds = Number(process.env.TRANSPORTX_AGENT_RESPONSE_TIMEOUT_SECONDS || 600);
    const responseTimeoutMs = Number.isFinite(configuredTimeoutSeconds) && configuredTimeoutSeconds > 0
      ? configuredTimeoutSeconds * 1000
      : 600_000;
    const timer = setTimeout(() => finish(new CliError('Agent response timed out')), responseTimeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off('message', receive);
      socket.off('close', closed);
      socket.off('error', failed);
      error ? reject(error) : resolve();
    };
    const closed = () => finish(new CliError('Agent Host connection closed before the response completed'));
    const failed = (error: Error) => finish(new CliError(`Agent Host connection failed: ${error.message}`));
    const receive = (raw: WebSocket.RawData) => {
      let envelope: JsonObject;
      try { envelope = JSON.parse(String(raw)); } catch { return; }
      if (envelope.sessionId !== sessionId) return;
      if (options.jsonl) process.stdout.write(`${JSON.stringify(envelope)}\n`);
      const event = envelope.type === 'event' ? envelope.event : envelope;
      if (event?.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        const delta = String(event.assistantMessageEvent.delta || '');
        streamed += delta;
        if (!options.json && !options.jsonl) process.stdout.write(delta);
      } else if (event?.type === 'tool_execution_start' && !options.json && !options.jsonl) {
        const detail = options.verbose ? ` ${JSON.stringify(event.args || {})}` : '';
        process.stderr.write(`[tool] ${event.toolName || 'unknown'}${detail}\n`);
      } else if (event?.type === 'extension_ui_request' || envelope.type === 'geo_interaction_updated' || envelope.type === 'geo_screenshot_updated') {
        void rpc(host, { type: 'abort', sessionId }).catch(() => {});
        finish(new CliError('This request requires interaction in the desktop workbench.'));
      } else if (event?.type === 'agent_end') finish();
    };
    cancelWait = () => finish();
    socket.on('message', receive);
    socket.once('close', closed);
    socket.once('error', failed);
  });
  let command: JsonObject;
  try {
    command = await jsonRequest(host, '/api/rpc', { method: 'POST', body: JSON.stringify({ type: 'prompt', sessionId, message: prompt, clientCommandId: crypto.randomUUID() }) });
    if (command.success === false) throw new CliError(command.error || 'Prompt was rejected');
  } catch (error) {
    cancelWait();
    await completion;
    throw error;
  }
  await completion;
  const answer = await finalAnswer(host, sessionId);
  if (!options.json && !options.jsonl) {
    if (!streamed && answer) process.stdout.write(answer);
    process.stdout.write('\n');
  } else if (options.json) process.stdout.write(`${JSON.stringify({ type: 'result', sessionId, answer })}\n`);
  else process.stdout.write(`${JSON.stringify({ type: 'result', sessionId, answer })}\n`);
  return answer;
}

async function openSocket(host: HostHandle) {
  const socket = new WebSocket(host.baseUrl.replace('http', 'ws') + '/ws', { headers: { Authorization: host.authorization } });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function printModules(catalog: JsonObject[], json: boolean) {
  if (json) { process.stdout.write(`${JSON.stringify({ modules: catalog })}\n`); return; }
  for (const module of catalog) {
    const state = module.enabled === false || module.enabledForNewSessions === false ? 'disabled' : 'available';
    process.stdout.write(`${module.id}@${module.version}\t${module.type}\t${module.origin || 'installed'}\t${state}\n`);
  }
}

async function chooseModel(host: HostHandle, requested: string) {
  if (requested) return requested;
  const data = await rpc(host, { type: 'get_available_models' });
  const model = (data.models || [])[0];
  if (!model?.provider || !model?.id) throw new CliError('No configured model is available. Use --model <provider/model>.', 3);
  return `${model.provider}/${model.id}`;
}

async function stopHost(host: HostHandle, sessionId = '') {
  if (sessionId) try { await jsonRequest(host, `/api/live-sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }); } catch {}
  if (host.child.exitCode === null) host.child.kill('SIGTERM');
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  if (options.command === 'help') { process.stdout.write(`${help()}\n`); return; }
  if (options.command === 'version') { process.stdout.write(`${VERSION}\n`); return; }
  if (options.print && !options.prompt) throw new CliError('--print requires a prompt', 2);
  const appendSystemPrompt = loadAppendSystemPrompt(options.appendSystemPromptFile);

  const host = await startHost();
  let sessionId = '';
  let socket: WebSocket | null = null;
  let input: Interface | null = null;
  let running = false;
  let interrupted = false;
  const interrupt = () => {
    if (running && sessionId) void rpc(host, { type: 'abort', sessionId }).catch(() => {});
    else {
      interrupted = true;
      process.exitCode = 130;
      input?.close();
    }
  };
  process.on('SIGINT', interrupt);
  try {
    if (options.command === 'modules') { printModules(await moduleCatalog(host), options.json); return; }
    const selected = await resolveModules(host, options);
    const model = await chooseModel(host, options.model);
    socket = await openSocket(host);
    const created = await jsonRequest(host, '/api/live-sessions', {
      method: 'POST',
      body: JSON.stringify({
        cwd: options.cwd,
        name: options.name || 'TransportX CLI',
        model,
        domainId: CLI_DOMAIN_ID,
        ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
        profile: { schemaVersion: 1, task: { kind: 'data-query', expectedOutputs: ['answer'] }, modules: { selectionMode: 'explicit', selected } },
      }),
    });
    sessionId = created.session.id;
    if (!options.json && !options.jsonl) {
      process.stderr.write(`TransportX ${VERSION}\nModel: ${model}\nModules: ${selected.map((item) => `${item.id}@${item.version}`).join(', ') || '(none)'}\nWorkspace: ${created.session.cwd}\n\n`);
    }
    if (options.prompt) { running = true; await runPrompt(host, socket, sessionId, options.prompt, options); running = false; }
    if (options.print) return;
    input = createInterface({ input: process.stdin, output: process.stdout });
    while (true) {
      let prompt: string;
      try { prompt = (await input.question('你> ')).trim(); }
      catch (error) { if (interrupted) break; throw error; }
      if (!prompt) continue;
      if (prompt === '/exit') break;
      if (prompt === '/abort') { await rpc(host, { type: 'abort', sessionId }); continue; }
      if (prompt === '/modules') { process.stdout.write(`${selected.map((item) => `${item.id}@${item.version}`).join('\n') || '(none)'}\n`); continue; }
      if (prompt === '/status') { process.stdout.write(`Model: ${model}\nWorkspace: ${created.session.cwd}\n`); continue; }
      running = true;
      try { await runPrompt(host, socket, sessionId, prompt, options); }
      catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); }
      finally { running = false; }
    }
  } finally {
    process.off('SIGINT', interrupt);
    input?.close();
    socket?.close();
    await stopHost(host, sessionId);
  }
}

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(`transportx: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  });
}
