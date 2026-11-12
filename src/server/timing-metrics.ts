import fs = require('node:fs');
import path = require('node:path');
import crypto = require('node:crypto');

import type { JsonRecord } from './types.js';
import { conversationStatePath } from './workspace-store.js';
import { readJsonObject, writeJsonAtomic } from './util/json-storage.js';

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
  working?: Record<string, number>;
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

function indexPath(directory: string) { return path.join(directory, 'timing-metrics.v1.json'); }

function messageKey(message: TimingMessage): string {
  if (typeof message.responseId === 'string' && message.responseId) return `thinking:response:${message.responseId}`;
  const signature = JSON.stringify({ role: message.role, timestamp: message.timestamp, content: message.content });
  return `thinking:message:${crypto.createHash('sha256').update(signature).digest('hex').slice(0, 24)}`;
}

function toolKey(toolCallId: string) { return `tool:${toolCallId}`; }
function workingKey(message: TimingMessage) { return `working:${message.timestamp ?? ''}:${messageKey(message)}`; }

function emptyIndex(): TimingIndex {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: new Date(0).toISOString(), records: {} };
}

function readIndex(directory: string): TimingIndex {
  const parsed = readJsonObject(indexPath(directory), emptyIndex()) as Partial<TimingIndex>;
  if (parsed.schemaVersion !== SCHEMA_VERSION || !parsed.records || typeof parsed.records !== 'object' || Array.isArray(parsed.records)) throw Object.assign(new Error('Timing metadata is corrupt.'), { code: 'metadata_corrupt', status: 409 });
  if (!Object.values(parsed.records).every((record) => record && ['thinking', 'tool'].includes(record.kind) && typeof record.sourceId === 'string' && !!record.sourceId && [record.startedAt, record.endedAt, record.durationMs].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0))) throw Object.assign(new Error('Timing metadata record is corrupt.'), { code: 'metadata_corrupt', status: 409 });
  const working = parsed.working && typeof parsed.working === 'object' && !Array.isArray(parsed.working)
    ? Object.fromEntries(Object.entries(parsed.working).filter(([, value]) => Number.isFinite(value) && value >= 0)) : undefined;
  return { schemaVersion: SCHEMA_VERSION, updatedAt: String(parsed.updatedAt || ''), records: parsed.records, working };
}

function writeIndex(directory: string, index: TimingIndex) {
  const target = indexPath(directory);
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('Timing metadata directory cannot be a symbolic link');
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Timing metadata file cannot be a symbolic link');
  writeJsonAtomic(target, index);
}

function attachThinking(message: TimingMessage, startedAt: number, durationMs: number): TimingMessage {
  if (!Array.isArray(message.content)) return message;
  let attached = false;
  const content = message.content.map((block) => {
    if (attached || block.type !== 'thinking') return block;
    attached = true;
    return { ...block, startedAt, durationMs };
  });
  return attached ? { ...message, content } : message;
}

function attachTool(message: TimingMessage, startedAt: number, durationMs: number): TimingMessage {
  return { ...message, startedAt, durationMs };
}

export class TimingMetricsStore {
  private index: TimingIndex;
  private directory: string;

  constructor(readonly cwd: string, readonly conversationId: string) {
    this.directory = conversationStatePath({ cwd, conversationId });
    this.index = readIndex(this.directory);
  }

  recordThinking<T extends TimingMessage>(message: T, startedAt: number, endedAt: number, durationMs: number): T {
    const enriched = attachThinking(message, startedAt, durationMs) as T;
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

  recordWorking<T extends TimingMessage>(message: T, durationMs: number): T {
    (this.index.working ??= {})[workingKey(message)] = durationMs;
    this.persist();
    return { ...message, workingDurationMs: durationMs };
  }

  enrichToolResult<T extends TimingMessage>(message: T): T {
    if (!message.toolCallId) return message;
    const record = this.index.records[toolKey(message.toolCallId)];
    return record?.kind === 'tool' ? attachTool(message, record.startedAt, record.durationMs) as T : message;
  }

  enrichEntries(entries: JsonRecord[]): JsonRecord[] {
    return entries.map((entry) => {
      const message = entry.message as TimingMessage | undefined;
      if (!message) return entry;

      let enriched = message;
      if (message.role === 'assistant') {
        const existing = Array.isArray(message.content) ? message.content.find((block) => block.type === 'thinking' && typeof block.durationMs === 'number') : undefined;
        const exact = this.index.records[messageKey(message)];
        if (exact?.kind === 'thinking') enriched = attachThinking(enriched, exact.startedAt, typeof existing?.durationMs === 'number' ? existing.durationMs : exact.durationMs);
        const working = this.index.working?.[workingKey(message)];
        if (working !== undefined) enriched = { ...enriched, workingDurationMs: working };
      } else if (message.role === 'toolResult' && message.toolCallId) {
        const exact = this.index.records[toolKey(message.toolCallId)];
        if (exact?.kind === 'tool') enriched = attachTool(enriched, exact.startedAt, message.durationMs ?? exact.durationMs);
      }

      return enriched === message ? entry : { ...entry, message: enriched as JsonRecord };
    });
  }

  private persist() {
    this.index.updatedAt = new Date().toISOString();
    writeIndex(conversationStatePath(this), this.index);
  }
}
