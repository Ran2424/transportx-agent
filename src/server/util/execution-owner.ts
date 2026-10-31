import fs from 'node:fs';
import path from 'node:path';
import { containedFile } from './resource-path.js';
import { relativePosixPath, isWithin } from './path.js';
import crypto from 'node:crypto';
import { canonicalToolSchema } from '../../contracts/tool-interface.js';

export type OwnerSession = { cwd: string; sessionFile: string | null; resolvedSessionPlan: { workspace: string } | null };
export const executionOwnerKey = (owner: ReturnType<typeof executionOwner>) => crypto.createHash('sha256').update(canonicalToolSchema(owner, 'data')).digest('hex');

/** Cleanup still requires the real plan, cwd and Native header; an audit key is never an input. */
export async function removeExecutionMetadata(roots: string[], session: OwnerSession, sessionsDirectory: string) {
  const key = executionOwnerKey(executionOwner(session, sessionsDirectory));
  for (const root of roots) {
    const directory = path.join(root, key);
    if (!fs.existsSync(directory)) continue;
    const safe = fs.realpathSync(directory);
    if (!isWithin(fs.realpathSync(root), safe) || fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(safe).isDirectory()) throw new Error('Invocation metadata directory is invalid.');
    await fs.promises.rm(safe, { recursive: true, force: true });
  }
}

// Called after live-service authorization or a validated persistent deletion scope. Neither the
// request body, cwd alone, nor Pi's volatile RPC id can establish this identity.
export function executionOwner(session: OwnerSession, sessionsDir: string) {
  if (!session.sessionFile || path.extname(session.sessionFile) !== '.jsonl') throw new Error('Execution owner requires a persisted Pi session');
  const file = fs.realpathSync(containedFile(sessionsDir, session.sessionFile));
  const root = fs.realpathSync(sessionsDir);
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
  return { historyKey: relativePosixPath(root, file), piSessionId: header.id };
}
