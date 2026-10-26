import crypto from 'node:crypto';
import {
  parseCanvasContext, parseGeoClientContextStructured, parseGeoInteractionRequestStructured, parseGeoInteractionResponseStructured,
  stripAttachmentContext, stripCanvasContextPrompt, stripGeoContextPrompt,
  ATTACHMENT_CONTEXT_BEGIN, ATTACHMENT_CONTEXT_END, type WorkspaceMigrationItemV1,
} from '../contracts/index.js';
import { workspaceCreationDigest } from './workspace-store.js';
import type { JsonRecord } from './types.js';

export type MigrationHistoryMessages = { conversationId: string; entries: JsonRecord[] };
export type MigrationPrivateIssue = { sourceId: string; file: string; key: string; reason: string; candidates: string[] };
export type MigrationPrivateFile = { relative: string; value: unknown };
const error = (file: string) => Object.assign(new Error(`Legacy private metadata is invalid: ${file}`), { code: 'metadata_corrupt', status: 409 });
const object = (value: unknown, file: string): JsonRecord => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw error(file); return value as JsonRecord; };
const text = (message: JsonRecord) => typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? (message.content as JsonRecord[]).filter((block) => block?.type === 'text').map((block) => block.text || '').join('\n') : '';
const visible = (message: JsonRecord) => stripAttachmentContext(stripGeoContextPrompt(stripCanvasContextPrompt(text(message))));
const messages = (history: MigrationHistoryMessages) => history.entries.flatMap((entry) => entry.type === 'message' && entry.message && typeof entry.message === 'object' ? [entry.message as JsonRecord] : []);
const timestamp = (message: JsonRecord) => typeof message.timestamp === 'number' ? message.timestamp : Date.parse(String(message.timestamp));
function geoResponses(message: JsonRecord) {
  if (message.role !== 'toolResult' || message.toolName !== 'request_geo_input') return [];
  const details = message.details as { result?: { response?: unknown } } | undefined;
  const candidates: unknown[] = [details?.result?.response];
  for (const block of Array.isArray(message.content) ? message.content as JsonRecord[] : []) if (block?.type === 'text' && typeof block.text === 'string') {
    try { candidates.push((JSON.parse(block.text) as { response?: unknown })?.response); } catch {}
  }
  return candidates.flatMap((candidate) => { const parsed = parseGeoInteractionResponseStructured(candidate); return parsed.ok ? [parsed.value] : []; });
}
function ids(message: JsonRecord, kind: 'geo' | 'canvas') {
  const direct = message[kind === 'geo' ? 'geoContextIds' : 'canvasContextIds'];
  const raw = text(message), start = raw.lastIndexOf(kind === 'geo' ? '[Geo context]' : '[Canvas context]'), end = raw.indexOf(kind === 'geo' ? '[/Geo context]' : '[/Canvas context]', start);
  return [...(Array.isArray(direct) ? direct : []), ...(start >= 0 && end > start ? raw.slice(start, end).match(/(?:canvas_context_|geoctx_)[A-Za-z0-9_-]+/g) || [] : [])];
}

