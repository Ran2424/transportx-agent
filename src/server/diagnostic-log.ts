import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import { toPosixPath } from './util/path.js';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';
type LogWriter = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

export function redactDiagnosticText(text: string) {
  return text
    .replace(/("(?:api[_-]?key|authorization|cookie|password|(?:[\w-]*token)|secret|key)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/\bBearer\s+[\w.+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b((?:(?:[\w-]+_)?api[ _-]?key|authorization|cookie|password|[\w-]*token|secret)\s*[=:]\s*)(?:\\?")?[^\s"'&,;\\]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[\w-]+/g, '[REDACTED]');
}

export function createDiagnosticLogger(filePath: string, maxBytes = 5 * 1024 * 1024): LogWriter {
  let warned = false;
  return (level, event, fields = {}) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const normalized = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === 'string' ? (key === 'path' || key === 'cwd' ? toPosixPath(value) : value).slice(0, 8192) : value]));
      const line = `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, level, event, ...normalized }, (key, value) => /^(?:api[_-]?key|authorization|cookie|password|[\w-]*token|secret|key)$/i.test(key) ? '[REDACTED]' : typeof value === 'string' ? redactDiagnosticText(value) : value)}\n`;
      if (fs.existsSync(filePath) && fs.statSync(filePath).size + Buffer.byteLength(line) > maxBytes) {
        fs.rmSync(`${filePath}.3`, { force: true });
        for (const index of [2, 1]) if (fs.existsSync(`${filePath}.${index}`)) fs.renameSync(`${filePath}.${index}`, `${filePath}.${index + 1}`);
        fs.renameSync(filePath, `${filePath}.1`);
      }
      fs.appendFileSync(filePath, line, { mode: 0o600 });
    } catch (error) {
      if (!warned) {
        warned = true;
        process.stderr.write(`[TransportX] Cannot write diagnostic log (${(error as NodeJS.ErrnoException).code || 'unknown'}): ${filePath}\n`);
      }
    }
  };
}

let hostLogger: LogWriter = () => {};
let initialized = false;

export function initializeHostLogging(logsDir: string, captureConsole = false) {
  if (initialized) return;
  initialized = true;
  hostLogger = createDiagnosticLogger(path.join(logsDir, 'runtime.jsonl'));
  if (captureConsole) {
    const consoleLogger = createDiagnosticLogger(path.join(logsDir, 'agent-host.log'));
    for (const level of ['info', 'warn', 'error', 'debug', 'log'] as const) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => { consoleLogger(level === 'log' ? 'info' : level, 'console', { message: format(...args) }); original(...args); };
    }
  }
  process.on('uncaughtExceptionMonitor', (error) => logHostError('uncaught_exception', error));
  hostLogger('info', 'host_logging_started', { platform: process.platform });
}

export function logHostEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  hostLogger(level, event, fields);
}

export function logHostError(event: string, error: unknown, fields: Record<string, unknown> = {}) {
  const cause = error as NodeJS.ErrnoException | null;
  hostLogger('error', event, { ...fields, code: cause?.code, path: cause?.path, message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
}
