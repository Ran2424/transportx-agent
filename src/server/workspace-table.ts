import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isWithin, toPosixPath } from './util/path.js';

const METHOD = 'workspace-table/1';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 50_000;
const MAX_COLUMNS = 100;
const MAX_LIMIT = 200;

type Filter = { column: string; value: string | null };
type Aggregate = {
  op: 'count' | 'sum' | 'min' | 'max';
  column?: string;
  as: string;
  numeric?: true;
};
type Order = { column: string; direction: 'asc' | 'desc'; numeric?: true };
type Plan = {
  file: string;
  select: string[];
  filters: Filter[];
  groupBy: string[];
  aggregates: Aggregate[];
  orderBy: Order[];
  limit: number;
};
export class WorkspaceTableInputError extends Error {
  readonly status = 400;
  readonly code: string = 'workspace_table_invalid';
}
export class WorkspaceTableSourceMissingError extends WorkspaceTableInputError {
  override readonly code = 'workspace_table_source_missing';
}
const fail = (message: string): never => {
  throw new WorkspaceTableInputError(message);
};
const hash = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail('Expected an object.');
const string = (value: unknown): string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  !value.includes('\0')
    ? value
    : fail('Expected a non-empty string of at most 256 characters.');
const list = (value: unknown): unknown[] =>
  value === undefined
    ? []
    : Array.isArray(value) && value.length <= MAX_COLUMNS
      ? value
      : fail('Expected a bounded array.');
const checkAbort = (signal?: AbortSignal) => {
  if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted.');
};

function parsePlan(input: unknown): Plan {
  const p = record(input);
  const file = string(p.file);
  if (
    file.includes('\\') ||
    file
      .split('/')
      .some((part) => !part || part.startsWith('.') || part.includes(':')) ||
    !file.toLowerCase().endsWith('.csv')
  )
    fail('File must be a relative POSIX CSV path.');
  const select = list(p.select).map(string);
  const filters = list(p.filters).map((item) => {
    const f = record(item);
    if (
      f.value !== null &&
      (typeof f.value !== 'string' || f.value.length > 4096)
    )
      fail('Filter values must be strings or null.');
    return { column: string(f.column), value: f.value as string | null };
  });
  const groupBy = list(p.groupBy).map(string);
  const aggregates = list(p.aggregates).map((item) => {
    const a = record(item);
    if (a.op !== 'count' && a.op !== 'sum' && a.op !== 'min' && a.op !== 'max')
      return fail('Unsupported aggregate.');
    const column = a.column === undefined ? undefined : string(a.column);
    if (a.op !== 'count' && !column) fail('Aggregate requires a column.');
    if (a.numeric !== undefined && typeof a.numeric !== 'boolean')
      fail('numeric must be a boolean.');
    return {
      op: a.op,
      ...(column ? { column } : {}),
      as: string(a.as),
      ...(a.numeric ? { numeric: true } : {}),
    } as Aggregate;
  });
  const orderBy = list(p.orderBy).map((item) => {
    const o = record(item);
    if (
      o.direction !== undefined &&
      o.direction !== 'asc' &&
      o.direction !== 'desc'
    )
      fail('Invalid sort direction.');
    if (o.numeric !== undefined && typeof o.numeric !== 'boolean')
      fail('numeric must be a boolean.');
    return {
      column: string(o.column),
      direction: (o.direction ?? 'asc') as Order['direction'],
      ...(o.numeric ? { numeric: true } : {}),
    } as Order;
  });
  const limit = p.limit === undefined ? 50 : p.limit;
  if (
    !Number.isInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > MAX_LIMIT
  )
    fail(`Limit must be between 1 and ${MAX_LIMIT}.`);
  if (select.length && (groupBy.length || aggregates.length))
    fail('Selection cannot be combined with grouping or aggregation.');
  if (groupBy.length && !aggregates.length)
    fail('Grouping requires an aggregate.');
  return {
    file,
    select,
    filters,
    groupBy,
    aggregates,
    orderBy,
    limit: limit as number,
  };
}

