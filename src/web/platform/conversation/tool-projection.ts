import type { AppMessage, SessionEntry } from '../../../public/app-types.js';
import type { ToolExecution } from '../../../public/kernel/actions.js';

export type ToolData = { id: string; name: string; args: Record<string, unknown>; result?: unknown; isError?: boolean; startedAt?: number; durationMs?: number; argumentChars?: number; status: ToolExecution['status'] };

export function projectTools(entries: SessionEntry[], liveTools: Record<string, ToolExecution>) {
  const results = new Map<string, AppMessage>();
  const resultEntries = new Map<string, SessionEntry>();
  entries.forEach((entry) => {
    if (entry.message?.role !== 'toolResult' || !entry.message.toolCallId) return;
    results.set(entry.message.toolCallId, entry.message);
    resultEntries.set(entry.message.toolCallId, entry);
  });
  const byEntry = new Map<SessionEntry, ToolData[]>();
  const known = new Set<string>();
  entries.forEach((entry) => {
    const message = entry.message;
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return;
    message.content.filter((block) => block.type === 'toolCall' && block.id).forEach((block) => {
      const id = block.id!;
      known.add(id);
      const live = liveTools[id];
      const result = results.get(id);
      const tool = { id, name: live?.toolName || block.name || '', args: live?.args || block.arguments || {}, result: live?.result ?? live?.partialResult ?? (result ? { content: result.content, details: result.details } : undefined), isError: live?.isError ?? result?.isError, startedAt: live?.startedAt, durationMs: live?.durationMs ?? result?.durationMs, argumentChars: live?.argumentChars, status: live?.status || (result?.isError ? 'error' : result ? 'completed' : 'running') } satisfies ToolData;
      byEntry.set(entry, [...(byEntry.get(entry) || []), tool]);
    });
  });
  const liveOnly: ToolData[] = [];
  Object.values(liveTools).filter((tool) => !known.has(tool.toolCallId)).forEach((tool) => {
    const projected = { id: tool.toolCallId, name: tool.toolName || '', args: tool.args || {}, result: tool.result ?? tool.partialResult, isError: tool.isError, startedAt: tool.startedAt, durationMs: tool.durationMs, argumentChars: tool.argumentChars, status: tool.status } satisfies ToolData;
    const resultEntry = resultEntries.get(tool.toolCallId);
    if (resultEntry) byEntry.set(resultEntry, [projected]);
    else liveOnly.push(projected);
    known.add(tool.toolCallId);
  });
  results.forEach((result, id) => {
    if (known.has(id)) return;
    const resultEntry = resultEntries.get(id);
    if (!resultEntry) return;
    byEntry.set(resultEntry, [{ id, name: result.toolName || '', args: {}, result: { content: result.content, details: result.details }, isError: result.isError, durationMs: result.durationMs, status: result.isError ? 'error' : 'completed' }]);
  });
  return { byEntry, liveOnly };
}
