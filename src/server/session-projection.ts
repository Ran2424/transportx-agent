const fs = require('node:fs');

import type { JsonRecord } from './types.js';

export const SESSION_SNAPSHOT_SCHEMA_VERSION = 1 as const;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function entryId(entry: JsonRecord) {
  return typeof entry.id === 'string' && entry.id ? entry.id : null;
}

/**
 * Select the active Pi branch by following parentId from the last tree entry.
 * Legacy id-less sideband entries are retained, while entries on abandoned
 * branches are excluded.
 */
export function selectCurrentSessionBranch(values: unknown[]) {
  const entries = values
    .map(record)
    .filter((entry): entry is JsonRecord => !!entry && entry.type !== 'session');
  const treeEntries = entries.filter((entry) => entryId(entry));
  if (!treeEntries.length) return entries;

  const byId = new Map<string, JsonRecord>();
  for (const entry of treeEntries) byId.set(entryId(entry)!, entry);

  const selected = new Set<string>();
  let current: JsonRecord | undefined = treeEntries.at(-1);
  while (current) {
    const id = entryId(current);
    if (!id || selected.has(id)) break;
    selected.add(id);
    const parentId = typeof current.parentId === 'string' && current.parentId ? current.parentId : null;
    current = parentId ? byId.get(parentId) : undefined;
  }

  return entries.filter((entry) => {
    const id = entryId(entry);
    return !id || selected.has(id);
  });
}

export function readSessionFileEntries(filePath: string) {
  const entries: JsonRecord[] = [];
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = record(JSON.parse(line));
        if (parsed) entries.push(parsed);
      } catch { /* skip malformed lines */ }
    }
  } catch { /* session may not have been persisted yet */ }
  return entries;
}

export function readSessionBranch(filePath: string) {
  return selectCurrentSessionBranch(readSessionFileEntries(filePath));
}

export class SessionProjection {
  private currentEntries: JsonRecord[];

  constructor(entries: unknown[] = []) {
    this.currentEntries = selectCurrentSessionBranch(entries);
  }

  get entries() {
    return this.currentEntries;
  }

  replace(entries: unknown[]) {
    this.currentEntries = selectCurrentSessionBranch(entries);
  }

  append(entry: JsonRecord) {
    if (entry.type !== 'session') this.currentEntries.push(entry);
  }

  appendMessage(message: JsonRecord) {
    this.append({ type: 'message', message });
  }

  reconcile(filePath: string | null | undefined) {
    if (!filePath || !fs.existsSync(filePath)) return false;
    this.replace(readSessionFileEntries(filePath));
    return true;
  }

  snapshot() {
    return {
      schemaVersion: SESSION_SNAPSHOT_SCHEMA_VERSION,
      entries: this.currentEntries,
    };
  }
}
