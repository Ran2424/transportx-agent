import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CountBatch, CountBucket, CountComparisonRequest, CountComparisonResult } from '../contracts/count-comparison.js';
import { APP_PATHS } from './config.js';

const METHOD = 'seattle-fremont-hourly-count/1';
const ROOT = path.join(APP_PATHS.appRoot, 'data', 'count-comparison');
const DEFINITIONS = [
  ['2024-11-04', '2024-11-11', '1cb31177eeb4e3913bb66f6e5ed257eed77ee85be8651d0521d1b61271aafc1d', 'cf5064c53208f89ad55bc859543503d6df54e2c31591e3d043db9654c3a1593f'],
  ['2024-11-11', '2024-11-18', 'b109da52ec7946259a3d85abd871299d94cf7dae0a8f8df3333a0775e7825c6f', 'af7ea33b66aca0d812fe1611a7a935aa60ebd18c814bb2a304b76862faca09bb'],
  ['2024-11-18', '2024-11-25', '6a759f55b4664c4ada5ca83def8c156f832db98741928067570148fed575af93', '6c83e62ae46496d29732cb02828e3792ebea836fe93a4ecd8a6ab54010310d5e'],
] as const;
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

type Source = { metadata: CountBatch; rows: Array<{ hour: number; count: number | null }> };
export class CountComparisonInputError extends Error {}

function loadSources(): Source[] {
  return DEFINITIONS.map(([start, end, expected, receiptHash]) => {
    const bytes = readFileSync(path.join(ROOT, `${start}.json`));
    if (sha(bytes) !== expected) throw new Error(`Source integrity check failed for ${start}`);
    const receiptBytes = readFileSync(path.join(ROOT, `${start}.capture.json`));
    if (sha(receiptBytes) !== receiptHash) throw new Error(`Capture integrity check failed for ${start}`);
    const receipt = JSON.parse(receiptBytes.toString('utf8'));
    if (receipt.sha256 !== expected || receipt.bytes !== bytes.length || receipt.dataset !== '65db-xm6k' || receipt.publisher !== 'Seattle Department of Transportation' || receipt.window_start_local !== start || receipt.window_end_local_exclusive !== end || receipt.row_count !== 168) throw new Error(`Capture receipt invalid for ${start}`);
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== receipt.row_count) throw new Error('Invalid source row count');
    const ids = new Set<string>();
    const rows = parsed.map((row: Record<string, unknown>) => {
      if (!row || typeof row.source_row_id !== 'string' || !row.source_row_id || ids.has(row.source_row_id)) throw new Error('Invalid or duplicate source row ID');
      ids.add(row.source_row_id);
      if (typeof row.date !== 'string' || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):00:00(?:\.000)?$/.test(row.date) || row.date.slice(0, 10) < start || row.date.slice(0, 10) >= end) throw new Error('Invalid source local hour');
      const value = row.fremont_bridge;
      const n = typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
      return { hour: Number(row.date.slice(11, 13)), count: Number.isSafeInteger(n) && n >= 0 ? n : null };
    });
    const finalDate = new Date(`${end}T00:00:00Z`);
    finalDate.setUTCDate(finalDate.getUTCDate() - 1);
    const label = `${start} – ${finalDate.toISOString().slice(0, 10)}`;
    const metadata: CountBatch = { id: start, label, startDate: start, endDateExclusive: end, rowCount: rows.length, sha256: expected, sourceUrl: receipt.url };
    return { metadata, rows };
  });
}

export function listCountBatches(): CountBatch[] { return loadSources().map((item) => item.metadata); }

export async function compareCounts(payload: unknown): Promise<CountComparisonResult> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CountComparisonInputError('Select two different batches and a local hour range.');
  }
  const input = payload as CountComparisonRequest;
  if (typeof input.batchA !== 'string' || typeof input.batchB !== 'string' || input.batchA === input.batchB ||
      !Number.isInteger(input.startHour) || !Number.isInteger(input.endHour) ||
      input.startHour < 0 || input.endHour > 23 || input.startHour > input.endHour) {
    throw new CountComparisonInputError('Select two different batches and a valid inclusive local-hour range (0–23).');
  }
  const sources = loadSources();
  const a = sources.find((source) => source.metadata.id === input.batchA);
  const b = sources.find((source) => source.metadata.id === input.batchB);
  if (!a || !b) throw new CountComparisonInputError('Unknown count batch.');
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(':memory:', {
    enable_external_access: 'false', autoinstall_known_extensions: 'false', autoload_known_extensions: 'false',
  });
  let connection;
  try {
    connection = await instance.connect();
    const records = [a, b].flatMap((source, batch) => source.rows.map((row) => ({ batch, ...row })));
    const reader = await connection.runAndReadAll(`SELECT CAST(json_extract_string(value, '$.batch') AS INTEGER) AS batch,
      CAST(json_extract_string(value, '$.hour') AS INTEGER) AS hour,
      CAST(count(*) AS INTEGER) AS total,
      CAST(count(try_cast(json_extract_string(value, '$.count') AS BIGINT)) AS INTEGER) AS valid,
      CAST(sum(try_cast(json_extract_string(value, '$.count') AS BIGINT)) AS DOUBLE) AS sum,
      avg(try_cast(json_extract_string(value, '$.count') AS BIGINT)) AS average
      FROM json_each(?) WHERE CAST(json_extract_string(value, '$.hour') AS INTEGER) BETWEEN ? AND ?
      GROUP BY batch, hour ORDER BY batch, hour`, [JSON.stringify(records), input.startHour, input.endHour]);
    const buckets = new Map<string, CountBucket>();
    for (const row of reader.getRowObjects()) {
      buckets.set(`${row.batch}:${row.hour}`, { total: Number(row.total), valid: Number(row.valid), sum: row.sum === null ? null : Number(row.sum), average: row.average === null ? null : Number(row.average) });
    }
    const empty = (): CountBucket => ({ average: null, valid: 0, total: 0, sum: null });
    const rows = Array.from({ length: input.endHour - input.startHour + 1 }, (_, index) => {
      const hour = input.startHour + index;
      return { hour, values: [buckets.get(`0:${hour}`) ?? empty(), buckets.get(`1:${hour}`) ?? empty()] as [CountBucket, CountBucket] };
    });
    const versionReader = await connection.runAndReadAll('SELECT version() AS version');
    const engineVersion = String(versionReader.getRowObjects()[0].version);
    const runId = sha(JSON.stringify({ methodVersion: METHOD, engineVersion, inputs: [a.metadata.sha256, b.metadata.sha256], startHour: input.startHour, endHour: input.endHour }));
    return { runId, engineVersion, methodVersion: METHOD, batches: [a.metadata, b.metadata], startHour: input.startHour, endHour: input.endHour, rows };
  } finally {
    try { connection?.closeSync(); } finally { instance.closeSync(); }
  }
}
