import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PI_AGENT_DIR } from './config.js';
import { workspaceMetadataPath } from './workspace-store.js';
import { callExperienceMcp, experienceConfig } from './experience-exchange.js';
import { trafficSnapshotProvenance } from './traffic-snapshots.js';

type Obj = Record<string, any>;
type Context = { cwd: string; conversationId: string; resolvedSessionPlan: { modules: { id: string }[] } | null };
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const fail = (message: string) => Object.assign(new Error(message), { status: 409, code: 'experience_run_use_failed' });
function file(session: Context) {
  const root = fs.realpathSync(PI_AGENT_DIR), directory = workspaceMetadataPath(root, 'experience-run-receipts');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return workspaceMetadataPath(root, `experience-run-receipts/${hash(fs.realpathSync(session.cwd) + '\0' + session.conversationId)}.jsonl`);
}
function read(session: Context): Obj[] {
  const target = file(session);
  try {
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) throw fail('Unsafe receipt ledger.'); return fs.readFileSync(fd, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    finally { fs.closeSync(fd); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
function append(session: Context, entry: Obj) {
  const fd = fs.openSync(file(session), fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { const stat = fs.fstatSync(fd), line = JSON.stringify(entry) + '\n'; if (!stat.isFile() || stat.nlink !== 1 || stat.size + Buffer.byteLength(line) > 16 * 1024 * 1024) throw fail('Unsafe receipt ledger.'); fs.writeFileSync(fd, line); }
  finally { fs.closeSync(fd); }
}
const token = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 200;
export function recordSearch(session: Context, toolCallId: unknown, result: Obj) {
  if (!token(toolCallId)) throw fail('Search call identity is required.');
  append(session, { kind: 'search', toolCallId, scope: result.scope, experiences: result.experiences });
}
export function recordTable(session: Context, toolCallId: unknown, result: Obj) {
  if (!token(toolCallId)) throw fail('Table call identity is required.');
  append(session, { kind: 'table', toolCallId, files: result.provenance.files });
}
export function recordUse(session: Context, input: Obj) {
  const { receiptId, lookupToolCallId, releaseId, revision, digest, disposition, reason } = input;
  if (!token(receiptId) || !token(lookupToolCallId) || !token(releaseId) || !Number.isInteger(revision) || !token(digest) || !['used', 'skipped'].includes(disposition) || typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw fail('Invalid use receipt.');
  const scope = experienceConfig().scope, entries = read(session);
  const found = [...entries].reverse().find(entry => entry.kind === 'search' && entry.scope === scope && entry.toolCallId === lookupToolCallId)?.experiences?.find((item: Obj) => item.release_id === releaseId && item.revision === revision && item.digest === digest);
  if (!found) throw fail('Use must match an exact search result in this conversation.');
  const experience = { release_id: found.release_id, entry_id: found.entry_id, collection_id: found.collection_id, revision: found.revision, digest: found.digest };
  const record = { kind: 'use', receiptId, lookupToolCallId, disposition, reason: reason.trim(), experience, scope };
  const previous = entries.find(entry => entry.kind === 'use' && entry.receiptId === receiptId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw fail('Receipt identity was already used.');
  if (!previous) append(session, record);
}
function validSnapshotIds(session: Context, entries: Obj[], selected: string[]) {
  const ids = new Set<string>();
  for (const toolCallId of selected) {
    const table = [...entries].reverse().find(entry => entry.kind === 'table' && entry.toolCallId === toolCallId);
    if (!table || !Array.isArray(table.files)) throw fail('Selected table receipt is unavailable.');
    for (const source of table.files) {
      if (!source.upstream) continue;
      if (typeof source.path !== 'string' || !source.path.startsWith('traffic-snapshots/')) throw fail('Invalid selected snapshot path.');
      const target = workspaceMetadataPath(fs.realpathSync(session.cwd), source.path), stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw fail('Selected snapshot is unavailable.');
      const digest = hash(fs.readFileSync(target));
      if (digest !== source.sha256) throw fail('Selected snapshot changed.');
      const upstream = trafficSnapshotProvenance(session.cwd, source.path, digest);
      if (!upstream || typeof upstream.snapshot.snapshot_id !== 'string') throw fail('Selected snapshot metadata is unavailable.');
      ids.add(upstream.snapshot.snapshot_id);
    }
  }
  return [...ids].sort();
}
async function send(session: Context, pending: Obj, signal?: AbortSignal) {
  const result = await callExperienceMcp('record_external_run_use', pending.payload, signal);
  if (typeof result.usage_id !== 'string' || result.disposition !== pending.payload.disposition) throw fail('Invalid remote use receipt.');
  append(session, { kind: 'synced', submissionId: pending.payload.submission_id, usageId: result.usage_id });
}
export async function finalizeUses(session: Context, input: Obj, signal?: AbortSignal) {
  if (!session.resolvedSessionPlan?.modules.some(m => m.id === 'com.transportx.experience-exchange')) return { synced: 0, pending: 0 };
  if (!token(input.runId) || !Array.isArray(input.relatedToolCallIds) || input.relatedToolCallIds.length > 8 || !input.relatedToolCallIds.every(token) || !Array.isArray(input.selectedTableToolCallIds) || input.selectedTableToolCallIds.length > 16 || !input.selectedTableToolCallIds.every(token)) throw fail('Invalid delivery receipt.');
  const entries = read(session), snapshotIds = validSnapshotIds(session, entries, input.selectedTableToolCallIds);
  const related = new Set<string>(input.relatedToolCallIds);
  const uses = [...related].flatMap(id => entries.filter(entry => entry.kind === 'use' && entry.receiptId === id));
  const toSend: Obj[] = [];
  let synced = 0, pendingCount = 0;
  // Persist all work before the first network call, so interruption cannot lose later receipts.
  for (const use of uses) {
    const submissionId = 'tx_' + hash(session.conversationId + '\0' + input.runId + '\0' + use.receiptId);
    let pending = entries.find(entry => entry.kind === 'pending' && entry.payload.submission_id === submissionId);
    const evidenceRef = pending?.payload.evidence_ref || `conversation:${session.conversationId}:analysis:${input.runId}`;
    const payload = { submission_id: submissionId, run_id: input.runId, evidence_ref: evidenceRef, disposition: use.disposition, snapshot_ids: snapshotIds, experience: use.experience };
    if (pending && JSON.stringify(pending.payload) !== JSON.stringify(payload)) throw fail('Delivery receipt changed during retry.');
    if (!pending) { pending = { kind: 'pending', payload }; append(session, pending); }
    if (entries.some(entry => entry.kind === 'synced' && entry.submissionId === submissionId)) synced++;
    else toSend.push(pending);
  }
  for (const pending of toSend) {
    try { await send(session, pending, signal); synced++; } catch { pendingCount++; }
  }
  return { synced, pending: pendingCount };
}
export async function retryUses(session: Context, signal?: AbortSignal) {
  if (!session.resolvedSessionPlan?.modules.some(m => m.id === 'com.transportx.experience-exchange')) throw fail('Experience Exchange is not enabled.');
  const entries = read(session), done = new Set(entries.filter(e => e.kind === 'synced').map(e => e.submissionId));
  let synced = 0, pending = 0;
  const waiting = new Map(entries.filter(e => e.kind === 'pending' && !done.has(e.payload.submission_id))
    .map(entry => [entry.payload.submission_id, entry]));
  for (const entry of waiting.values()) {
    try { await send(session, entry, signal); synced++; } catch { pending++; }
  }
  return { synced, pending };
}