/** Complete message/resource evidence selects one history; bare text/tool IDs never suffice. */
export function migratePrivateState(item: WorkspaceMigrationItemV1, sourceDigest: string, histories: MigrationHistoryMessages[], metadata: Map<string, unknown>, preparedAt: string, singleHistoryProven: boolean) {
  const files = new Map<string, unknown>(), issues: MigrationPrivateIssue[] = [];
  const assignments: Array<{ sourceId: string; conversationId: string | null; basis: string }> = [];
  const scoped = (id: string, relative: string) => `.tau/conversations/${id}/${relative}`;
  const choose = (file: string, key: string, matches: (history: MigrationHistoryMessages) => boolean): string | null => {
    const sourceId = `source_${workspaceCreationDigest([file, key])}`;
    const single = singleHistoryProven && histories.length === 1;
    const candidates = single ? [histories[0].conversationId] : histories.filter(matches).map((history) => history.conversationId);
    const decision = [...item.decisions].reverse().find((decision) => decision.sourceId === sourceId && decision.reportDigest === sourceDigest);
    if (decision?.action === 'isolate') { assignments.push({ sourceId, conversationId: null, basis: 'explicit-isolation' }); return null; }
    if (decision?.action === 'bind' && candidates.length === 1 && candidates[0] === decision.conversationId) { assignments.push({ sourceId, conversationId: candidates[0], basis: 'verified-bind' }); return candidates[0]; }
    if (candidates.length === 1 && !decision) { assignments.push({ sourceId, conversationId: candidates[0], basis: single ? 'single-history' : 'unique-complete-message-evidence' }); return candidates[0]; }
    issues.push({ sourceId, file, key, reason: candidates.length > 1 ? 'Multiple histories contain the same complete evidence.' : 'No unique complete message/resource association can be proven.', candidates });
    return null;
  };
  for (const history of histories) {
    files.set(scoped(history.conversationId, 'attachment-message-refs.json'), { version: 1, refs: [] });
    files.set(scoped(history.conversationId, 'canvas-contexts.json'), { version: 1, contexts: [] });
    files.set(scoped(history.conversationId, 'geo-interactions/message-refs.json'), { version: 1, refs: [] });
    files.set(scoped(history.conversationId, 'timing-metrics.v1.json'), { schemaVersion: 1, updatedAt: new Date(0).toISOString(), records: {} });
  }
  let sharedAttachments: JsonRecord | null = null;
  const attachmentFile = '.tau/attachments.json';
  if (metadata.has(attachmentFile)) {
    const value = object(metadata.get(attachmentFile), attachmentFile);
    if (value.version !== 1 || !Array.isArray(value.attachments) || value.messageRefs !== undefined && !Array.isArray(value.messageRefs)) throw error(attachmentFile);
    const attachments = value.attachments as JsonRecord[];
    if (!attachments.every((entry) => entry && typeof entry.id === 'string' && /^att_[a-z0-9]{12,32}$/.test(entry.id) && typeof entry.relativePath === 'string' && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256))) throw error(attachmentFile);
    sharedAttachments = { version: 1, attachments: attachments.map((entry) => ({ ...entry, sourceConversationId: null })) };
    for (const [index, raw] of ((value.messageRefs || []) as unknown[]).entries()) {
      const ref = object(raw, attachmentFile);
      if (typeof ref.text !== 'string' || ref.timestamp !== undefined && (typeof ref.timestamp !== 'number' || !Number.isFinite(ref.timestamp)) || !Array.isArray(ref.attachmentIds) || !ref.attachmentIds.every((id) => attachments.some((entry) => entry.id === id))) throw error(attachmentFile);
      const target = choose(attachmentFile, `messageRefs/${index}`, (history) => messages(history).some((message) => {
        if (message.role !== 'user' || visible(message) !== ref.text || ref.timestamp !== undefined && String(message.timestamp) !== String(ref.timestamp)) return false;
        const raw = text(message), start = raw.lastIndexOf(ATTACHMENT_CONTEXT_BEGIN), end = raw.indexOf(ATTACHMENT_CONTEXT_END, start);
        const context = start >= 0 && end > start ? raw.slice(start, end) : '';
        return (ref.attachmentIds as string[]).every((id) => Array.isArray(message.attachmentIds) && message.attachmentIds.includes(id) || context.split(/\r?\n/).some((line) => line.trim() === `相对路径：${attachments.find((entry) => entry.id === id)!.relativePath}`));
      }));
      if (target) (files.get(scoped(target, 'attachment-message-refs.json')) as { refs: unknown[] }).refs.push(ref);
    }
  }
  const canvasFile = '.tau/canvas-contexts.json';
  if (metadata.has(canvasFile)) {
    const value = metadata.get(canvasFile);
    if (!Array.isArray(value)) throw error(canvasFile);
    for (const raw of value) {
      const context = parseCanvasContext(raw); if (!context) throw error(canvasFile);
      const target = choose(canvasFile, context.contextId, (history) => messages(history).some((message) => message.role === 'user' && ids(message, 'canvas').includes(context.contextId)));
      if (target) (files.get(scoped(target, 'canvas-contexts.json')) as { contexts: unknown[] }).contexts.push(context);
    }
  }
  const geoRoot = '.tau/geo-interactions/';
  for (const [file, raw] of metadata) if (file.startsWith(`${geoRoot}contexts/`) && file.endsWith('/context.json')) {
    const parsed = parseGeoClientContextStructured(raw); if (!parsed.ok) throw error(file);
    const context = parsed.value;
    if (file.split('/').at(-2) !== context.contextId) throw error(file);
    const target = choose(file, context.contextId, (history) => messages(history).some((message) => message.role === 'user' && ids(message, 'geo').includes(context.contextId)));
    if (target) {
      files.set(scoped(target, file.slice('.tau/'.length)), context);
      const provenance = file.replace(/context\.json$/, 'provenance.json');
      if (metadata.has(provenance)) {
        const value = object(metadata.get(provenance), provenance), strategy = object(value.idStrategy, provenance);
        if (value.sourceKind !== 'resource' || typeof value.geoResourceId !== 'string' || !/^geo_[a-f0-9]{16,64}$/.test(value.geoResourceId) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0 || !['feature-id', 'id-field'].includes(String(strategy.kind)) || strategy.kind === 'id-field' && (typeof strategy.field !== 'string' || !strategy.field)) throw error(provenance);
        files.set(scoped(target, provenance.slice('.tau/'.length)), value);
      }
    }
  }
  const geoRefs = `${geoRoot}message-refs.json`;
  if (metadata.has(geoRefs)) {
    const value = object(metadata.get(geoRefs), geoRefs);
    if (value.version !== 1 || !Array.isArray(value.refs)) throw error(geoRefs);
    for (const [index, raw] of value.refs.entries()) {
      const ref = object(raw, geoRefs);
      if (typeof ref.text !== 'string' || !Array.isArray(ref.contextIds) || !ref.contextIds.every((id) => typeof id === 'string' && /^geoctx_[A-Za-z0-9_-]{12,64}$/.test(id))) throw error(geoRefs);
      const target = choose(geoRefs, `refs/${index}`, (history) => messages(history).some((message) => message.role === 'user' && visible(message) === ref.text && (ref.timestamp === undefined || String(message.timestamp) === String(ref.timestamp)) && (ref.contextIds as string[]).every((id) => ids(message, 'geo').includes(id))));
      if (target) (files.get(scoped(target, 'geo-interactions/message-refs.json')) as { refs: unknown[] }).refs.push(ref);
    }
  }
  for (const [file, raw] of metadata) if (file.startsWith(`${geoRoot}requests/`) && file.endsWith('/request.json')) {
    const request = parseGeoInteractionRequestStructured(raw); if (!request.ok) throw error(file);
    if (file.split('/').at(-2) !== request.value.requestId) throw error(file);
    const responseFile = file.replace(/request\.json$/, 'response.json'), response = metadata.has(responseFile) ? parseGeoInteractionResponseStructured(metadata.get(responseFile)) : null;
    if (response && !response.ok || response?.ok && response.value.requestId !== request.value.requestId) throw error(responseFile);
    const target = choose(file, request.value.requestId, (history) => messages(history).flatMap(geoResponses).some((native) => native.requestId === request.value.requestId && (!response?.ok || workspaceCreationDigest(native) === workspaceCreationDigest(response.value))) || !!(response?.ok && response.value.contextId && messages(history).some((message) => message.role === 'user' && ids(message, 'geo').includes(response.value.contextId!))));
    if (target) {
      files.set(scoped(target, file.slice('.tau/'.length)), request.value);
      files.set(scoped(target, responseFile.slice('.tau/'.length)), response?.ok ? response.value : Date.parse(request.value.expiresAt) <= Date.parse(preparedAt) ? { version: 1, requestId: request.value.requestId, status: 'expired', reason: 'timeout', completedAt: request.value.expiresAt } : { version: 1, requestId: request.value.requestId, status: 'aborted', reason: 'session_closed', completedAt: preparedAt });
    }
  }
  const timingFile = '.tau/timing-metrics.v1.json';
  if (metadata.has(timingFile)) {
    const value = object(metadata.get(timingFile), timingFile), records = object(value.records, timingFile);
    if (value.schemaVersion !== 1 || typeof value.updatedAt !== 'string') throw error(timingFile);
    for (const [key, raw] of Object.entries(records)) {
      const record = object(raw, timingFile);
      if (!['tool', 'thinking'].includes(String(record.kind)) || typeof record.sourceId !== 'string' || ![record.startedAt, record.endedAt, record.durationMs].every((number) => typeof number === 'number' && Number.isFinite(number) && number >= 0)) throw error(timingFile);
      if (Number(record.endedAt) < Number(record.startedAt) || record.kind === 'tool' && key !== `tool:${record.sourceId}` || record.kind === 'thinking' && key !== record.sourceId) throw error(timingFile);
      const target = choose(timingFile, key, (history) => {
        const items = messages(history), times = items.map(timestamp).filter(Number.isFinite);
        const range = times.reduce(([first, last], time) => [Math.min(first, time), Math.max(last, time)], [Infinity, -Infinity]);
        if (!times.length || Number(record.startedAt) < range[0] || Number(record.endedAt) > range[1]) return false;
        if (record.kind === 'tool') return items.some((message) => message.role === 'assistant' && timestamp(message) <= Number(record.startedAt) && Array.isArray(message.content) && message.content.some((part: JsonRecord) => part.type === 'toolCall' && part.id === record.sourceId)) && items.some((message) => message.role === 'toolResult' && message.toolCallId === record.sourceId && timestamp(message) >= Number(record.endedAt));
        return items.some((message) => message.role === 'assistant' && Array.isArray(message.content) && message.content.some((part: JsonRecord) => part.type === 'thinking') && key === (message.responseId ? `thinking:response:${message.responseId}` : `thinking:message:${crypto.createHash('sha256').update(JSON.stringify({ role: message.role, timestamp: message.timestamp, content: message.content })).digest('hex').slice(0, 24)}`));
      });
      if (target) { const index = files.get(scoped(target, 'timing-metrics.v1.json')) as { records: JsonRecord; updatedAt: string }; index.records[key] = record; index.updatedAt = value.updatedAt; }
    }
  }
  return { files: [...files].map(([relative, value]) => ({ relative, value })), sharedAttachments, issues, assignments };
}
