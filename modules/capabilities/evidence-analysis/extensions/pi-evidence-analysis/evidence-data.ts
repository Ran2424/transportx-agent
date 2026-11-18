import { createHash } from 'node:crypto';
import { realpathSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { TableClaimInput } from '../../../../../src/contracts/evidence-analysis.mts';
import type { CheckedPlan } from '../../../../../src/contracts/workspace-handoff.ts';
import { isWithin, relativePosixPath } from '../../../../../src/server/util/path.ts';

const MAX_FILE_BYTES = 4 * 1024 * 1024;

export type Source = { path: string; sha256: string; bytes: number; upstream?: { snapshot: Record<string, unknown>; definition: Record<string, unknown> } };
type Cell = string | number | null;
export type UnmatchedFilter = { column: string; value: string | null; examples: string[] };
export type Calculation = {
  columns: string[];
  rows: Cell[][];
  matchedRows: number;
  filters: { column: string; value: string | null }[];
};
type TablePlan = {
  filters: Calculation['filters'];
  groupBy: string[];
  aggregates: { op: string; column?: string; as: string; numeric?: boolean }[];
  orderBy: { column: string; direction: string; numeric?: boolean }[];
};
export type TableObservation = Calculation & {
  plan: TablePlan;
  limited: boolean;
  handoff?: CheckedPlan;
  sampleRows?: number;
};
export type CheckedClaim = { label: string; evidenceId: string } & (
  | { kind: 'scope'; plan: TablePlan }
  | { kind: 'sample'; matchedRows: number }
  | { kind: 'time'; column: string; filters: Calculation['filters']; groups: { value: Cell; count: number }[] }
  | { kind: 'value'; column: string; row: number; value: Cell }
);
export type Proof = {
  id: string;
  toolCallId: string;
  sources: Source[];
  tableRunId?: string;
  aggregate?: true;
  calculation?: Calculation;
  observation?: TableObservation;
  handoff?: CheckedPlan;
  unmatchedFilters?: UnmatchedFilter[];
};
export type TableResult = {
  runId: string;
  provenance: { files: Source[]; plan: TablePlan; handoff?: CheckedPlan; previewOnly?: boolean };
  columns: string[];
  sourceColumns: string[];
  matchedRows: number;
  sampleRows?: number;
  rows: unknown[];
  truncated: boolean;
  unmatchedFilters?: UnmatchedFilter[];
};
export function checkedPath(cwd: string, candidate: unknown) {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) return;
  try {
    const root = realpathSync(cwd);
    const absolute = path.resolve(root, candidate);
    if (!isWithin(root, absolute)) return;
    const readable = relativePosixPath(root, absolute);
    if (!readable) return;
    if (readable.split('/').some((part) => part.startsWith('.') || part.includes(':'))) return;
    return { absolute, readable };
  } catch {
    return undefined;
  }
}