async function loadCsv(cwd: string, relative: string, signal?: AbortSignal) {
  const root = await realpath(cwd);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) fail('Links and junctions are not allowed.');
  }
  const resolved = await realpath(current);
  if (
    !isWithin(root, resolved) ||
    resolved === root ||
    path.relative(root, resolved) !== path.relative(root, current)
  )
    fail('File escapes the workspace or traverses a link.');
  checkAbort(signal);
  const handle = await open(
    current,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES)
      fail('CSV must be an unlinked regular file no larger than 4 MiB.');
    const bytes = await handle.readFile();
    if (bytes.length > MAX_BYTES) fail('CSV is too large.');
    if ((await realpath(current)) !== resolved)
      fail('CSV path changed during reading.');
    checkAbort(signal);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return fail('CSV must be valid UTF-8.');
    }
    return { bytes, text, file: toPosixPath(path.relative(root, resolved)) };
  } finally {
    await handle.close();
  }
}

function parseCsv(text: string): string[][] {
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closed = false;
  const addField = () => {
    if (field.length > 4096) fail('CSV field exceeds 4096 characters.');
    row.push(field);
    field = '';
    closed = false;
    if (row.length > MAX_COLUMNS) fail('Too many CSV columns.');
  };
  const addRow = () => {
    addField();
    rows.push(row);
    row = [];
    if (rows.length > MAX_ROWS + 1) fail('Too many CSV rows.');
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === ',') addField();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      addRow();
    } else if (c === '"' && !field && !closed) quoted = true;
    else {
      if (closed || c === '"') fail('Malformed CSV quoting.');
      field += c;
    }
    if (field.length > 4096) fail('CSV field exceeds 4096 characters.');
  }
  if (quoted) fail('Malformed CSV quoting.');
  if (field || row.length || closed) addRow();
  if (!rows.length) fail('CSV is empty.');
  const header = rows[0];
  if (
    header.some((name) => !name.trim() || name.length > 256) ||
    new Set(header.map((name) => name.toLowerCase())).size !== header.length
  )
    fail('CSV column names must be non-blank and unique.');
  if (rows.slice(1).some((r) => r.length !== header.length))
    fail('CSV rows have inconsistent column counts.');
  return rows;
}

/** Read and analyze one bounded workspace CSV. Values use CSV text;
 * sum uses DECIMAL(38,9) and is returned as decimal text. Empty cells are null. */
