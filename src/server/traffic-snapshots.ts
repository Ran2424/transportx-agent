import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PI_AGENT_DIR } from './config.js';
import { workspaceMetadataPath } from './workspace-store.js';
import { callExperienceMcp, experienceConfig } from './experience-exchange.js';

const fail = (message: string, code = 'traffic_snapshot_invalid', status = 409) => Object.assign(new Error(message), { code, status });
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const prefix = 'traffic-snapshots/';
type Session = { cwd: string; resolvedSessionPlan: { modules: { id: string }[] } | null };
function enabled(session: Session) {
  if (!session.resolvedSessionPlan?.modules.some(module => module.id === 'com.transportx.experience-exchange'))
    throw fail('Experience Exchange is not enabled for this conversation.', 'traffic_snapshot_unavailable', 403);
}
function summary(value: unknown, scope: string) {
  if (!object(value) || !id(value.snapshot_id) || value.scope !== scope || typeof value.table !== 'string' || !value.table || typeof value.source_name !== 'string' || !digest(value.source_sha256) || !digest(value.csv_sha256) || !digest(value.definition_sha256) || !Number.isSafeInteger(value.row_count) || Number(value.row_count) < 0 || !Array.isArray(value.columns) || !value.columns.length || value.columns.length > 256 || !value.columns.every(v => typeof v === 'string' && v.length > 0 && v.length <= 256) || typeof value.created_at !== 'string') throw fail('Snapshot metadata is invalid.');
  return { snapshot_id: value.snapshot_id, scope: value.scope, table: value.table, source_name: value.source_name, source_sha256: value.source_sha256, csv_sha256: value.csv_sha256, definition_sha256: value.definition_sha256, row_count: value.row_count, columns: value.columns as string[], created_at: value.created_at, ...(Array.isArray(value.coverage) && value.coverage.length <= 256 ? { coverage: value.coverage } : {}) };
}
function registry(cwd: string, relative: string) {
  const root = fs.realpathSync(PI_AGENT_DIR);
  const dir = workspaceMetadataPath(root, 'traffic-snapshot-registry');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return workspaceMetadataPath(root, `traffic-snapshot-registry/${hash(fs.realpathSync(cwd) + '\0' + relative)}.json`);
}
export async function listTrafficSnapshots(session: Session, signal?: AbortSignal) {
  enabled(session);
  const scope = experienceConfig().scope;
  const result = await callExperienceMcp('list_data_snapshots', {}, signal);
  if (!Array.isArray(result.snapshots) || result.snapshots.length > 1000) throw fail('Snapshot list is invalid.');
  return { snapshots: result.snapshots.map(value => summary(value, scope)) };
}
export async function selectTrafficSnapshot(session: Session, snapshotId: unknown, signal?: AbortSignal) {
  enabled(session);
  if (!id(snapshotId)) throw fail('A valid snapshotId is required.', 'traffic_snapshot_invalid', 400);
  const scope = experienceConfig().scope;
  const result = await callExperienceMcp('read_data_snapshot', { snapshot_id: snapshotId }, signal);
  const snap = result.snapshot;
  const meta = summary(snap, scope);
  if (meta.snapshot_id !== snapshotId || !object(snap) || typeof snap.csv_utf8 !== 'string' || Buffer.byteLength(snap.csv_utf8) > 1024 * 1024 || hash(snap.csv_utf8) !== meta.csv_sha256 || !object(snap.definition)) throw fail('Snapshot content or identity does not match its digest.');
  // A raw definition lets the Host verify the same bytes the source hashed.
  if (typeof snap.definition_utf8 !== 'string' || Buffer.byteLength(snap.definition_utf8) > 1024 * 1024 || hash(snap.definition_utf8) !== meta.definition_sha256) throw fail('Snapshot definition digest is invalid.');
  let definition: unknown;
  try { definition = JSON.parse(snap.definition_utf8); } catch { throw fail('Snapshot definition is invalid.'); }
  if (!isDeepStrictEqual(definition, snap.definition)) throw fail('Snapshot definition content differs.');
  const relative = `${prefix}${crypto.randomUUID()}.csv`;
  const root = fs.realpathSync(session.cwd);
  const directory = workspaceMetadataPath(root, 'traffic-snapshots');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = workspaceMetadataPath(root, relative);
  const record = { schemaVersion: 1, path: relative, snapshot: meta, definition };
  const registryFile = registry(root, relative);
  // Exclusive creation protects unrelated same-name workspace and host files.
  fs.writeFileSync(target, snap.csv_utf8, { flag: 'wx', mode: 0o600 });
  try { fs.writeFileSync(registryFile, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); }
  catch (error) { fs.unlinkSync(target); throw error; }
  return { path: relative, snapshot: meta };
}
/** A controlled path never silently degrades to a local file when metadata is missing or content changes. */
export function trafficSnapshotProvenance(cwd: string, relative: string, sha256: string) {
  if (!/^traffic-snapshots\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.csv$/.test(relative)) return undefined;
  let value: unknown;
  try {
    const file = registry(cwd, relative), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw new Error('unsafe');
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { throw fail('Controlled snapshot metadata is unavailable.'); }
  if (!object(value) || value.schemaVersion !== 1 || value.path !== relative || !object(value.snapshot) || value.snapshot.csv_sha256 !== sha256 || !object(value.definition)) throw fail('Controlled snapshot content changed.');
  return { snapshot: value.snapshot, definition: value.definition };
}
