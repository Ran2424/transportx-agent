import fs = require('node:fs');
import { randomUUID } from 'node:crypto';
import type { JsonRecord } from './types.js';

export function isGenericSessionName(name: unknown) {
  const normalized = String(name || '').trim().toLowerCase();
  return normalized === 'chat' || normalized === 'new chat' || normalized === 'untitled' || normalized === 'untitled chat' || normalized === 'session';
}

/** Called with Pi stopped and the workspace runtime lease held, before reopening. */
export function repairLegacySessionNameTail(filePath: string, name: string) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const invalid = () => Object.assign(new Error('Native name metadata has no verified continuation. Original history was preserved.'), { code: 'history_identity_mismatch' });
  let entries: JsonRecord[];
  try { entries = raw.trimEnd().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as JsonRecord); } catch { throw invalid(); }
  if (entries.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) throw invalid();
  const tail = entries.at(-1);
  if (entries[0]?.version !== 3 || tail?.type !== 'session_info' || (typeof tail.id === 'string' && tail.id.length > 0)) return false;
  const legacy = (entry: JsonRecord) => entry.type === 'session_info' && entry.id === undefined && entry.parentId === undefined && (entry.explicit === undefined || entry.explicit === true) && typeof entry.name === 'string' && typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp)) && Object.keys(entry).every((key) => ['type', 'name', 'explicit', 'timestamp'].includes(key));
  if (!raw.endsWith('\n') || !legacy(tail)) throw invalid();
  let index = entries.length - 1;
  while (index > 0 && legacy(entries[index])) index--;
  const previous = entries[index];
  const parentId = previous.type === 'session' ? null : previous.id;
  const identified = entries.slice(1, index + 1).filter((entry) => typeof entry.id === 'string' && entry.id);
  const byId = new Map(identified.map((entry) => [entry.id, entry]));
  if (byId.size !== identified.length) throw invalid();
  const seen = new Set<string>();
  let ancestor = parentId;
  while (ancestor !== null) {
    if (typeof ancestor !== 'string' || !ancestor || seen.has(ancestor) || !byId.has(ancestor)) throw invalid();
    seen.add(ancestor); ancestor = byId.get(ancestor)!.parentId;
  }
  // Retain every original byte; bridge only the known old Host's id-less tail.
  fs.appendFileSync(filePath, `${JSON.stringify({ type: 'session_info', id: randomUUID(), parentId, timestamp: new Date().toISOString(), name, explicit: true })}\n`);
  return true;
}

// Pi's SessionManager performs its first flush with openSync(file, 'wx');
// appending before that flush would pre-create the file and make Pi throw
// EEXIST. Only append once the file holds Pi's own header (first line
// type === 'session'); callers keep the pending name and retry otherwise.
export function sessionFileReadyForNameAppend(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      const firstLine = buf.subarray(0, read).toString('utf8').split('\n').find((line) => line.trim());
      if (!firstLine) return false;
      return (JSON.parse(firstLine) as { type?: unknown }).type === 'session';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function inferSessionTitle(messages: string[]) {
  const message = messages.find((item) => item.trim().length > 8) || messages[0];
  if (!message) return null;
  let title = message.replace(/^(ok |okay |so |actually |hey |please |can you |could you |i want(ed)? to |i wanna |let'?s )/i, '').replace(/\n.*/s, '').trim();
  const sentenceEnd = title.search(/[.!?]\s/);
  if (sentenceEnd > 10 && sentenceEnd < 80) title = title.slice(0, sentenceEnd);
  if (title.length > 60) title = title.slice(0, 57).replace(/\s+\S*$/, '') + '…';
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return title || null;
}
