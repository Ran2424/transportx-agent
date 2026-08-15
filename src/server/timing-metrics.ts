import fs = require('node:fs');
import path = require('node:path');
import crypto = require('node:crypto');

import type { JsonRecord } from './types.js';

const SCHEMA_VERSION = 1;

type TimingRecord = {
  kind: 'thinking' | 'tool';
  sourceId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
};

type TimingIndex = {
  schemaVersion: 1;
  updatedAt: string;
  records: Record<string, TimingRecord>;
};

type TimingMessage = {
  role?: string;
  content?: string | Array<Record<string, unknown>>;
  responseId?: unknown;
  timestamp?: unknown;
  toolCallId?: string;
  durationMs?: number;
  [key: string]: unknown;
};

function tauDir(cwd: string) { return path.join(cwd, '.tau'); }
function indexPath(cwd: string) { return path.join(tauDir(cwd), 'timing-metrics.v1.json'); }

function messageKey(message: TimingMessage): string {
  if (typeof message.responseId === 'string' && message.responseId) return `thinking:response:${message.responseId}`;
  const signature = JSON.stringify({ role: message.role, timestamp: message.timestamp, content: message.content });
  return `thinking:message:${crypto.createHash('sha256').update(signature).digest('hex').slice(0, 24)}`;
}

function toolKey(toolCallId: string) { return `tool:${toolCallId}`; }

function emptyIndex(): TimingIndex {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: new Date(0).toISOString(), records: {} };
}

function readIndex(cwd: string): TimingIndex {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(cwd), 'utf8')) as Partial<TimingIndex>;
    if (parsed.schemaVersion === SCHEMA_VERSION && parsed.records && typeof parsed.records === 'object') {
      return { schemaVersion: SCHEMA_VERSION, updatedAt: String(parsed.updatedAt || ''), records: parsed.records };
    }
  } catch { /* first run or an interrupted legacy file */ }
  return emptyIndex();
}

function writeIndex(cwd: string, index: TimingIndex) {
  const directory = tauDir(cwd);
  const target = indexPath(cwd);
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('Timing metadata directory cannot be a symbolic link');
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Timing metadata file cannot be a symbolic link');
  fs.mkdirSync(directory, { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

function attachThinking(message: TimingMessage, durationMs: number): TimingMessage {
  if (!Array.isArray(message.content)) return message;
  let attached = false;
  const content = message.content.map((block) => {
    if (attached || block.type !== 'thinking') return block;
    attached = true;
    return { ...block, durationMs };
  });
  return attached ? { ...message, content } : message;
}

function attachTool(message: TimingMessage, durationMs: number): TimingMessage {
  return { ...message, durationMs };
}

export class TimingMetricsStore {
  private index: TimingIndex;

  constructor(readonly cwd: string) {
    this.index = readIndex(cwd);
  }

  recordThinking<T extends TimingMessage>(message: T, startedAt: number, endedAt: number, durationMs: number): T {
    const enriched = attachThinking(message, durationMs) as T;
    if (enriched === message) return message;
    const key = messageKey(message);
    this.index.records[key] = { kind: 'thinking', sourceId: key, startedAt, endedAt, durationMs };
    this.persist();
    return enriched;
  }

  recordTool(toolCallId: string, startedAt: number, endedAt: number, durationMs: number) {
    if (!toolCallId) return;
    this.index.records[toolKey(toolCallId)] = { kind: 'tool', sourceId: toolCallId, startedAt, endedAt, durationMs };
    this.persist();
  }

  enrichToolResult<T extends TimingMessage>(message: T): T {
    if (!message.toolCallId) return message;
    const record = this.index.records[toolKey(message.toolCallId)];
    return record?.kind === 'tool' ? attachTool(message, record.durationMs) as T : message;
  }

  enrichEntries(entries: JsonRecord[]): JsonRecord[] {
    return entries.map((entry) => {
      const message = entry.message as TimingMessage | undefined;
      if (!message) return entry;

      let enriched = message;
      if (message.role === 'assistant' && Array.isArray(message.content) && message.content.some((block) => block.type === 'thinking')) {
        const existing = message.content.find((block) => block.type === 'thinking' && typeof block.durationMs === 'number');
        const exact = this.index.records[messageKey(message)];
        if (!existing && exact?.kind === 'thinking') enriched = attachThinking(enriched, exact.durationMs);
      } else if (message.role === 'toolResult' && message.toolCallId && typeof message.durationMs !== 'number') {
        const exact = this.index.records[toolKey(message.toolCallId)];
        if (exact?.kind === 'tool') enriched = attachTool(enriched, exact.durationMs);
      }

      return enriched === message ? entry : { ...entry, message: enriched as JsonRecord };
    });
  }

  private persist() {
    this.index.updatedAt = new Date().toISOString();
    writeIndex(this.cwd, this.index);
  }
}
