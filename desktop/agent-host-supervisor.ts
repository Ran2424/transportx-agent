const { hostPlatform } = require('../bin/host-platform.js');
const { createDiagnosticLogger } = require('../bin/diagnostic-log.js');
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
export const { AGENT_HOST_PROTOCOL_VERSION } = require('../bin/contracts/host-protocol.js');
const { compatibleHostHealth } = require('../bin/contracts/host-protocol.js');

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
  updatePreparationTimeoutMs?: number;
  onUnexpectedExit?: (message: string) => void;
  renderPdf?: (title: string, html: string) => Promise<Buffer>;
  confirmModuleTrust?: (request: { id: string; version: string; name: string; packageRoot: string; entrypoints: string[]; dependencies: string[] }) => Promise<boolean>;
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
  if (manifest.manifestVersion !== 1 || manifest.product?.name !== 'TransportX Agent') throw new Error('Invalid TransportX runtime manifest');
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
          if (response.statusCode !== 200 || health.status !== 'ok' || !compatibleHostHealth(health)) throw new Error('Agent Host is incompatible; upgrade or restart it.');
          resolve();
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Agent Host health check timed out')));
    request.on('error', reject);
  });
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
  if (isUtilityProcess(child)) {
    const wrapped = (code: number) => listener(code);
    child.once('exit', wrapped);
    return () => child.removeListener('exit', wrapped);
  }
  child.once('exit', listener);
  return () => child.removeListener('exit', listener);
}

