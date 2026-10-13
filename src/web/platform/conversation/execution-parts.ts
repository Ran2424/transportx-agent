import type { SessionEntry } from '../../../public/app-types.js';
import type { ToolData } from './tool-projection';

export type ExecutionActivity = { id: string; tool?: ToolData; thinking?: { text: string; active: boolean; startedAt: number | null; durationMs: number | null } };
export type ExecutionPart = { kind: 'message'; entry: SessionEntry; index: number; streaming?: boolean } | { kind: 'activity'; activity: ExecutionActivity };
type ExecutionRow = Extract<ExecutionPart, { kind: 'message' }> | { kind: 'execution'; id: string; activities: ExecutionActivity[] };

// Visible messages are boundaries; streaming text and its final entry occupy the same boundary.
export function groupExecutionParts(parts: ExecutionPart[]): ExecutionRow[] {
  const rows: ExecutionRow[] = [];
  let messages = 0;
  for (const part of parts) {
    if (part.kind === 'message') { rows.push(part); messages++; continue; }
    const previous = rows.at(-1);
    if (previous?.kind === 'execution') previous.activities.push(part.activity);
    else rows.push({ kind: 'execution', id: `execution-${messages}`, activities: [part.activity] });
  }
  return rows;
}

export function executionTiming(activities: ExecutionActivity[], running: boolean) {
  const active = running && activities.some(({ thinking, tool }) => thinking?.active || tool?.status === 'running' || tool?.status === 'preparing');
  const spans = activities.map(({ thinking, tool }) => ({ startedAt: thinking?.startedAt ?? tool?.startedAt, durationMs: thinking?.durationMs ?? tool?.durationMs }));
  // A single historical duration is exact even if its start was not recorded.
  if (!active && spans.length === 1 && typeof spans[0].durationMs === 'number' && Number.isFinite(spans[0].durationMs) && spans[0].durationMs >= 0) return { active, startedAt: null, durationMs: spans[0].durationMs };
  if (spans.some((span) => typeof span.startedAt !== 'number' || !Number.isFinite(span.startedAt) || span.startedAt < 0 || (!active && (typeof span.durationMs !== 'number' || !Number.isFinite(span.durationMs) || span.durationMs < 0)))) return { active, startedAt: null, durationMs: null };
  const startedAt = Math.min(...spans.map((span) => span.startedAt!));
  const endedAt = Math.max(...spans.map((span) => span.startedAt! + (span.durationMs ?? 0)));
  return { active, startedAt, durationMs: active ? null : Math.max(0, endedAt - startedAt) };
}
