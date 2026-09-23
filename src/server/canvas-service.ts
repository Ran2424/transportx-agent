const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

import {
  CANVAS_PRESENTATION_PROTOCOL,
  CANVAS_PRESENTATION_VERSION,
  DOCUMENT_CANVAS_ADAPTER_ID,
  GEO_CANVAS_ADAPTER_ID,
  VIDEO_CANVAS_ADAPTER_ID,
  documentCanvasFormat,
  getCanvasPresentationFromToolResult,
  parseDocumentCanvasTarget,
  parseGeoCanvasTarget,
  parseGeoClientContextStructured,
  parseVideoCanvasTarget,
  parseVideoTimestamp,
  parseCanvasContext,
  stripCanvasContextPrompt,
  CANVAS_CONTEXT_PROTOCOL,
  CANVAS_CONTEXT_VERSION,
  type CanvasPresentationOperation,
  type CanvasPresentationV1,
  type CanvasResourceRef,
  type CanvasContextV1,
  type ResolvedSessionPlanV3,
} from '../contracts/index.js';
import type { CitationService } from './citation-service.js';
import { relativePosixPath } from './util/path.js';

type CanvasSession = {
  id: string;
  cwd: string;
  entries: Array<Record<string, unknown>>;
  resolvedSessionPlan: ResolvedSessionPlanV3 | null;
  citationRegistryId: string;
  activeCanvasContextIds?: string[];
};

type PresentInput = {
  adapterId?: unknown;
  operation?: unknown;
  resource?: unknown;
  target?: unknown;
  title?: unknown;
  viewId?: unknown;
};

type ResolveSessionPath = (session: CanvasSession, requestedPath?: string | null) => string;

function serviceError(message: string, status = 400) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function previousPresentation(session: CanvasSession, viewId: string): CanvasPresentationV1 | null {
  for (let index = session.entries.length - 1; index >= 0; index -= 1) {
    const entry = session.entries[index];
    const presentation = getCanvasPresentationFromToolResult(entry.message) || getCanvasPresentationFromToolResult(entry);
    if (presentation?.viewId === viewId) return presentation;
  }
  return null;
}

function requestedOperation(value: unknown, fallback: CanvasPresentationOperation): CanvasPresentationOperation {
  if (value === undefined) return fallback;
  if (value === 'present' || value === 'focus' || value === 'update' || value === 'clear') return value;
  throw serviceError('Unsupported Canvas operation.');
}

