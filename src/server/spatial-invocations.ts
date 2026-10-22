import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalToolSchema } from '../contracts/tool-interface.js';
import { parseSpatialAnalysisResultStructured, type SpatialAnalysisResultV1 } from '../contracts/index.js';
import { spatialOwner } from './spatial-owner.js';
import { readJsonObject, writeJsonAtomic } from './util/json-storage.js';
import { containedFile } from './util/resource-path.js';
import { sha256File } from './asset-integrity.js';
import type { PiRpcSession } from './sessions.js';
import type { SpatialAnalysisService } from './spatial-analysis-service.js';
import type { JsonRecord } from './types.js';
import { approvedHostToolContract } from './tool-request.js';

type RecordV1 = {
  schemaVersion: 1; operationId: string; owner: ReturnType<typeof spatialOwner>; toolCallId: string;
  requestHash: string; semanticVersion: string; state: 'prepared' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  request: { operation: string; inputs: JsonRecord[]; parameters: JsonRecord };
  createdAt: string; updatedAt: string; jobId?: string; error?: { code: string; message: string; commit: string }; result?: SpatialAnalysisResultV1;
};
const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (message: string, code: string, status = 409) => Object.assign(new Error(message), { code, status, phase: 'confirmation', commit: 'unknown' });

// Spatial L3 only. The Host already holds the user-data writer lease. The
// record confirms dispatch/commit; Pi JSONL remains the only tool history.
export class SpatialInvocations {
  private running = new Map<string, AbortController>();
  constructor(private root: string, private sessionsDir: string, private spatial: SpatialAnalysisService) {}

