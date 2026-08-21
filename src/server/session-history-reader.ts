import * as fs from 'node:fs';
import * as readline from 'node:readline';

import type { JsonRecord } from './types.js';

type NormalizeSessionCwd = (cwd: unknown) => string | null;

export type SessionHistorySummary = {
  id: unknown;
  timestamp: unknown;
  lastConversationAt: unknown;
  name: string | null;
  firstMessage: string | null;
  cwd: string | null;
};

export type SessionHistorySearchResult = {
  filePath: string;
  project: string;
  sessionId: string;
  sessionName: string;
  sessionTimestamp: string;
  firstMessage: string;
  matches: Array<{ role: string; snippet: string }>;
};

export function titleFromMessageContent(content: unknown) {
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((block): block is { type?: unknown; text?: unknown } => !!block && typeof block === 'object').filter((block) => block.type === 'text').map((block) => typeof block.text === 'string' ? block.text : '').join('\n')
    : '';
  let title = text.replace(/^(ok |okay |so |actually |hey |please |can you |could you |i want(ed)? to |i wanna |let'?s )/i, '').replace(/\n.*/s, '').trim();
  if (!title) return null;
  const sentenceEnd = title.search(/[.!?]\s/);
  if (sentenceEnd > 10 && sentenceEnd < 80) title = title.slice(0, sentenceEnd);
  if (title.length > 60) title = title.slice(0, 57).replace(/\s+\S*$/, '') + '…';
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export function deriveSessionName(entries: JsonRecord[], isGenericSessionName: (name: string) => boolean) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; name?: unknown };
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (entry?.type === 'session_info' && name && !isGenericSessionName(name)) return name;
  }
  for (const entry of entries) {
    const message = entry as { type?: string; message?: { role?: string; content?: unknown } };
    if (message?.type === 'message' && message.message?.role === 'user') {
      const title = titleFromMessageContent(message.message.content);
      if (title) return title;
    }
  }
  return null;
}

export function readSessionHeaderCwd(filePath: string, normalizeSessionCwd: NormalizeSessionCwd) {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.toString('utf8', 0, count).split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry?.type === 'session') return normalizeSessionCwd(entry.cwd);
    }
  } catch { return null; }
  finally { if (fd !== null) try { fs.closeSync(fd); } catch {} }
  return null;
}

export async function readSessionSummary(filePath: string, normalizeSessionCwd: NormalizeSessionCwd): Promise<SessionHistorySummary | null> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header: JsonRecord | null = null, firstMessage: string | null = null, sessionName: string | null = null, lastConversationAt = '', userMessageCount = 0, lineCount = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    lineCount += 1;
    try {
      const entry = JSON.parse(line) as JsonRecord;
      if (entry.type === 'session') header = entry;
      else if (entry.type === 'session_info' && typeof entry.name === 'string') sessionName = entry.name;
      else if (entry.type === 'message' && (entry.message as JsonRecord | undefined)?.role === 'user') {
        userMessageCount += 1;
        if (!firstMessage) firstMessage = titleFromMessageContent((entry.message as JsonRecord).content);
      }
      if (entry.type === 'message' && ['user', 'assistant'].includes(String((entry.message as JsonRecord | undefined)?.role || ''))) {
        const timestamp = messageTimestamp(entry);
        if (timestamp > lastConversationAt) lastConversationAt = timestamp;
      }
    } catch {}
  }
  lines.close(); stream.destroy();
  if (!header?.id || (userMessageCount <= 1 && lineCount <= 8)) return null;
  return { id: header.id, timestamp: header.timestamp || '', lastConversationAt: lastConversationAt || header.timestamp || '', name: sessionName, firstMessage, cwd: normalizeSessionCwd(header.cwd) };
}

export async function searchSessionFile(filePath: string, query: string, normalizeSessionCwd: NormalizeSessionCwd): Promise<SessionHistorySearchResult | null> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const needle = query.toLowerCase();
  let sessionId = '', sessionName = '', sessionTimestamp = '', firstMessage = '', cwd: string | null = null;
  const matches: Array<{ role: string; snippet: string }> = [];
  for await (const line of lines) try {
    const entry = JSON.parse(line);
    if (entry.type === 'session') { sessionId = entry.id; sessionTimestamp = entry.timestamp || ''; cwd = normalizeSessionCwd(entry.cwd); }
    if (entry.type === 'session_info' && entry.name) sessionName = entry.name;
    if (entry.type === 'message') {
      const content = entry.message?.content, text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((block) => block.type === 'text').map((block) => block.text).join(' ') : '';
      if (!firstMessage && entry.message?.role === 'user' && text) firstMessage = text.slice(0, 120);
      const index = text.toLowerCase().indexOf(needle);
      if (index >= 0) matches.push({ role: entry.message?.role || 'unknown', snippet: `${index > 0 ? '…' : ''}${text.slice(Math.max(0, index - 60), Math.min(text.length, index + needle.length + 60)).replace(/\n/g, ' ')}${index + needle.length + 60 < text.length ? '…' : ''}` });
      if (matches.length >= 3) break;
    }
  } catch {}
  lines.close(); stream.destroy();
  return matches.length ? { filePath, project: cwd || '', sessionId, sessionName, sessionTimestamp, firstMessage, matches } : null;
}

function messageTimestamp(entry: JsonRecord) {
  const message = entry.message as { timestamp?: unknown } | undefined;
  const value = message?.timestamp ?? entry.timestamp;
  const date = typeof value === 'number' ? new Date(value) : typeof value === 'string' ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : '';
}
