/**
 * Session snapshot contract shared between Server (Pi JSONL) and Browser Kernel.
 *
 * `SessionSnapshot` is the canonical shape stored in `LiveSessionManager` and
 * returned by `/api/sessions/*`. The Server owns file IO; this module keeps
 * the pure parsing + branch-walking logic so both sides use the same algorithm.
 *
 * Phase 3 split:
 *   - Pure logic (this file): SessionSnapshot, entries shape, branch walker,
 *     structured parsing.
 *   - File IO (src/server/session-projection.ts): readSessionFileEntries,
 *     SessionProjection class — they re-export the helpers from here.
 */
import { asRecord, type JsonRecord } from './common.ts';
import { SESSION_SNAPSHOT_SCHEMA_VERSION } from './version.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';
import { parseGeoInteractionRequestStructured, parseGeoScreenshotRequestStructured, type GeoInteractionRequestV1, type GeoScreenshotRequestV1 } from './geo.ts';

/**
 * Raw session row. The contract deliberately keeps this loose — it is the
 * wire-level shape coming out of Pi JSONL. The Browser Kernel and Server
 * refine it into narrower `SessionMessage` / `AppMessage` types once they
 * reach the consumer that actually needs the message detail.
 */
export type SessionMessage = JsonRecord & { role?: string; content?: unknown };
export type SessionEntry = JsonRecord & {
  id?: string;
  parentId?: string;
  type?: string;
  message?: SessionMessage;
  customType?: string;
  data?: unknown;
};

export type SessionSnapshot = {
  readonly schemaVersion: typeof SESSION_SNAPSHOT_SCHEMA_VERSION;
  entries: SessionEntry[];
  geoInteraction?: { contextCount: number; waitingRequest?: GeoInteractionRequestV1; waitingScreenshotRequest?: GeoScreenshotRequestV1 };
};

export type SessionBranchDiagnostic = ContractDiagnostic;

export type SessionBranchResult<T> =
  | { ok: true; value: T; diagnostics: [] }
  | { ok: false; value: null; diagnostics: SessionBranchDiagnostic[] };

function entryId(entry: JsonRecord): string | null {
  return typeof entry.id === 'string' && entry.id ? entry.id : null;
}

function entryIsBranchAnchor(entry: JsonRecord): entry is JsonRecord & { id: string } {
  return entryId(entry) !== null;
}

/**
 * Select the active Pi branch by walking parentId from the last tree entry.
 * Legacy id-less sideband entries are retained; entries on abandoned branches
 * are excluded. Pure: does not touch the file system.
 */
export function selectCurrentSessionBranch(values: unknown[]): SessionEntry[] {
  const entries = values
    .map(asRecord)
    .filter((entry): entry is JsonRecord => !!entry && entry.type !== 'session');
  const treeEntries = entries.filter(entryIsBranchAnchor);
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

/** Minimal Snapshot parser used by Server test fixtures and Browser hydrate hooks. */
export function parseSessionSnapshot(value: unknown): SessionBranchResult<SessionSnapshot> {
  const root = asRecord(value);
  if (!root) {
    return { ok: false, value: null, diagnostics: [diagnostic({ code: 'invalid_type', path: 'session', message: 'Session snapshot must be an object.' })] };
  }
  if (root.schemaVersion !== SESSION_SNAPSHOT_SCHEMA_VERSION) {
    return {
      ok: false,
      value: null,
      diagnostics: [diagnostic({
        code: 'unknown_schema_version',
        path: 'session.schemaVersion',
        message: `Unsupported schemaVersion ${JSON.stringify(root.schemaVersion)}; expected ${SESSION_SNAPSHOT_SCHEMA_VERSION}.`,
        expected: SESSION_SNAPSHOT_SCHEMA_VERSION,
        received: typeof root.schemaVersion === 'number' ? root.schemaVersion : (root.schemaVersion as string),
      })],
    };
  }
  if (!Array.isArray(root.entries)) {
    return { ok: false, value: null, diagnostics: [diagnostic({ code: 'invalid_type', path: 'session.entries', message: 'entries must be an array.' })] };
  }
  const entries = selectCurrentSessionBranch(root.entries);
  const interaction = root.geoInteraction === undefined ? null : asRecord(root.geoInteraction);
  if (root.geoInteraction !== undefined && (!interaction || !Number.isInteger(interaction.contextCount) || Number(interaction.contextCount) < 0)) {
    return { ok: false, value: null, diagnostics: [diagnostic({ code: 'invalid_type', path: 'session.geoInteraction', message: 'geoInteraction.contextCount must be a non-negative integer.' })] };
  }
  let waitingRequest: GeoInteractionRequestV1 | undefined;
  if (interaction?.waitingRequest !== undefined) {
    const parsed = parseGeoInteractionRequestStructured(interaction.waitingRequest);
    if (!parsed.ok) return { ok: false, value: null, diagnostics: parsed.diagnostics };
    waitingRequest = parsed.value;
  }
  let waitingScreenshotRequest: GeoScreenshotRequestV1 | undefined;
  if (interaction?.waitingScreenshotRequest !== undefined) {
    const parsed = parseGeoScreenshotRequestStructured(interaction.waitingScreenshotRequest);
    if (!parsed.ok) return { ok: false, value: null, diagnostics: parsed.diagnostics };
    waitingScreenshotRequest = parsed.value;
  }
  const geoInteraction = interaction
    ? { contextCount: Number(interaction.contextCount), ...(waitingRequest ? { waitingRequest } : {}), ...(waitingScreenshotRequest ? { waitingScreenshotRequest } : {}) }
    : undefined;
  return { ok: true, value: { schemaVersion: SESSION_SNAPSHOT_SCHEMA_VERSION, entries, ...(geoInteraction ? { geoInteraction } : {}) }, diagnostics: [] };
}

/** Linearize a snapshot back to a plain JSONL-friendly row array. */
export function serializeSessionSnapshot(snapshot: SessionSnapshot): JsonRecord[] {
  return snapshot.entries.map((entry) => ({ ...entry }));
}