  private directory(session: PiRpcSession) { return path.join(this.root, digest(spatialOwner(session, this.sessionsDir))); }
  private file(session: PiRpcSession, operationId: string) {
    if (!/^spatial_[a-f0-9]{32}$/.test(operationId)) throw failure('Invalid Spatial operationId', 'spatial_operation_invalid', 400);
    return path.join(this.directory(session), `${operationId}.json`);
  }
  private save(session: PiRpcSession, record: RecordV1) {
    record.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.file(session, record.operationId), record);
  }
  private load(session: PiRpcSession, operationId: string): RecordV1 {
    let value: JsonRecord;
    try { value = readJsonObject(this.file(session, operationId)); }
    catch (error) { throw Object.assign(error as Error, { commit: 'unknown', phase: 'confirmation' }); }
    if (value.schemaVersion !== 1 || value.operationId !== operationId || digest(value.owner) !== digest(spatialOwner(session, this.sessionsDir))) throw failure('Spatial operation is unavailable to this owner', 'spatial_operation_unavailable', 404);
    return value as RecordV1;
  }
  private find(session: PiRpcSession, toolCallId: string) {
    let index: JsonRecord;
    try { index = readJsonObject(path.join(this.directory(session), `call_${digest(toolCallId)}.json`)); }
    catch (error) { throw Object.assign(error as Error, { commit: 'unknown', phase: 'confirmation' }); }
    if (!index.operationId) return undefined;
    const record = this.load(session, String(index.operationId));
    if (record.toolCallId !== toolCallId) throw failure('Spatial call association is corrupt', 'spatial_operation_conflict');
    return record;
  }
  prepare(session: PiRpcSession, body: JsonRecord): RecordV1 {
    const prepared = this.spatial.prepare(session, body);
    const request = { ...prepared, inputs: prepared.inputs.map(({ absolutePath: _absolutePath, ...input }) => input) };
    const semanticVersion = approvedHostToolContract('com.transportx.spatial-analysis').semanticVersion;
    const requestHash = digest([semanticVersion, canonicalToolSchema(request, 'data')]);
    const toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId : `legacy-${crypto.randomUUID()}`;
    const existing = body.operationId ? this.load(session, String(body.operationId)) : this.find(session, toolCallId);
    if (existing) {
      if (existing.requestHash !== requestHash || existing.semanticVersion !== semanticVersion) throw failure('This operationId belongs to different parameters or input versions', 'spatial_operation_conflict');
      return existing;
    }
    const now = new Date().toISOString();
    const record: RecordV1 = { schemaVersion: 1, operationId: `spatial_${crypto.randomBytes(16).toString('hex')}`, owner: spatialOwner(session, this.sessionsDir), toolCallId, request, requestHash, semanticVersion, state: 'prepared', createdAt: now, updatedAt: now };
    // This synchronous reserve precedes every await and domain dispatch. A
    // different call with similar parameters intentionally gets a new ID.
    this.save(session, record);
    writeJsonAtomic(path.join(this.directory(session), `call_${digest(toolCallId)}.json`), { schemaVersion: 1, operationId: record.operationId });
    return record;
  }
  query(session: PiRpcSession, reference: { operationId?: unknown; lookupToolCallId?: unknown }): RecordV1 {
    if (!!reference.operationId === !!reference.lookupToolCallId) throw failure('Supply exactly one existing operationId or lookupToolCallId', 'spatial_operation_invalid', 400);
    const record = reference.operationId ? this.load(session, String(reference.operationId)) : typeof reference.lookupToolCallId === 'string' && reference.lookupToolCallId.length <= 200 ? this.find(session, reference.lookupToolCallId) : undefined;
    if (!record) throw failure('No operation is confirmed for this owner. Absence is not proof that a legacy execution never ran.', 'spatial_operation_unavailable', 404);
    if (record.state === 'running' && this.running.has(record.operationId)) return record;
    if (record.state === 'running' || record.state === 'unknown' || record.state === 'succeeded') {
      try {
        const manifest = containedFile(session.cwd, path.join(session.cwd, '.tau/spatial-results', record.operationId, 'manifest.json'));
        const parsed = parseSpatialAnalysisResultStructured(JSON.parse(fs.readFileSync(manifest, 'utf8')));
        if (!parsed.ok || parsed.value.analysisId !== record.operationId || parsed.value.output.relativePath !== `analysis/spatial/${record.operationId}/result.geojson`) throw new Error('Unconfirmed manifest');
        if (canonicalToolSchema({ operation: parsed.value.operation, inputs: parsed.value.inputs, parameters: parsed.value.parameters }, 'data') !== canonicalToolSchema(record.request, 'data')) throw new Error('Manifest request differs');
        const output = containedFile(session.cwd, path.join(session.cwd, parsed.value.output.relativePath));
        if (fs.statSync(output).size > 100 * 1024 * 1024 || sha256File(output) !== parsed.value.output.sha256) throw new Error('Unconfirmed output');
        const geojson = JSON.parse(fs.readFileSync(output, 'utf8'));
        if (geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features) || geojson.features.length !== parsed.value.output.featureCount || geojson.features.length > 50_000) throw new Error('Unconfirmed GeoJSON');
        record.result = parsed.value;
        record.state = 'succeeded'; delete record.error;
      } catch { record.state = 'unknown'; delete record.result; }
      this.save(session, record);
    }
    return record;
  }
  cancel(session: PiRpcSession, reference: { operationId?: unknown; lookupToolCallId?: unknown }) {
    const record = this.query(session, reference);
    if (record.state === 'prepared') {
      record.state = 'cancelled';
      record.error = { code: 'spatial_cancelled', message: 'Cancelled before dispatch', commit: 'not_started' };
      this.save(session, record);
    }
    this.running.get(record.operationId)?.abort();
    // An abort request never claims the process has exited.
    return { ...record, cancellationRequested: record.state === 'running' };
  }
  async execute(session: PiRpcSession, body: JsonRecord, signal: AbortSignal, dispatch: (signal: AbortSignal, analysisId: string, onJob: (jobId: string) => void, request: RecordV1['request']) => Promise<SpatialAnalysisResultV1>) {
    let record = this.prepare(session, body);
    if (record.state !== 'prepared') {
      record = this.query(session, { operationId: record.operationId });
      if (record.state === 'succeeded' && record.result) return { result: record.result, operationId: record.operationId, reused: true };
      if ((record.state === 'failed' || record.state === 'cancelled') && record.error) throw Object.assign(new Error(record.error.message), { ...record.error, phase: 'confirmation', operationId: record.operationId });
      throw failure(`Spatial operation ${record.operationId} is ${record.state}; query it and preserve its outputs. Do not start a replacement automatically.`, 'spatial_result_unknown');
    }
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    record.state = 'running'; this.save(session, record);
    this.running.set(record.operationId, controller);
    try {
      const result = await dispatch(combined, record.operationId, (jobId) => { record.jobId = jobId; this.save(session, record); }, record.request);
      record.state = 'succeeded'; record.result = result; this.save(session, record);
      return { result, operationId: record.operationId, reused: false };
    } catch (error) {
      const problem = error as Error & { code?: string; commit?: string };
      record.state = problem.commit === 'not_started' || problem.commit === 'not_committed' ? combined.aborted ? 'cancelled' : 'failed' : 'unknown';
      record.error = { code: problem.code || 'spatial_result_unknown', message: problem.message.slice(0, 1500), commit: problem.commit || 'unknown' };
      this.save(session, record);
      throw Object.assign(problem, { operationId: record.operationId });
    } finally { this.running.delete(record.operationId); }
  }
}
