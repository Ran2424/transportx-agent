import fs from 'node:fs';
import path from 'node:path';
import { containedFile } from './resource-path.js';
import { relativePosixPath } from './path.js';

type OwnerSession = { cwd: string; sessionFile: string | null; resolvedSessionPlan: { workspace: string } | null };

// Called only after the route's live-session/service authorization. Neither the
// request body, cwd alone, nor Pi's volatile RPC id can establish this identity.
export function executionOwner(session: OwnerSession, sessionsDir: string) {
  if (!session.sessionFile || path.extname(session.sessionFile) !== '.jsonl') throw new Error('Execution owner requires a persisted Pi session');
  const file = fs.realpathSync(containedFile(sessionsDir, session.sessionFile));
  const descriptor = fs.openSync(file, 'r');
  let line: string;
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, count).toString('utf8');
    const end = text.indexOf('\n');
    if (end < 0) throw new Error('Pi session header is not persisted or is too large');
    line = text.slice(0, end);
  } finally { fs.closeSync(descriptor); }
  const header = JSON.parse(line) as { type?: string; id?: string; cwd?: string };
  if (header.type !== 'session' || typeof header.id !== 'string' || !header.id.trim() || typeof header.cwd !== 'string') throw new Error('Invalid Pi session owner header');
  const cwd = fs.realpathSync(session.cwd);
  if (!session.resolvedSessionPlan || fs.realpathSync(header.cwd) !== cwd || fs.realpathSync(session.resolvedSessionPlan.workspace) !== cwd) throw new Error('Pi session owner workspace mismatch');
  return { historyKey: relativePosixPath(fs.realpathSync(sessionsDir), file), piSessionId: header.id };
}