export function readIdentity(file: { absolute: string; readable: string }): Source | undefined {
  try {
    if (path.relative(file.absolute, realpathSync(file.absolute)) !== '') return;
    const stat = statSync(file.absolute);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return;
    const bytes = readFileSync(file.absolute);
    if (bytes.length !== stat.size) return;
    return {
      path: file.readable,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    return undefined;
  }
}

function isCell(value: unknown): value is Cell {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

export function calculatedResult(result: TableResult, filters: Calculation['filters']): Calculation | undefined {
  if (result.truncated || result.rows.length < 1 || result.rows.length > 20) return;
  const rows = result.rows.filter((row): row is Cell[] =>
    Array.isArray(row) && row.length === result.columns.length && row.every(isCell));
  if (rows.length !== result.rows.length) return;
  return { columns: result.columns, rows, matchedRows: result.matchedRows, filters };
}

export function observeTable(result: TableResult): TableObservation | undefined {
  const plan = result.provenance.plan;
  if (!plan || !Array.isArray(plan.filters) || !Array.isArray(plan.groupBy) ||
      !Array.isArray(plan.aggregates) || !Array.isArray(plan.orderBy)) return;
  const bounded = result.rows.slice(0, 20);
  const rows = bounded.filter((row): row is Cell[] =>
    Array.isArray(row) && row.length === result.columns.length && row.every(isCell));
  if (rows.length !== bounded.length) return;
  return {
    columns: result.columns, rows, matchedRows: result.matchedRows,
    filters: plan.filters, plan, limited: result.truncated || result.rows.length > bounded.length,
    handoff: result.provenance.handoff, sampleRows: result.sampleRows,
  };
}

export function checkClaims(proofs: ReadonlyMap<string, Proof>, claims: TableClaimInput[]): CheckedClaim[] {
  const keys = (filters: Calculation['filters']) => [...new Set(filters.map(filter =>
    JSON.stringify([filter.column, filter.value])))].sort().join('\n');
  const checked = claims.map((claim): CheckedClaim => {
    const proof = proofs.get(claim.evidenceId);
    const fact = proof?.observation;
    if (!fact || proof?.unmatchedFilters?.length)
      throw new Error('Each claim needs a successful table query from this turn with valid filters.');
    const label = claim.label.trim();
    if (!label || /[\r\n]/.test(label)) throw new Error('Give each claim a short, single-line label.');
    const base = { label, evidenceId: claim.evidenceId };
    if (claim.kind === 'scope' && (!claim.expectedFilters || keys(claim.expectedFilters) !== keys(fact.filters)))
      throw new Error('Scope expectedFilters must match the cited query’s actual filters. Recheck every named entity and category in the question and rerun the query if a condition is missing.');
    if (claim.kind !== 'scope' && claim.expectedFilters !== undefined)
      throw new Error('Only scope claims take expectedFilters.');
    if (claim.kind === 'scope' || claim.kind === 'sample') {
      if (claim.column !== undefined || claim.row !== undefined)
        throw new Error('Scope and sample claims take no column or row.');
      return claim.kind === 'scope'
        ? { ...base, kind: 'scope', plan: fact.plan }
        : { ...base, kind: 'sample', matchedRows: fact.sampleRows ?? fact.matchedRows };
    }
    const index = fact.columns.indexOf(claim.column ?? '');
    if (index < 0) throw new Error('Use an exact output column from the cited query.');
    const column = fact.columns[index]!;
    if (claim.kind === 'value') {
      const row = claim.row ?? 0;
      const values = fact.rows[row];
      if (!values) throw new Error('The cited query did not return the selected row.');
      return { ...base, kind: 'value', column, row, value: values[index]! };
    }
    const [count] = fact.plan.aggregates;
    const countIndex = count ? fact.columns.indexOf(count.as) : -1;
    if (claim.row !== undefined || fact.limited || !fact.rows.length ||
        fact.plan.groupBy.length !== 1 || fact.plan.groupBy[0] !== column ||
        fact.plan.aggregates.length !== 1 || count?.op !== 'count' || count.column != null || countIndex < 0)
      throw new Error('Time claims require a complete query grouped by that field with one count of all rows. Omit column from the count aggregate.');
    const groups = fact.rows.map(row => ({ value: row[index]!, count: Number(row[countIndex]) }));
    if (groups.some(group => !Number.isSafeInteger(group.count) || group.count < 1) ||
        groups.reduce((sum, group) => sum + group.count, 0) !== fact.matchedRows)
      throw new Error('The time buckets do not account for all matched rows.');
    return { ...base, kind: 'time', column, filters: fact.filters, groups };
  });
  const scopes = new Set(checked.filter(claim => claim.kind === 'scope').map(claim => claim.evidenceId));
  if (!checked.some(claim => claim.kind === 'sample' && scopes.has(claim.evidenceId)))
    throw new Error('Include scope and sample claims that cite the exact same query.');
  return checked;
}

export function checkHandoffDelivery(proofs: ReadonlyMap<string, Proof>, ids: string[], claims: CheckedClaim[]) {
  const selected = ids.flatMap(id => proofs.get(id) ?? []);
  const governed = selected.filter(proof => proof.handoff);
  if (!governed.length) return;
  const primary = governed.find(proof => proof.handoff?.role === 'primary');
  if (!primary?.handoff || governed.some(proof => proof.handoff?.intentId !== primary.handoff?.intentId))
    throw new Error('Cite a checked main comparison and evidence from that same prepared intent.');
  for (const kind of ['scope','sample','value'] as const) {
    if (!claims.some(claim => claim.kind === kind && claim.evidenceId === primary.id &&
        (claim.kind !== 'value' || claim.column === primary.handoff?.resultColumn)))
      throw new Error('The checked main comparison needs a scope, sample, and result claim.');
  }
  for (const time of primary.handoff.requiredTimes) {
    if (!claims.some(claim => claim.kind === 'time' && claim.column === time.column &&
      proofs.get(claim.evidenceId)?.handoff?.timeRole === time.role))
      throw new Error('Include checked time evidence for ' + time.role + ' before delivery.');
  }
}

export function claimsText(claims: CheckedClaim[], chinese: boolean) {
  const safe = (value: Cell) => value === null
    ? (chinese ? '无值' : 'No value')
    : String(value).replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]<>]/g, symbol => '\\' + symbol).slice(0, 240);
  return claims.map(claim => {
    let value: string;
    switch (claim.kind) {
      case 'scope': {
        const { filters, groupBy, aggregates, orderBy } = claim.plan;
        value = [
          filters.map(item => `${safe(item.column)} = ${safe(item.value)}`).join(' · ') ||
            (chinese ? '全表，无筛选条件' : 'All rows, no filters'),
          groupBy.length ? (chinese ? '分组 ' : 'Group by ') + groupBy.map(safe).join(', ') : '',
          aggregates.map(item => `${item.op.toUpperCase()}(${item.column ? safe(item.column) : '∗'})${item.numeric ? (chinese ? '（数值）' : ' (numeric)') : ''}`).join(', '),
          orderBy.map(item => `${safe(item.column)} ${item.direction.toUpperCase()}${item.numeric ? (chinese ? '（数值）' : ' (numeric)') : ''}`).join(', '),
        ].filter(Boolean).join(' · ');
        break;
      }
      case 'sample':
        value = String(claim.matchedRows) + (chinese ? ' 条符合该查询条件' : ' matched rows');
        break;
      case 'value':
        value = safe(claim.value);
        break;
      case 'time':
        value = [
          safe(claim.column) + ' · ' + (claim.filters.map(item => `${safe(item.column)} = ${safe(item.value)}`).join(' · ') ||
            (chinese ? '全表，无筛选条件' : 'All rows, no filters')),
          claim.groups.map(group => `${safe(group.value)} (${group.count}${chinese ? ' 条' : ' rows'})`).join(' · '),
        ].join(' · ');
        break;
    }
    return `- **${safe(claim.label)}** — ${value} · \`${claim.evidenceId}\``;
  }).join('\n');
}

