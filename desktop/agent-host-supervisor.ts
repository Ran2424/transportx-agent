const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { utilityProcess } = require('electron') as typeof import('electron');

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { UtilityProcess } from 'electron';
import type { DesktopPaths } from './app-paths.js';

export const AGENT_HOST_READY_TYPE = 'transportx-agent-host-ready';
export const AGENT_HOST_PROTOCOL_VERSION = 1;

export type AgentHostReady = {
  type: typeof AGENT_HOST_READY_TYPE;
  host: '127.0.0.1';
  port: number;
  protocolVersion: number;
  pid: number;
};

type SupervisorOptions = {
  paths: DesktopPaths;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  onUnexpectedExit?: (message: string) => void;
  renderPdf?: (title: string, html: string) => Promise<Buffer>;
};

export function parseReadyLine(line: string): AgentHostReady | null {
  let value: Partial<AgentHostReady>;
  try { value = JSON.parse(line) as Partial<AgentHostReady>; } catch { return null; }
  if (value.type !== AGENT_HOST_READY_TYPE || value.host !== '127.0.0.1') return null;
  if (!Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) return null;
  if (value.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION || !Number.isInteger(value.pid)) return null;
  return value as AgentHostReady;
}

export function validatePackagedRuntime(resourcesDir: string) {
  const manifestPath = path.join(resourcesDir, 'runtime-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.manifestVersion !== 1 || manifest.product?.name !== 'TransportX Traffic Agent') throw new Error('Invalid TransportX runtime manifest');
  if (manifest.agentHost?.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION) throw new Error('Agent Host protocol mismatch');
  for (const [label, entry] of [['Agent Host', manifest.agentHost], ['Pi CLI', manifest.pi], ['Python', manifest.python]]) {
    if (!entry || typeof entry.path !== 'string' || path.isAbsolute(entry.path) || !/^[a-f0-9]{64}$/i.test(entry.sha256 || '')) throw new Error(`Invalid ${label} runtime entry`);
    const target = path.resolve(resourcesDir, entry.path);
    const relative = path.relative(path.resolve(resourcesDir), target);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(target)) throw new Error(`${label} runtime is missing`);
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    if (checksum !== entry.sha256.toLowerCase()) throw new Error(`${label} runtime checksum mismatch`);
  }
  return manifest;
}

function checkHealth(url: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = http.get(`${url}/api/health`, { timeout: timeoutMs }, (response: any) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => {
        try {
          const health = JSON.parse(body);
          if (response.statusCode !== 200 || health.status !== 'ok' || health.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION) throw new Error('invalid health response');
          resolve();
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Agent Host health check timed out')));
    request.on('error', reject);
  });
}

function appendBounded(filePath: string, text: string, maxBytes = 5 * 1024 * 1024) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    if (fs.statSync(filePath).size > maxBytes) {
      const current = fs.readFileSync(filePath);
      fs.writeFileSync(filePath, current.subarray(Math.max(0, current.length - Math.floor(maxBytes / 2))));
    }
  } catch {}
  fs.appendFileSync(filePath, text);
}

type AgentHostProcess = ChildProcessWithoutNullStreams | UtilityProcess;

function isUtilityProcess(child: AgentHostProcess): child is UtilityProcess {
  return 'postMessage' in child;
}

function sendMessage(child: AgentHostProcess, message: unknown) {
  if (isUtilityProcess(child)) child.postMessage(message);
  else child.send(message as any);
}

function onceExit(child: AgentHostProcess, listener: (code: number | null, signal?: NodeJS.Signals | null) => void) {
  if (isUtilityProcess(child)) child.once('exit', (code) => listener(code));
  else child.once('exit', listener);
}

