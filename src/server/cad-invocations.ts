import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalToolSchema } from '../contracts/tool-interface.js';
import type { CadDrawRequestV1, CadDrawResultV1 } from '../contracts/cad.js';
import type { PiRpcSession } from './sessions.js';
import type { CadService } from './cad-service.js';
import { executionOwner } from './util/execution-owner.js';
import { readJsonObject, writeJsonAtomic } from './util/json-storage.js';
import { containedFile } from './util/resource-path.js';

type RecordV1 = {
  schemaVersion: 1; operationId: string; owner: ReturnType<typeof executionOwner>; toolCallId: string;
  requestHash: string; request: CadDrawRequestV1; inputSha256: string;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  result?: CadDrawResultV1; error?: { code: string; message: string; commit: string };
};
const digest = (value: unknown) => crypto.createHash('sha256').update(canonicalToolSchema(value, 'data')).digest('hex');
const failure = (message: string, code = 'cad_result_unknown', commit = 'unknown') => Object.assign(new Error(message), { code, commit, phase: 'confirmation', status: 409 });

// CAD domain confirmation only; Pi JSONL remains the tool history and Job /
// PythonRunner remain the execution mechanism. No automatic retries.
export class CadInvocations {
  private running = new Map<string, AbortController>();
  constructor(private root: string, private sessionsDir: string, private cad: CadService) {}
  private directory(session: PiRpcSession) { return path.join(this.root, digest(executionOwner(session, this.sessionsDir))); }
  private file(session: PiRpcSession, operationId: string) {
    if (!/^cad_[a-f0-9]{32}$/.test(operationId)) throw failure('Invalid CAD operation ID.');
    return path.join(this.directory(session), `${operationId}.json`);
  }
  private save(session: PiRpcSession, record: RecordV1) { writeJsonAtomic(this.file(session, record.operationId), record); }
  private load(session: PiRpcSession, operationId: string): RecordV1 {
    const file = this.file(session, operationId);
    const value = readJsonObject(containedFile(this.root, file));
    if (value.schemaVersion !== 1 || value.operationId !== operationId || digest(value.owner) !== digest(executionOwner(session, this.sessionsDir))) throw failure('CAD operation is unavailable to this task.');
    return value as RecordV1;
  }
  private find(session: PiRpcSession, toolCallId: string) {
    const file = path.join(this.directory(session), `call_${digest(toolCallId)}.json`);
    if (!fs.existsSync(file)) return undefined;
    const index = readJsonObject(containedFile(this.root, file));
    const record = this.load(session, String(index.operationId));
    if (record.toolCallId !== toolCallId) throw failure('CAD call association differs.');
    return record;
  }
  query(session: PiRpcSession, reference: { operationId?: unknown; lookupToolCallId?: unknown }): RecordV1 {
    if (!!reference.operationId === !!reference.lookupToolCallId) throw failure('Supply exactly one operationId or lookupToolCallId.', 'cad.invalid_request', 'not_started');
    const record = reference.operationId ? this.load(session, String(reference.operationId)) : typeof reference.lookupToolCallId === 'string' ? this.find(session, reference.lookupToolCallId) : undefined;
    if (!record) throw failure('No CAD execution is confirmed. Absence does not prove non-execution.');
    if (record.state === 'running' && this.running.has(record.operationId)) return record;
    if (record.result?.ok && (record.state === 'succeeded' || record.state === 'unknown')) {
      try { if (!record.result.dryRun) record.result = this.cad.verifyCommitted(session, record.result); record.state = 'succeeded'; }
      catch { record.state = 'unknown'; }
    } else if (record.state === 'running' || record.state === 'unknown') {
      try {
        const recovered = this.cad.recover(session, record.operationId, record.request);
        record.state = recovered.state;
        if (recovered.state === 'succeeded') { record.result = recovered.result; delete record.error; }
        if (recovered.state === 'failed') record.error = { code: 'cad_not_committed', message: 'Interrupted CAD commit was rolled back to its parent manifest.', commit: 'not_committed' };
      } catch { record.state = 'unknown'; }
    }
    this.save(session, record);
    if (record.state === 'succeeded') this.cad.finalize(session, record.operationId);
    return record;
  }
  cancel(session: PiRpcSession, reference: { operationId?: unknown; lookupToolCallId?: unknown }) {
    const record = this.query(session, reference);
    this.running.get(record.operationId)?.abort();
    return { ...record, cancellationRequested: record.state === 'running' };
  }
  async execute(session: PiRpcSession, body: Record<string, unknown>, signal: AbortSignal, dispatch: (signal: AbortSignal, record: RecordV1) => Promise<CadDrawResultV1>) {
    const { sessionId: _sessionId, token: _token, toolCallId, contractVersion, ...input } = body;
    if (typeof toolCallId !== 'string' || !toolCallId || toolCallId.length > 200) throw failure('CAD writes require a toolCallId.', 'cad.invalid_request', 'not_started');
    const requestHash = digest({ contractVersion, input });
    let record = this.find(session, toolCallId);
    if (record) {
      if (record.requestHash !== requestHash) throw failure('CAD call was already associated with different parameters.', 'cad_operation_conflict');
      record = this.query(session, { operationId: record.operationId });
      if (record.state === 'succeeded' && record.result) return { result: record.result, operationId: record.operationId, reused: true };
      throw failure(`CAD execution is ${record.state}; query it instead of repeating the drawing.`, record.error?.code, record.error?.commit);
    }
    let prepared: ReturnType<CadService['prepare']>;
    try { prepared = this.cad.prepare(session, input); }
    catch (error) { throw Object.assign(error as Error, { commit: 'not_started', phase: 'validation' }); }
    const controller = new AbortController();
    record = { schemaVersion: 1, operationId: `cad_${crypto.randomBytes(16).toString('hex')}`, owner: executionOwner(session, this.sessionsDir), toolCallId, requestHash, ...prepared, state: 'running' };
    this.save(session, record);
    writeJsonAtomic(path.join(this.directory(session), `call_${digest(toolCallId)}.json`), { operationId: record.operationId });
    this.running.set(record.operationId, controller);
    try {
      const result = await dispatch(AbortSignal.any([signal, controller.signal]), record);
      record.state = result.ok ? 'succeeded' : 'failed'; record.result = result;
      if (!result.ok) record.error = { code: 'cad_draw_failed', message: result.diagnostics.map((item) => item.message).join('; '), commit: 'not_committed' };
      this.save(session, record);
      this.cad.finalize(session, record.operationId);
      return { result, operationId: record.operationId, reused: false };
    } catch (error) {
      const problem = error as Error & { code?: string; commit?: string };
      record.state = ['not_started', 'not_committed'].includes(problem.commit || '') ? signal.aborted || controller.signal.aborted ? 'cancelled' : 'failed' : 'unknown';
      record.error = { code: problem.code || 'cad_result_unknown', message: problem.message.slice(0, 1500), commit: problem.commit || 'unknown' };
      this.save(session, record);
      throw Object.assign(problem, { operationId: record.operationId });
    } finally { this.running.delete(record.operationId); }
  }
}