function stableViewId(adapterId: string, resource: CanvasResourceRef) {
  const identity = resource.scope === 'session-file'
    ? resource.path
    : resource.scope === 'citation'
      ? `${resource.resourceId}:${resource.sha256}`
      : `${resource.moduleId}:${resource.resourceId}`;
  return `${adapterId}:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

function validateTarget(adapterId: string, target: unknown) {
  if (target === undefined) return undefined;
  if (adapterId === DOCUMENT_CANVAS_ADAPTER_ID) return parseDocumentCanvasTarget(target);
  if (adapterId === GEO_CANVAS_ADAPTER_ID) return parseGeoCanvasTarget(target);
  if (adapterId === VIDEO_CANVAS_ADAPTER_ID) return parseVideoCanvasTarget(target);
  return null;
}

export class CanvasService {
  constructor(private readonly citation: CitationService, private readonly resolveSessionPath: ResolveSessionPath) {}

  present(session: CanvasSession, input: PresentInput): CanvasPresentationV1 {
    const requestedViewId = typeof input.viewId === 'string' ? input.viewId.trim() : '';
    if (!input.resource) {
      if (!requestedViewId) throw serviceError('resource or viewId is required.');
      const previous = previousPresentation(session, requestedViewId);
      if (!previous) throw serviceError('Canvas view was not found in this session.', 404);
      const declaration = session.resolvedSessionPlan?.modules.flatMap((module) => module.canvasViews).find((view) => view.adapterId === previous.adapterId);
      if (!declaration || declaration.protocolVersion !== CANVAS_PRESENTATION_VERSION) throw serviceError('Canvas adapter is not enabled for this session.', 403);
      const operation = requestedOperation(input.operation, 'focus');
      const rawTarget = input.target === undefined ? previous.target : input.target;
      const target = validateTarget(previous.adapterId, rawTarget);
      if (rawTarget !== undefined && !target) throw serviceError('Canvas target is invalid for this adapter.');
      return { ...previous, presentationId: crypto.randomUUID(), operation, ...(target !== undefined ? { target } : {}), generatedAt: new Date().toISOString() };
    }

    const adapterId = typeof input.adapterId === 'string' ? input.adapterId.trim() : '';
    if (!adapterId) throw serviceError('adapterId is required when presenting a resource.');
    const declaration = session.resolvedSessionPlan?.modules.flatMap((module) => module.canvasViews.map((view) => ({ ...view, moduleId: module.id }))).find((view) => view.adapterId === adapterId);
    if (!declaration || declaration.protocolVersion !== CANVAS_PRESENTATION_VERSION) throw serviceError('Canvas adapter is not enabled for this session.', 403);
    if (adapterId !== DOCUMENT_CANVAS_ADAPTER_ID || declaration.kind !== 'document') throw serviceError('canvas_present currently accepts new resources through the Document adapter only.');

    const resource = input.resource as Record<string, unknown>;
    let reference: CanvasResourceRef;
    let resourcePath: string;
    let mimeType: string | undefined;
    let revision = 0;
    if (resource.scope === 'session-file' && typeof resource.path === 'string') {
      const resolved = this.resolveSessionPath(session, resource.path);
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) throw serviceError('Canvas Session File resource must be a file.');
      resourcePath = relativePosixPath(fs.realpathSync(session.cwd), fs.realpathSync(resolved));
      if (!resourcePath || resourcePath.startsWith('../')) throw serviceError('Canvas resource is outside the active session directory.', 403);
      reference = { scope: 'session-file', path: resourcePath };
      revision = Math.floor(stat.mtimeMs);
    } else if (resource.scope === 'citation' && typeof resource.resourceId === 'string' && typeof resource.sha256 === 'string') {
      const registered = this.citation.registry(session).load().resources.find((candidate) => candidate.resourceId === resource.resourceId && candidate.sha256 === resource.sha256);
      if (!registered) throw serviceError('Citation resource or pinned version was not found.', 404);
      reference = { scope: 'citation', resourceId: registered.resourceId, sha256: registered.sha256 };
      resourcePath = registered.relativePath;
      mimeType = registered.mimeType;
    } else throw serviceError('Unsupported Canvas resource reference.');

    const format = documentCanvasFormat(resourcePath, mimeType);
    if (!format) throw serviceError('Document Canvas supports Markdown, PDF, CSV, DOCX, XLSX and PPTX resources.');
    const target = validateTarget(adapterId, input.target);
    if (input.target !== undefined && !target) throw serviceError('Document Canvas target is invalid.');
    const viewId = stableViewId(adapterId, reference);
    const previous = previousPresentation(session, viewId);
    revision = Math.max(revision, previous?.revision ?? 0);
    const operation = requestedOperation(input.operation, previous ? 'update' : 'present');
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 300) : path.basename(resourcePath);
    return {
      protocol: CANVAS_PRESENTATION_PROTOCOL,
      version: CANVAS_PRESENTATION_VERSION,
      presentationId: crypto.randomUUID(),
      adapterId,
      kind: declaration.kind,
      viewId,
      revision,
      operation,
      title,
      resources: [reference],
      payload: { format, path: resourcePath, ...(mimeType ? { mimeType } : {}) },
      ...(target ? { target } : {}),
      generatedAt: new Date().toISOString(),
    };
  }

  createContext(session: CanvasSession, input: { viewId?: unknown; revision?: unknown; target?: unknown; selection?: unknown }): CanvasContextV1 {
    const viewId = typeof input.viewId === 'string' ? input.viewId.trim() : '';
    const revision = Number.isInteger(input.revision) && (input.revision as number) >= 0 ? input.revision as number : null;
    if (!viewId || revision === null) throw serviceError('viewId and a non-negative revision are required.');
    const presentation = previousPresentation(session, viewId);
    if (!presentation || presentation.operation === 'clear') throw serviceError('Canvas view was not found in this session.', 404);
    if (presentation.revision !== revision) throw serviceError('Canvas view revision has changed.', 409);
    const target = input.target === undefined ? presentation.target : input.target;
    if (target !== undefined && !validateTarget(presentation.adapterId, target)) throw serviceError('Canvas target is invalid for this adapter.');
    if (presentation.adapterId === GEO_CANVAS_ADAPTER_ID && input.selection !== undefined && !parseGeoClientContextStructured(input.selection).ok) throw serviceError('Geo Canvas selection is invalid.');
    if (presentation.adapterId === VIDEO_CANVAS_ADAPTER_ID && target !== undefined) {
      const videoTarget = target && typeof target === 'object' && !Array.isArray(target) ? target as Record<string, unknown> : null;
      const valid = videoTarget?.kind === 'timestamp' && parseVideoTimestamp(videoTarget.at) && Object.keys(videoTarget).every((key) => key === 'kind' || key === 'at')
        || videoTarget?.kind === 'offset' && typeof videoTarget.seconds === 'number' && Number.isFinite(videoTarget.seconds) && videoTarget.seconds >= 0 && Object.keys(videoTarget).every((key) => key === 'kind' || key === 'seconds');
      if (!valid) throw serviceError('Video Canvas target is invalid.');
    }
    const context = parseCanvasContext({
      protocol: CANVAS_CONTEXT_PROTOCOL,
      version: CANVAS_CONTEXT_VERSION,
      contextId: `canvas_context_${crypto.randomUUID()}`,
      adapterId: presentation.adapterId,
      viewId,
      revision,
      resources: presentation.resources,
      ...(target !== undefined ? { target } : {}),
      ...(input.selection !== undefined ? { selection: input.selection } : {}),
      createdAt: new Date().toISOString(),
    });
    if (!context) throw serviceError('Canvas context is invalid or exceeds protocol limits.');
    const contexts = this.readContexts(session).filter((item) => item.contextId !== context.contextId);
    contexts.push(context);
    this.writeContexts(session, contexts.slice(-100));
    return context;
  }

  inspectContexts(session: CanvasSession, input: unknown): CanvasContextV1[] {
    const contexts = this.resolveContexts(session, input);
    const allowed = new Set(session.activeCanvasContextIds || []);
    if (contexts.some((context) => !allowed.has(context.contextId))) throw serviceError('Canvas context was not attached to the current user turn.', 403);
    return contexts;
  }

  private resolveContexts(session: CanvasSession, input: unknown): CanvasContextV1[] {
    if (!Array.isArray(input) || input.length < 1 || input.length > 20 || input.some((id) => typeof id !== 'string')) throw serviceError('contextIds must contain 1–20 Canvas context IDs.');
    const ids = [...new Set(input as string[])];
    const byId = new Map(this.readContexts(session).map((context) => [context.contextId, context]));
    return ids.map((id) => {
      const context = byId.get(id);
      if (!context) throw serviceError(`Canvas context not found: ${id}`, 404);
      return context;
    });
  }

  validateContextIds(session: CanvasSession, input: unknown): string[] {
    return this.resolveContexts(session, input).map((context) => context.contextId);
  }

  private contextFile(session: CanvasSession) {
    return path.join(session.cwd, '.tau', 'canvas-contexts.json');
  }

  private readContexts(session: CanvasSession): CanvasContextV1[] {
    try {
      const value = JSON.parse(fs.readFileSync(this.contextFile(session), 'utf8'));
      return Array.isArray(value) ? value.flatMap((item) => parseCanvasContext(item) ?? []) : [];
    } catch { return []; }
  }

  private writeContexts(session: CanvasSession, contexts: CanvasContextV1[]) {
    const file = this.contextFile(session);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(contexts, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
}

export function buildCanvasContextPrompt(contextIds: string[]) {
  return contextIds.length
    ? `\n\n[Canvas context]\nThe user explicitly attached Canvas context IDs: ${contextIds.join(', ')}. Call canvas_inspect_context with only these IDs before relying on page, slide, sheet, time, map view, or selection details. Do not inspect older Canvas contexts.\n[/Canvas context]`
    : '';
}

export function restoreCanvasContextMessage(entry: Record<string, unknown>) {
  const message = entry.message && typeof entry.message === 'object' ? entry.message as Record<string, unknown> : null;
  if (!message || message.role !== 'user' || message.canvasContextIds) return entry;
  const content = typeof message.content === 'string' ? message.content : null;
  if (!content) return entry;
  const match = content.match(/\[Canvas context\]\nThe user explicitly attached Canvas context IDs: ([^\n.]+)/);
  const canvasContextIds = match?.[1].split(',').map((id) => id.trim()).filter(Boolean);
  return canvasContextIds?.length ? { ...entry, message: { ...message, canvasContextIds, content: stripCanvasContextPrompt(content) } } : entry;
}
