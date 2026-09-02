import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  GEO_CONTEXTS_PER_MESSAGE,
  GEO_CONTEXT_MAX_FEATURES,
  GEO_REQUEST_DEFAULT_TIMEOUT_SECONDS,
  buildGeoContextPrompt,
  getVisualizationFromToolResult,
  stripGeoContextPrompt,
  parseGeoClientContextStructured,
  parseGeoInteractionRequestStructured,
  parseGeoInteractionResponseStructured,
  type GeoClientContextV1,
  type GeoContextProvenanceV1,
  type GeoContextReferenceV1,
  type GeoInteractionRequestV1,
  type GeoInteractionResponseReason,
  type GeoInteractionResponseV1,
  type GeoInteractionTerminalStatus,
  type GeoJsonFeature,
  type VisualizationEnvelope,
} from '../contracts/geo.js';
import { stripAttachmentContext } from '../contracts/attachments.js';
import type { JsonRecord } from './types.js';
import { sha256File, within } from './asset-integrity.js';

const GEO_MODULE_ID = 'com.transportx.geo';

export type GeoInteractionSession = {
  id: string;
  cwd: string;
  entries: JsonRecord[];
  resolvedSessionPlan?: { modules?: Array<{ id?: string }> } | null;
  manager?: { broadcast(data: unknown): void; broadcastUpdated?(sessionId: string): void };
  activeGeoContextIds?: string[];
};

export type GeoMessageRef = { text: string; timestamp?: number | string; contextIds: string[] };

type StoredContext = { context: GeoClientContextV1; provenance?: GeoContextProvenanceV1 };
type Waiter = { sessionId: string; resolve(value: { response: GeoInteractionResponseV1; context?: GeoClientContextV1 }): void; timer: ReturnType<typeof setTimeout> };

function serviceError(message: string, status = 400, code?: string) {
  const error = new Error(message) as Error & { status?: number; code?: string };
  error.status = status;
  if (code) error.code = code;
  return error;
}

function interactionRoot(cwd: string) { return path.join(cwd, '.tau', 'geo-interactions'); }
function contextDir(cwd: string, contextId: string) { return path.join(interactionRoot(cwd), 'contexts', contextId); }
function requestDir(cwd: string, requestId: string) { return path.join(interactionRoot(cwd), 'requests', requestId); }
function refsPath(cwd: string) { return path.join(interactionRoot(cwd), 'message-refs.json'); }