function terminateProcessTree(child: AgentHostProcess) {
  if (!child.pid) return;
  if (isUtilityProcess(child)) {
    try { process.kill(child.pid, 'SIGKILL'); } catch {}
    return;
  }
  if (hostPlatform.tree === 'taskkill') {
    execFile(hostPlatform.treeCommand, [hostPlatform.treeArgs[0], String(child.pid), ...hostPlatform.treeArgs.slice(1), hostPlatform.treeForceArg], () => {});
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
    this.stopping = false;
    const { paths } = this.options;
    if (!fs.existsSync(paths.agentHostEntrypoint)) throw new Error(`Agent Host entrypoint is missing: ${paths.agentHostEntrypoint}`);
    const logFile = path.join(paths.logsDir, 'agent-host.log');
    const log = createDiagnosticLogger(logFile);
    log('info', 'host_starting');
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
    const child: AgentHostProcess = hostPlatform.utilityHost
      ? utilityProcess.fork(paths.agentHostEntrypoint, args, {
          env,
          serviceName: 'TransportX Agent Host',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(process.execPath, [paths.agentHostEntrypoint, ...args], {
          env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
          detached: hostPlatform.detached,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
    this.child = child;
    child.on('message', (message: unknown) => {
      const trust = message as { type?: string; id?: string; request?: Parameters<NonNullable<SupervisorOptions['confirmModuleTrust']>>[0] };
      if (trust?.type === 'transportx-module-trust-request' && trust.id) {
        const request = trust.request;
        if (!request || typeof request.id !== 'string' || typeof request.version !== 'string' || typeof request.name !== 'string' || typeof request.packageRoot !== 'string' || !Array.isArray(request.entrypoints) || !Array.isArray(request.dependencies)) return;
        const respond = (accepted: boolean) => {
          if (this.child !== child || this.stopping) return;
          try { sendMessage(child, { type: 'transportx-module-trust-response', id: trust.id, accepted }); } catch {}
        };
        if (!this.options.confirmModuleTrust) respond(false);
        else this.options.confirmModuleTrust(request).then(respond, () => respond(false));
        return;
      }
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
      let stderr = '';
      let settled = false;
      const timeout = setTimeout(() => finish(new Error('Agent Host startup timed out')), this.options.startupTimeoutMs ?? 15_000);
      const finish = (error?: Error, url?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) { log('error', 'host_start_failed', { message: error.message, stack: error.stack }); this.stop().finally(() => reject(error)); } else resolve(url!);
      };
      const childStdout = child.stdout as Readable | null;
      const childStderr = child.stderr as Readable | null;
      if (!childStdout || !childStderr) return finish(new Error('Agent Host output pipes are unavailable'));
      childStdout.setEncoding('utf8');
      childStderr.setEncoding('utf8');
      childStdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > 32 * 1024) { log('warn', 'host_stdout_truncated', { bytes: Buffer.byteLength(stdout) }); stdout = ''; return; }
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() || '';
        for (const line of lines) {
          log('info', 'host_stdout', { message: line });
          const ready = parseReadyLine(line.trim());
          if (!ready) continue;
          const url = `http://127.0.0.1:${ready.port}`;
          checkHealth(url).then(() => finish(undefined, url), (error) => finish(new Error(`Agent Host health check failed: ${error instanceof Error ? error.message : String(error)}`)));
        }
      });
      childStderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (Buffer.byteLength(stderr) > 32 * 1024) { log('warn', 'host_stderr_truncated', { bytes: Buffer.byteLength(stderr) }); stderr = ''; return; }
        const lines = stderr.split(/\r?\n/); stderr = lines.pop() || '';
        for (const message of lines) if (message.trim()) log('warn', 'host_stderr', { message });
      });
      if (isUtilityProcess(child)) child.once('error', (type, location) => finish(new Error(`Agent Host ${type} at ${location}`)));
      else child.once('error', (error: Error) => finish(error));
      onceExit(child, (code, signal) => {
        if (stdout.trim()) log('info', 'host_stdout', { message: stdout });
        if (stderr.trim()) log('warn', 'host_stderr', { message: stderr });
        log(this.stopping ? 'info' : 'error', 'host_exited', { exitCode: code, signal });
        this.child = null;
        const message = `Agent Host exited (${signal || code})`;
        if (!settled) finish(new Error(`${message}\nLog: ${logFile}`));
        else if (!this.stopping) this.options.onUnexpectedExit?.(message);
      });
    });
  }

  async stopForUpdate(): Promise<void> {
    const child = this.child;
    if (!child) throw new Error('Agent Host is unavailable');
    const id = crypto.randomUUID();
    this.stopping = true;
    try {
      await new Promise<void>((resolve, reject) => {
        let acknowledged = false;
        let exited = false;
        const finish = (error?: Error) => {
          clearTimeout(timeout);
          child.removeListener('message', onMessage);
          removeExit();
          if (error) reject(error); else resolve();
        };
        const confirm = () => { if (acknowledged && exited) finish(); };
        const onMessage = (value: unknown) => {
          const response = value as { type?: string; id?: string; ok?: boolean; code?: string };
          if (response?.type !== 'transportx-update-stopped' || response.id !== id) return;
          if (!response.ok) return finish(Object.assign(new Error('Host refused update preparation'), { code: response.code }));
          acknowledged = true;
          confirm();
        };
        const onExit = (code: number | null) => {
          if (code !== 0) return finish(new Error('Host did not exit cleanly'));
          exited = true;
          confirm();
        };
        const timeout = setTimeout(() => finish(new Error('Host update preparation timed out')), this.options.updatePreparationTimeoutMs ?? 15_000);
        child.on('message', onMessage);
        const removeExit = onceExit(child, onExit);
        try { sendMessage(child, { type: 'transportx-update-stop', id }); } catch (error) { finish(error as Error); }
      });
    } catch (error) {
      if (this.child === child) {
        try { sendMessage(child, { type: 'transportx-update-cancel', id }); } catch {}
        this.stopping = false;
      }
      throw error;
    }
  }

  async recoverAfterUpdate(): Promise<string | null> {
    if (this.child) return null;
    return this.start();
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { terminateProcessTree(child); resolve(); }, this.options.shutdownTimeoutMs ?? 5000);
      const removeExit = onceExit(child, () => { clearTimeout(timeout); resolve(); });
      try { sendMessage(child, { type: 'transportx-agent-host-stop' }); } catch { terminateProcessTree(child); }
      if (!isUtilityProcess(child) && (child.exitCode !== null || child.signalCode !== null)) { clearTimeout(timeout); removeExit(); resolve(); }
    });
    this.child = null;
  }
}