export async function analyzeWorkspaceTable(
  cwd: string,
  input: unknown,
  signal?: AbortSignal
) {
  const plan = parsePlan(input);
  const source = await loadCsv(cwd, plan.file, signal).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        throw new WorkspaceTableSourceMissingError('The specified workspace CSV is missing.');
      throw error;
    }
  );
  const [header, ...rows] = parseCsv(source.text);
  const indexes = new Map(header.map((name, i) => [name, i]));
  const column = (name: string) => {
    const i = indexes.get(name);
    if (i === undefined) return fail(`Unknown column: ${name}`);
    return `NULLIF(json_extract_string(value, '$[${i}]'), '')`;
  };
  const unique = (names: string[]) => {
    if (new Set(names.map((name) => name.toLowerCase())).size !== names.length)
      fail('Output column names must be unique.');
  };
  const grouped = plan.aggregates.length > 0;
  const selected = grouped
    ? plan.groupBy
    : plan.select.length
      ? plan.select
      : header;
  const output = [...selected, ...plan.aggregates.map((a) => a.as)];
  unique(output);
  const expressions = selected.map(column);
  const validateNumeric = (name: string) => {
    const idx = indexes.get(name);
    if (idx === undefined) return fail(`Unknown column: ${name}`);
    if (
      rows.some(
        (row) =>
          row[idx] !== '' && !/^[+-]?(?:\d{1,28})(?:\.\d{1,9})?$/.test(row[idx])
      )
    ) {
      fail(
        `Numeric column contains a non-decimal or out-of-range value: ${name}`
      );
    }
  };
  for (const aggregate of plan.aggregates) {
    const expr = aggregate.column ? column(aggregate.column) : '*';
    if (aggregate.op === 'count')
      expressions.push(`CAST(COUNT(${expr}) AS INTEGER)`);
    else if (aggregate.op === 'sum' || aggregate.numeric) {
      validateNumeric(aggregate.column!);
      expressions.push(
        `CAST(${aggregate.op.toUpperCase()}(CAST(${expr} AS DECIMAL(38,9))) AS VARCHAR)`
      );
    } else expressions.push(`${aggregate.op.toUpperCase()}(${expr})`);
  }
  const conditions = plan.filters.map((f) =>
    f.value === null ? `${column(f.column)} IS NULL` : `${column(f.column)} = ?`
  );
  const filterValues = plan.filters.map(({ column, value }) => ({ index: indexes.get(column)!, value }));
  const matchedRows = rows.filter(row => filterValues.every(({ index, value }) => (row[index] || null) === value)).length;
  const orderIndexes = plan.orderBy.map((o) => {
    const idx = output.indexOf(o.column);
    if (idx < 0) return fail(`Unknown output sort column: ${o.column}`);
    return idx;
  });
  const sorting = plan.orderBy.map((o, i) => {
    const index = orderIndexes[i];
    const alias = `c${index}`;
    if (o.numeric) {
      const aggregate = plan.aggregates[index - selected.length];
      if (index < selected.length) validateNumeric(selected[index]);
      else if (
        aggregate?.column &&
        !aggregate.numeric &&
        (aggregate.op === 'min' || aggregate.op === 'max')
      )
        validateNumeric(aggregate.column);
    }
    const value = o.numeric ? `CAST(${alias} AS DECIMAL(38,9))` : alias;
    return `${value} ${o.direction.toUpperCase()} NULLS LAST`;
  });
  // Stable tie-breakers make truncation reproducible, including without an explicit sort.
  for (let i = 0; i < output.length; i++)
    if (!orderIndexes.includes(i)) sorting.push(`c${i} ASC NULLS LAST`);
  const sql = `SELECT ${expressions.map((e, i) => `${e} AS c${i}`).join(', ')} FROM json_each(?)${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}${grouped && selected.length ? ` GROUP BY ${selected.map(column).join(', ')}` : ''} ORDER BY ${sorting.join(', ')} LIMIT ${plan.limit + 1}`;
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(':memory:', {
    enable_external_access: 'false',
    autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false',
  });
  let connection;
  try {
    connection = await instance.connect();
    checkAbort(signal);
    const reader = await connection.runAndReadAll(sql, [
      JSON.stringify(rows),
      ...plan.filters.filter((f) => f.value !== null).map((f) => f.value!),
    ]);
    checkAbort(signal);
    const result = reader
      .getRowObjects()
      .map((row) => output.map((_, i) => row[`c${i}`]));
    const version = await connection.runAndReadAll(
      'SELECT version() AS version'
    );
    const engineVersion = String(version.getRowObjects()[0].version);
    const provenance = {
      method: METHOD,
      engineVersion,
      files: [
        {
          path: source.file,
          sha256: hash(source.bytes),
          bytes: source.bytes.length,
        },
      ],
      plan,
    };
    const limited: typeof result = [];
    let responseBytes = 0;
    for (const row of result.slice(0, plan.limit)) {
      responseBytes += Buffer.byteLength(JSON.stringify(row), 'utf8');
      if (responseBytes > 48_000) break;
      limited.push(row);
    }
    return {
      columns: output,
      sourceColumns: header,
      matchedRows,
      rows: limited,
      truncated: result.length > limited.length,
      provenance,
      runId: hash(JSON.stringify(provenance)),
    };
  } finally {
    try {
      connection?.closeSync();
    } finally {
      instance.closeSync();
    }
  }
}