function assertNoSymlink(target: string) {
  try { if (fs.lstatSync(target).isSymbolicLink()) throw serviceError('Geo interaction storage cannot use symbolic links.', 403); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
}

function ensureStoragePath(cwd: string, target: string) {
  const sessionRoot = path.resolve(cwd);
  const resolved = path.resolve(target);
  if (!within(sessionRoot, resolved)) throw serviceError('Geo interaction path escapes the session.', 403);
  assertNoSymlink(path.join(cwd, '.tau'));
  assertNoSymlink(interactionRoot(cwd));
  for (let cursor = path.dirname(resolved); cursor !== sessionRoot && within(sessionRoot, cursor); cursor = path.dirname(cursor)) assertNoSymlink(cursor);
  return resolved;
}

function writeJsonAtomic(cwd: string, target: string, value: unknown) {
  const resolved = ensureStoragePath(cwd, target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  assertNoSymlink(resolved);
  const temp = `${resolved}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, resolved);
}

function readJson<T>(cwd: string, target: string): T | null {
  try {
    const resolved = ensureStoragePath(cwd, target);
    const realSession = fs.realpathSync(cwd);
    const realTarget = fs.realpathSync(resolved);
    if (!within(realSession, realTarget) || !fs.statSync(realTarget).isFile()) throw serviceError('Geo interaction file is outside the session.', 403);
    return JSON.parse(fs.readFileSync(realTarget, 'utf8')) as T;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }
}

function randomId(prefix: 'geoctx_' | 'georeq_') { return `${prefix}${crypto.randomBytes(12).toString('hex')}`; }

function hasGeo(session: GeoInteractionSession) {
  return !!session.resolvedSessionPlan?.modules?.some((module) => module.id === GEO_MODULE_ID);
}

function requireGeo(session: GeoInteractionSession) {
  if (!hasGeo(session)) throw serviceError('Geo capability is unavailable for this session.', 409, 'geo_capability_unavailable');
}

function latestVisualization(session: GeoInteractionSession, visualizationId: string): VisualizationEnvelope | null {
  let latest: VisualizationEnvelope | null = null;
  for (const entry of session.entries) {
    const message = entry && typeof entry.message === 'object' && !Array.isArray(entry.message) ? entry.message : null;
    const envelope = getVisualizationFromToolResult(message);
    if (envelope?.visualizationId === visualizationId && (!latest || envelope.revision > latest.revision)) latest = envelope;
  }
  return latest;
}

function requireVisualization(session: GeoInteractionSession, visualizationId: string, revision: number) {
  const envelope = latestVisualization(session, visualizationId);
  if (!envelope?.scene) throw serviceError('Geo visualization is not available.', 409, 'geo_not_available');
  if (envelope.revision !== revision) throw serviceError('Geo scene revision changed.', 409, 'scene_revision_changed');
  return envelope;
}

function parseResource(session: GeoInteractionSession, resourceId: string) {
  const root = path.resolve(session.cwd, '.tau', 'geo-resources');
  const dir = path.resolve(root, resourceId);
  if (!within(root, dir)) throw serviceError('Geo resource is outside the session.', 403);
  const manifestPath = path.join(dir, 'manifest.json');
  const dataPath = path.join(dir, 'data.geojson');
  const realSession = fs.realpathSync(session.cwd);
  const realManifest = fs.realpathSync(manifestPath);
  const realData = fs.realpathSync(dataPath);
  if (!within(realSession, realManifest) || !within(realSession, realData)) throw serviceError('Geo resource path is not allowed.', 403);
  const manifest = JSON.parse(fs.readFileSync(realManifest, 'utf8')) as { resourceId?: unknown; sha256?: unknown; bytes?: unknown };
  const bytes = fs.statSync(realData).size;
  const sha256 = sha256File(realData);
  if (manifest.resourceId !== resourceId || manifest.sha256 !== sha256 || manifest.bytes !== bytes) throw serviceError('Geo resource integrity check failed.', 409, 'resource_changed');
  const data = JSON.parse(fs.readFileSync(realData, 'utf8')) as { type?: unknown; features?: unknown };
  if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw serviceError('Geo resource is not a FeatureCollection.', 409);
  return { manifest: { resourceId, sha256, bytes }, features: data.features as GeoJsonFeature[] };
}

function featureKey(value: string | number) { return `${typeof value}:${String(value)}`; }

function validateFeatureContext(session: GeoInteractionSession, context: GeoClientContextV1, envelope: VisualizationEnvelope): GeoContextProvenanceV1 {
  const selection = context.selection!;
  const layer = envelope.scene!.layers.find((item) => item.id === selection.layerId);
  if (!layer) throw serviceError('Selected Geo layer does not exist.', 409);
  const source = envelope.scene!.sources.find((item) => item.id === layer.sourceId);
  if (!source || source.type !== 'geojson-resource') throw serviceError('Feature Context requires resource-backed GeoJSON.', 409, 'unstable_feature_source');
  const { manifest, features } = parseResource(session, source.resourceId);
  const ids: Array<string | number> = [];
  for (const feature of features) {
    const raw = source.idField ? feature.properties?.[source.idField] : feature.id;
    if ((typeof raw !== 'string' && typeof raw !== 'number') || (typeof raw === 'string' && !raw) || (typeof raw === 'number' && !Number.isFinite(raw))) throw serviceError('Geo layer has no stable feature identity.', 409, 'unstable_feature_source');
    ids.push(raw);
  }
  const idSet = new Set(ids.map(featureKey));
  if (idSet.size !== ids.length) throw serviceError('Geo layer feature identities are not unique.', 409, 'unstable_feature_source');
  if (selection.featureIds.some((id) => !idSet.has(featureKey(id)))) throw serviceError('Selected feature does not exist in the verified resource.', 409);
  return {
    sourceKind: 'resource',
    geoResourceId: source.resourceId,
    sha256: manifest.sha256,
    bytes: manifest.bytes,
    idStrategy: source.idField ? { kind: 'id-field', field: source.idField } : { kind: 'feature-id' },
  };
}

function validateSelectableLayer(session: GeoInteractionSession, envelope: VisualizationEnvelope, layerId: string) {
  const layer = envelope.scene!.layers.find((item) => item.id === layerId);
  if (!layer) throw serviceError('Requested Geo layer does not exist.', 409);
  const source = envelope.scene!.sources.find((item) => item.id === layer.sourceId);
  if (!source || source.type !== 'geojson-resource') throw serviceError('Feature requests may target only resource-backed layers with stable ids.', 409, 'unstable_feature_source');
  const { features } = parseResource(session, source.resourceId);
  const ids = features.map((feature) => source.idField ? feature.properties?.[source.idField] : feature.id);
  if (ids.some((id) => (typeof id !== 'string' && typeof id !== 'number') || (typeof id === 'string' && !id) || (typeof id === 'number' && !Number.isFinite(id)))) throw serviceError('Geo layer has no stable feature identity.', 409, 'unstable_feature_source');
  if (new Set((ids as Array<string | number>).map(featureKey)).size !== ids.length) throw serviceError('Geo layer feature identities are not unique.', 409, 'unstable_feature_source');
}

function contextReference(sessionId: string, context: GeoClientContextV1): GeoContextReferenceV1 {
  return { contextId: context.contextId, sessionId, visualizationId: context.visualizationId, sceneRevision: context.sceneRevision, mode: context.mode, summary: context.summary, createdAt: context.createdAt };
}

function verifiedContextSummary(context: GeoClientContextV1) {
  if (context.mode === 'feature') return `${context.selection!.featureIds.length} selected feature(s) in layer ${context.selection!.layerId}`;
  if (context.mode === 'point' && context.geometry?.type === 'Point') return `WGS84 point ${context.geometry.coordinates[0]}, ${context.geometry.coordinates[1]}`;
  if (context.mode === 'rectangle' && context.geometry?.type === 'Polygon') {
    const ring = context.geometry.coordinates[0];
    return `WGS84 rectangle ${ring[0][0]}, ${ring[0][1]} to ${ring[2][0]}, ${ring[2][1]}`;
  }
  return `WGS84 viewport ${context.view.bounds.join(', ')}`;
}

function responseFor(requestId: string, status: GeoInteractionTerminalStatus, detail: { contextId?: string; reason?: GeoInteractionResponseReason } = {}): GeoInteractionResponseV1 {
  const candidate = { version: 1, requestId, status, ...detail, completedAt: new Date().toISOString() };
  const parsed = parseGeoInteractionResponseStructured(candidate);
  if (!parsed.ok) throw serviceError(parsed.diagnostics[0].message);
  return parsed.value;
}

export class GeoInteractionService {
  private waiters = new Map<string, Waiter>();

  available(session: GeoInteractionSession) { return hasGeo(session); }

  createContext(session: GeoInteractionSession, value: unknown): { reference: GeoContextReferenceV1; context: GeoClientContextV1; provenance?: GeoContextProvenanceV1 } {
    requireGeo(session);
    const parsed = parseGeoClientContextStructured(value);
    if (!parsed.ok) throw serviceError(parsed.diagnostics.map((item) => item.message).join('; '));
    const context = parsed.value;
    const envelope = requireVisualization(session, context.visualizationId, context.sceneRevision);
    const dir = contextDir(session.cwd, context.contextId);
    if (fs.existsSync(dir)) throw serviceError('Geo Context already exists and is immutable.', 409);
    const sceneLayerIds = new Set(envelope.scene!.layers.map((layer) => layer.id));
    if (context.visibleLayerIds.some((id) => !sceneLayerIds.has(id))) throw serviceError('visibleLayerIds contains a layer outside this scene.', 409);
    const provenance = context.mode === 'feature' ? validateFeatureContext(session, context, envelope) : undefined;
    writeJsonAtomic(session.cwd, path.join(dir, 'context.json'), context);
    if (provenance) writeJsonAtomic(session.cwd, path.join(dir, 'provenance.json'), provenance);
    session.manager?.broadcastUpdated?.(session.id);
    return { reference: contextReference(session.id, context), context, ...(provenance ? { provenance } : {}) };
  }

  getContext(session: GeoInteractionSession, contextId: string): StoredContext {
    requireGeo(session);
    if (!/^geoctx_[A-Za-z0-9_-]{12,64}$/.test(contextId)) throw serviceError('Invalid Geo Context id.', 400);
    const raw = readJson<unknown>(session.cwd, path.join(contextDir(session.cwd, contextId), 'context.json'));
    const parsed = parseGeoClientContextStructured(raw);
    if (!parsed.ok) throw serviceError(raw ? 'Stored Geo Context is invalid.' : 'Geo Context not found.', raw ? 409 : 404);
    const provenance = readJson<GeoContextProvenanceV1>(session.cwd, path.join(contextDir(session.cwd, contextId), 'provenance.json')) || undefined;
    return { context: parsed.value, ...(provenance ? { provenance } : {}) };
  }

  validateMessageContexts(session: GeoInteractionSession, ids: unknown): string[] {
    requireGeo(session);
    if (!Array.isArray(ids) || ids.length > GEO_CONTEXTS_PER_MESSAGE || ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) throw serviceError(`A message may reference at most ${GEO_CONTEXTS_PER_MESSAGE} unique Geo Contexts.`);
    for (const id of ids as string[]) this.getContext(session, id);
    return ids as string[];
  }

  setActiveMessageContexts(session: GeoInteractionSession, ids: string[]) {
    session.activeGeoContextIds = [...ids];
  }

  recordMessageRefs(session: GeoInteractionSession, ref: GeoMessageRef) {
    if (!ref.contextIds.length) return;
    const refs = this.readMessageRefs(session.cwd);
    const key = `${ref.timestamp ?? ''}\n${ref.text}`;
    const index = refs.findIndex((item) => `${item.timestamp ?? ''}\n${item.text}` === key);
    if (index >= 0) refs[index] = ref; else refs.push(ref);
    writeJsonAtomic(session.cwd, refsPath(session.cwd), { version: 1, refs });
  }

  readMessageRefs(cwd: string): GeoMessageRef[] {
    const value = readJson<{ version?: unknown; refs?: unknown }>(cwd, refsPath(cwd));
    if (!value || value.version !== 1 || !Array.isArray(value.refs)) return [];
    return value.refs.filter((item): item is GeoMessageRef => !!item && typeof item === 'object' && typeof item.text === 'string' && Array.isArray(item.contextIds));
  }

  async request(session: GeoInteractionSession, value: JsonRecord) {
    requireGeo(session);
    const visualizationId = typeof value.visualizationId === 'string' ? value.visualizationId : '';
    const revision = typeof value.sceneRevision === 'number' ? value.sceneRevision : 0;
    const envelope = requireVisualization(session, visualizationId, revision);
    const waiting = this.waitingRequest(session);
    if (waiting) throw serviceError('This session already has a waiting Geo request.', 409, 'geo_request_already_waiting');
    const mode = value.mode;
    if (!['feature', 'point', 'rectangle', 'viewport'].includes(String(mode))) throw serviceError('Unknown Geo input mode.');
    const targetLayerIds = value.targetLayerIds;
    if (mode === 'feature') {
      const candidates = Array.isArray(targetLayerIds) && targetLayerIds.length
        ? targetLayerIds
        : envelope.scene!.layers.filter((layer) => envelope.scene!.sources.some((source) => source.id === layer.sourceId && source.type === 'geojson-resource')).map((layer) => layer.id);
      if (!candidates.length) throw serviceError('This map has no selectable feature layers.', 409, 'unstable_feature_source');
      for (const layerId of candidates) validateSelectableLayer(session, envelope, String(layerId));
    }
    const now = new Date();
    const timeoutSeconds = value.timeoutSeconds === undefined ? GEO_REQUEST_DEFAULT_TIMEOUT_SECONDS : value.timeoutSeconds;
    const candidate = {
      version: 1,
      requestId: randomId('georeq_'),
      sessionId: session.id,
      visualizationId,
      sceneRevision: revision,
      mode,
      prompt: value.prompt,
      required: value.required === true,
      ...(value.targetLayerIds === undefined ? {} : { targetLayerIds: value.targetLayerIds }),
      ...(value.maxFeatures === undefined ? {} : { maxFeatures: value.maxFeatures }),
      timeoutSeconds,
      status: 'waiting',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + Number(timeoutSeconds) * 1000).toISOString(),
    };
    const parsed = parseGeoInteractionRequestStructured(candidate);
    if (!parsed.ok) throw serviceError(parsed.diagnostics.map((item) => item.message).join('; '));
    const request = parsed.value;
    writeJsonAtomic(session.cwd, path.join(requestDir(session.cwd, request.requestId), 'request.json'), request);
    session.manager?.broadcast({ type: 'geo_interaction_updated', sessionId: session.id, request });
    return new Promise<{ response: GeoInteractionResponseV1; context?: GeoClientContextV1 }>((resolve) => {
      const timer = setTimeout(() => { void this.finish(session, request, responseFor(request.requestId, 'expired', { reason: 'timeout' })); }, request.timeoutSeconds * 1000);
      this.waiters.set(request.requestId, { sessionId: session.id, resolve, timer });
    });
  }

  waitingRequest(session: GeoInteractionSession): GeoInteractionRequestV1 | null {
    if (!hasGeo(session)) return null;
    const root = path.join(interactionRoot(session.cwd), 'requests');
    if (!fs.existsSync(root)) return null;
    let waiting: GeoInteractionRequestV1 | null = null;
    for (const name of fs.readdirSync(root)) {
      const response = readJson<unknown>(session.cwd, path.join(root, name, 'response.json'));
      if (response) continue;
      const parsed = parseGeoInteractionRequestStructured(readJson<unknown>(session.cwd, path.join(root, name, 'request.json')));
      if (parsed.ok && (!waiting || parsed.value.createdAt > waiting.createdAt)) waiting = parsed.value;
    }
    if (waiting && Date.parse(waiting.expiresAt) <= Date.now()) {
      void this.finish(session, waiting, responseFor(waiting.requestId, 'expired', { reason: 'timeout' }));
      return null;
    }
    return waiting;
  }

  async respond(session: GeoInteractionSession, requestId: string, value: JsonRecord) {
    requireGeo(session);
    const dir = requestDir(session.cwd, requestId);
    const existing = readJson<unknown>(session.cwd, path.join(dir, 'response.json'));
    if (existing) {
      const parsed = parseGeoInteractionResponseStructured(existing);
      if (!parsed.ok) throw serviceError('Stored Geo response is invalid.', 409);
      return { response: parsed.value, ...(parsed.value.contextId ? { context: this.getContext(session, parsed.value.contextId).context } : {}) };
    }
    const parsedRequest = parseGeoInteractionRequestStructured(readJson<unknown>(session.cwd, path.join(dir, 'request.json')));
    if (!parsedRequest.ok) throw serviceError('Waiting Geo request not found.', 404);
    const request = parsedRequest.value;
    let response: GeoInteractionResponseV1;
    let context: GeoClientContextV1 | undefined;
    if (value.status === 'submitted') {
      const submitted = parseGeoClientContextStructured(value.context);
      if (!submitted.ok) throw serviceError(submitted.diagnostics.map((item) => item.message).join('; '));
      context = submitted.value;
      if (context.mode !== request.mode || context.visualizationId !== request.visualizationId || context.sceneRevision !== request.sceneRevision) throw serviceError('Submitted Context does not match the waiting request.', 409);
      if (request.targetLayerIds && (!context.selection || !request.targetLayerIds.includes(context.selection.layerId))) throw serviceError('Submitted feature layer is outside the request target.', 409);
      if (request.maxFeatures && (context.selection?.featureIds.length || 0) > request.maxFeatures) throw serviceError('Submitted feature count exceeds the request limit.', 409);
      try {
        const created = this.createContext(session, value.context);
        context = created.context;
        response = responseFor(requestId, 'submitted', { contextId: context.contextId });
      } catch (cause) {
        if ((cause as Error & { code?: string }).code !== 'resource_changed') throw cause;
        return this.finish(session, request, responseFor(requestId, 'invalidated', { reason: 'resource_changed' }));
      }
    } else if (value.status === 'cancelled') {
      response = responseFor(requestId, 'cancelled', { reason: 'user_cancelled' });
    } else if (value.status === 'invalidated' && ['scene_revision_changed', 'visualization_changed', 'resource_changed'].includes(String(value.reason))) {
      response = responseFor(requestId, 'invalidated', { reason: value.reason as GeoInteractionResponseReason });
    } else {
      throw serviceError('Browser may only submit, cancel, or invalidate a Geo request.');
    }
    return this.finish(session, request, response, context);
  }

  inspect(session: GeoInteractionSession, value: JsonRecord) {
    requireGeo(session);
    const explicit = value.contextIds !== undefined;
    const ids = explicit ? this.validateMessageContexts(session, value.contextIds) : [...(session.activeGeoContextIds || [])];
    if (!ids.length) return { status: 'no_geo_context' as const };
    const maxFeatures = value.maxFeatures === undefined ? GEO_CONTEXT_MAX_FEATURES : Number(value.maxFeatures);
    if (!Number.isInteger(maxFeatures) || maxFeatures < 1 || maxFeatures > GEO_CONTEXT_MAX_FEATURES) throw serviceError(`maxFeatures must be 1-${GEO_CONTEXT_MAX_FEATURES}.`);
    const includeProvenance = value.includeProvenance === true;
    const contexts = ids.map((id) => {
      const stored = this.getContext(session, id);
      const item: JsonRecord = { ...stored.context, summary: verifiedContextSummary(stored.context) };
      if (includeProvenance && stored.provenance) item.provenance = stored.provenance;
      if (stored.context.mode === 'feature' && stored.provenance) {
        const envelope = latestVisualization(session, stored.context.visualizationId);
        const layer = envelope?.scene?.layers.find((entry) => entry.id === stored.context.selection!.layerId);
        const source = envelope?.scene?.sources.find((entry) => entry.id === layer?.sourceId);
        const resource = source?.type === 'geojson-resource' ? parseResource(session, source.resourceId) : null;
        const propertyFields = layer?.popup?.fields.map((field) => field.field) || [];
        const selected = new Set(stored.context.selection!.featureIds.map(featureKey));
        const features = resource?.features.filter((feature) => {
          const raw = stored.provenance!.idStrategy.kind === 'id-field' ? feature.properties?.[stored.provenance!.idStrategy.field] : feature.id;
          return (typeof raw === 'string' || typeof raw === 'number') && selected.has(featureKey(raw));
        }) || [];
        item.features = features.slice(0, maxFeatures).map((feature) => {
          const id = stored.provenance!.idStrategy.kind === 'id-field' ? feature.properties?.[stored.provenance!.idStrategy.field] : feature.id;
          return { id, properties: Object.fromEntries(propertyFields.filter((field) => feature.properties && field in feature.properties).map((field) => [field, feature.properties![field]])) };
        });
        item.truncation = { total: features.length, returned: Math.min(features.length, maxFeatures), truncated: features.length > maxFeatures };
      }
      return item;
    });
    return { status: 'ok' as const, source: explicit ? 'explicit' as const : 'active_prompt' as const, contexts };
  }

  snapshot(session: GeoInteractionSession) {
    if (!hasGeo(session)) return undefined;
    const waitingRequest = this.waitingRequest(session);
    const contextsRoot = path.join(interactionRoot(session.cwd), 'contexts');
    const contextCount = fs.existsSync(contextsRoot) ? fs.readdirSync(contextsRoot).length : 0;
    return waitingRequest || contextCount ? { contextCount, ...(waitingRequest ? { waitingRequest } : {}) } : undefined;
  }

  abortSession(session: GeoInteractionSession, reason: 'session_closed' | 'agent_aborted' = 'session_closed') {
    const request = this.waitingRequest(session);
    if (request) void this.finish(session, request, responseFor(request.requestId, 'aborted', { reason }));
    session.activeGeoContextIds = [];
  }

  invalidateForEnvelope(session: GeoInteractionSession, envelope: VisualizationEnvelope) {
    const request = this.waitingRequest(session);
    if (request?.visualizationId === envelope.visualizationId && request.sceneRevision !== envelope.revision) {
      void this.finish(session, request, responseFor(request.requestId, 'invalidated', { reason: envelope.scene ? 'scene_revision_changed' : 'visualization_changed' }));
    }
  }

  private finish(session: GeoInteractionSession, request: GeoInteractionRequestV1, response: GeoInteractionResponseV1, context?: GeoClientContextV1) {
    const target = path.join(requestDir(session.cwd, request.requestId), 'response.json');
    const existing = readJson<unknown>(session.cwd, target);
    if (existing) {
      const parsed = parseGeoInteractionResponseStructured(existing);
      if (!parsed.ok) throw serviceError('Stored Geo response is invalid.', 409);
      return { response: parsed.value, ...(parsed.value.contextId ? { context: this.getContext(session, parsed.value.contextId).context } : {}) };
    }
    writeJsonAtomic(session.cwd, target, response);
    const result = { response, ...(context ? { context } : {}) };
    const waiter = this.waiters.get(request.requestId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(request.requestId);
      waiter.resolve(result);
    }
    session.manager?.broadcast({ type: 'geo_interaction_updated', sessionId: session.id, response });
    session.manager?.broadcastUpdated?.(session.id);
    return result;
  }
}

export const geoInteractionService = new GeoInteractionService();

export const buildGeoPromptContext = buildGeoContextPrompt;

export function applyGeoMessageRefs(entries: JsonRecord[], refs: GeoMessageRef[]) {
  const byTimestamp = new Map<string, GeoMessageRef[]>();
  for (const ref of refs) {
    if (ref.timestamp === undefined) continue;
    const key = String(ref.timestamp);
    byTimestamp.set(key, [...(byTimestamp.get(key) || []), ref]);
  }
  return entries.map((entry) => {
    const message = entry && typeof entry.message === 'object' && !Array.isArray(entry.message) ? entry.message as JsonRecord : null;
    if (!message || message.role !== 'user' || message.geoContextIds) return entry;
    const candidates = message.timestamp !== undefined ? byTimestamp.get(String(message.timestamp)) || [] : [];
    const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter((block) => block?.type === 'text').map((block) => block.text || '').join('\n') : '';
    const normalizedText = stripGeoContextPrompt(stripAttachmentContext(text));
    const contextIds = candidates.find((ref) => normalizedText === ref.text)?.contextIds;
    return contextIds?.length ? { ...entry, message: { ...message, geoContextIds: contextIds } } : entry;
  });
}