function terminateProcessTree(child: AgentHostProcess) {
  if (!child.pid) return;
  if (isUtilityProcess(child)) {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
    return;
  }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

export class AgentHostSupervisor {
  private options: SupervisorOptions;
  private child: AgentHostProcess | null = null;
  private stopping = false;

  constructor(options: SupervisorOptions) {
    this.options = options;
  }

  async start(): Promise<string> {
    if (this.child) throw new Error('Agent Host is already running');
    const { paths } = this.options;
    if (!fs.existsSync(paths.agentHostEntrypoint)) throw new Error(`Agent Host entrypoint is missing: ${paths.agentHostEntrypoint}`);
    const logFile = path.join(paths.logsDir, 'agent-host.log');
    const runtimeManifest = path.join(paths.resourcesDir, 'runtime-manifest.json');
    if (fs.existsSync(runtimeManifest)) validatePackagedRuntime(paths.resourcesDir);
    const developmentRuntime = fs.existsSync(runtimeManifest) ? {} : {
      TAU_PI_ENTRYPOINT: path.join(paths.appRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'),
      TAU_PYTHON_COMMAND: process.env.TAU_PYTHON_COMMAND || 'python3',
      TAU_FFMPEG_COMMAND: process.env.TAU_FFMPEG_COMMAND || 'ffmpeg',
      TAU_FFPROBE_COMMAND: process.env.TAU_FFPROBE_COMMAND || 'ffprobe',
    };
    const args = ['--desktop', '--parent-pid', String(process.pid)];
    const env = {
      ...process.env,
      TAU_DESKTOP: '1',
      TAU_APP_ROOT: paths.appRoot,
      TAU_RESOURCES_DIR: paths.resourcesDir,
      TAU_USER_DATA_DIR: paths.userDataDir,
      PYTHONDONTWRITEBYTECODE: '1',
      ...developmentRuntime,
    };
    const child: AgentHostProcess = process.platform === 'darwin'
      ? utilityProcess.fork(paths.agentHostEntrypoint, args, {
          env,
          serviceName: 'TransportX Agent Host',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(process.execPath, [paths.agentHostEntrypoint, ...args], {
          env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
    this.child = child;
    child.on('message', (message: unknown) => {
      const request = message as { type?: string; id?: string; title?: string; html?: string };
      if (request?.type !== 'transportx-pdf-request' || !request.id || typeof request.title !== 'string' || typeof request.html !== 'string') return;
      if (!this.options.renderPdf || Buffer.byteLength(request.html, 'utf8') > 50 * 1024 * 1024) {
        sendMessage(child, { type: 'transportx-pdf-response', id: request.id, ok: false, error: 'Desktop PDF request is unavailable or too large' });
        return;
      }
      this.options.renderPdf(request.title, request.html).then(
        (pdf) => sendMessage(child, { type: 'transportx-pdf-response', id: request.id, ok: true, data: pdf.toString('base64') }),
        (error) => sendMessage(child, { type: 'transportx-pdf-response', id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    });

    return new Promise((resolve, reject) => {
      let stdout = '';
      let settled = false;
      const timeout = setTimeout(() => finish(new Error('Agent Host startup timed out')), this.options.startupTimeoutMs ?? 15_000);
      const finish = (error?: Error, url?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) { this.stop().finally(() => reject(error)); } else resolve(url!);
      };
      const childStdout = child.stdout as Readable | null;
      const childStderr = child.stderr as Readable | null;
      if (!childStdout || !childStderr) return finish(new Error('Agent Host output pipes are unavailable'));
      childStdout.setEncoding('utf8');
      childStderr.setEncoding('utf8');
      childStdout.on('data', (chunk: string) => {
        appendBounded(logFile, chunk);
        stdout += chunk;
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() || '';
        for (const line of lines) {
          const ready = parseReadyLine(line.trim());
          if (!ready) continue;
          const url = `http://127.0.0.1:${ready.port}`;
          checkHealth(url).then(() => finish(undefined, url), (error) => finish(new Error(`Agent Host health check failed: ${error instanceof Error ? error.message : String(error)}`)));
        }
      });
      childStderr.on('data', (chunk: string) => appendBounded(logFile, chunk));
      if (isUtilityProcess(child)) child.once('error', (type, location) => finish(new Error(`Agent Host ${type} at ${location}`)));
      else child.once('error', (error: Error) => finish(error));
      onceExit(child, (code, signal) => {
        this.child = null;
        const message = `Agent Host exited (${signal || code})`;
        if (!settled) finish(new Error(message));
        else if (!this.stopping) this.options.onUnexpectedExit?.(message);
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    try {
      if (isUtilityProcess(child)) child.kill();
      else child.kill('SIGTERM');
    } catch {}
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { terminateProcessTree(child); resolve(); }, this.options.shutdownTimeoutMs ?? 5000);
      onceExit(child, () => { clearTimeout(timeout); resolve(); });
    });
    this.child = null;
  }
}
