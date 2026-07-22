import fs from 'node:fs';

import { selectCurrentSessionBranch, SESSION_SNAPSHOT_SCHEMA_VERSION } from '../contracts/index.js';
import type { JsonRecord } from './types.js';
import type { SessionSnapshot } from '../contracts/session.js';

export {
  SESSION_SNAPSHOT_SCHEMA_VERSION,
  selectCurrentSessionBranch,
  parseSessionSnapshot,
  serializeSessionSnapshot,
} from '../contracts/index.js';

/**
 * Read every raw JSONL row from a session file. Malformed lines are skipped
 * (Pi tools occasionally emit heartbeat or progress lines that are not full
 * JSON objects).
 */
export function readSessionFileEntries(filePath: string): JsonRecord[] {
  const entries: JsonRecord[] = [];
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          entries.push(parsed as JsonRecord);
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* session may not have been persisted yet */ }
  return entries;
}

export function readSessionBranch(filePath: string): JsonRecord[] {
  return selectCurrentSessionBranch(readSessionFileEntries(filePath));
}

/**
 * In-memory representation of the currently selected Pi branch. The Server
 * uses one `SessionProjection` per live session; Browser Kernel and Feature
 * Stores consume only the snapshot result.
 */
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

  snapshot(): SessionSnapshot {
    return {
      schemaVersion: SESSION_SNAPSHOT_SCHEMA_VERSION,
      entries: this.currentEntries,
    };
  }
}