export function calculationText(calculation: Calculation, chinese: boolean) {
  const text = (value: Cell) => {
    if (value === null) return chinese ? '无值' : 'No value';
    return String(value).replace(/[\r\n]+/g, ' ').replace(/\|/g, '｜').replace(/`/g, 'ˋ').slice(0, 160);
  };
  const lines = [
    chinese ? `筛选后记录数：${calculation.matchedRows} 条。` : `Matched records: ${calculation.matchedRows}.`,
  ];
  if (calculation.filters.length) {
    const conditions = calculation.filters.map(({ column, value }) => `${text(column)} = ${text(value)}`).join(' · ');
    lines.push(chinese ? `筛选条件：${conditions}` : `Filters: ${conditions}`);
  }
  if (calculation.rows.length === 1) {
    lines.unshift(calculation.columns.map((column, index) =>
      `${text(column)}${chinese ? '：' : ': '}${text(calculation.rows[0]![index] ?? null)}`).join(' · '));
    return lines.join('\n\n');
  }
  const csv = (row: Cell[]) => '| ' + row.map(text).join(' | ') + ' |';
  return [
    ...lines,
    [csv(calculation.columns), csv(calculation.columns.map(() => '---')), ...calculation.rows.map(csv)].join('\n'),
  ].join('\n\n');
}

export function note(run: { chinese: boolean; proofs: ReadonlyMap<string, Proof>; failedSources: ReadonlySet<string> }, terminal: 'missing' | 'incomplete' | 'checking') {
  if (run.chinese) {
    if (terminal === 'checking') return '正在补查本轮证据。';
    if (terminal === 'missing') return '资料不足。';
    if (run.proofs.size) return '已经取得部分工作区证据，本轮未提交可复核的最终答案。';
    if (run.failedSources.size)
      return '本轮未能核对这些来源：' + [...run.failedSources].slice(0, 3).join('、') + '。';
    return '本轮未取得可核对的工作区证据，分析尚未完成。';
  }
  if (terminal === 'checking') return 'Checking task evidence.';
  if (terminal === 'missing') return 'Evidence is incomplete.';
  if (run.proofs.size) return 'Some evidence was retrieved, but a verifiable final answer was not submitted.';
  if (run.failedSources.size)
    return 'Could not verify these sources: ' + [...run.failedSources].slice(0, 3).join(', ') + '.';
  return 'No workspace evidence was verified. The analysis is incomplete.';
}
