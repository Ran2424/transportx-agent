import fs from 'node:fs';
import type { HandoffInput } from '../contracts/workspace-handoff-schema.mjs' with { 'resolution-mode': 'import' };
import type { ReviewTarget, CheckedPlan } from '../contracts/workspace-handoff.js';
import { callExperienceMcp, experienceConfig } from './experience-exchange.js';
import { syncDataResolution, type DataResolutionReceipt, type DataResolutionRequest } from './data-review-sync.js';
import {
  getIntent, handoffError, handoffHash, handoffPath, readHandoffFile,
  type Candidate, type HandoffSession, type Intent,
} from './workspace-handoff.js';

type Execution = { intentId: string; runId: string; planDigest: string; matchedRows: number; sampleRows?: number };
type Rejection = { intentId: string; code: string; at: string };
type Review = {
  id: string; target: ReviewTarget; status: 'pending' | 'routed' | 'resolution_pending' | 'resolved';
  intentId: string; evidenceRef: string; reason: string; url?: string;
  candidate?: Candidate; remoteId?: string; remoteStatus?: string;
  recommendedTarget?: ReviewTarget;
  resolution?: { intentId: string; runId: string; planDigest: string; definition: Intent['definition']; releaseId?: string; reason: string };
  dataSync?: { request: DataResolutionRequest; receipt?: DataResolutionReceipt; lastError?: string };
};

const executionPath = (session: HandoffSession, intentId: string) => handoffPath(session, 'table-handoff-results', intentId);
const rejectionPath = (session: HandoffSession, intentId: string) => handoffPath(session, 'table-handoff-rejections', intentId);
const reviewPath = (session: HandoffSession, reviewId: string) => handoffPath(session, 'table-handoff-reviews', reviewId);

function writeRecord(file: string, value: object) {
  const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export function recordHandoffExecution(session: HandoffSession,
  result: { runId: string; matchedRows: number; sampleRows?: number; truncated: boolean; unmatchedFilters?: unknown[]; provenance: { plan: object; handoff?: CheckedPlan } }) {
  const check = result.provenance.handoff;
  if (!check || check.role === 'support' || result.unmatchedFilters?.length || result.truncated) return;
  const key = check.role === 'time' ? check.intentId + '-' + check.timeRole : check.intentId;
  writeRecord(executionPath(session, key), {
    intentId: check.intentId, runId: result.runId, planDigest: check.planDigest,
    matchedRows: result.matchedRows, sampleRows: result.sampleRows,
  } satisfies Execution);
}

export function recordHandoffRejection(session: HandoffSession, turnId: unknown, intentId: unknown, error: unknown) {
  if (!intentId || !error || typeof error !== 'object' || !('code' in error) ||
      !['table_scope_missing','table_scope_conflict','table_method_mismatch','table_time_role_mismatch'].includes(String(error.code))) return;
  const intent = getIntent(session, intentId);
  if (intent.turnId !== turnId) return;
  writeRecord(rejectionPath(session, intent.id), {
    intentId: intent.id, code: String(error.code), at: new Date().toISOString(),
  } satisfies Rejection);
}

function reviewLink(intent: Intent, target: ReviewTarget, candidate?: Candidate, reviewId?: string) {
  if (target === 'agent') return;
  const url = new URL(target === 'data' ? '/data-studio' : '/tupu-studio', experienceConfig().url.origin);
  const params: Record<string, string> = target === 'data'
    ? { m: 'sources', scene: intent.definition.scope, snapshot: intent.definition.snapshot_id, panel: 'definition', focus: String(intent.definition.revision) }
    : { m: 'collections', scene: intent.definition.scope, q: candidate!.collection_id, focus: String(candidate!.revision) };
  url.hash = 'studio&' + new URLSearchParams({ ...params, ...(reviewId ? { run: reviewId } : {}) }).toString();
  return url.toString();
}

export async function routeHandoffReview(session: HandoffSession, input: HandoffInput, signal?: AbortSignal) {
  const intent = getIntent(session, input.intentId);
  const execution = readHandoffFile<Execution>(executionPath(session, intent.id));
  const rejection = readHandoffFile<Rejection>(rejectionPath(session, intent.id));
  const recommendedTarget = rejection ? 'agent' as const : undefined;
  const target = input.target ?? recommendedTarget;
  const reason = input.reason?.trim();
  if (!target || !reason || (!execution && !rejection))
    throw handoffError('Review needs an executed or blocked intent, a target Studio and an observed issue.');
  const candidate = intent.decisions.find(item => item.candidate.release_id === input.releaseId)?.candidate;
  if (target === 'knowledge' && !candidate) throw handoffError('Select an exact rule release from this intent.');
  const id = 'review_' + handoffHash(intent.id + '\0' + target + '\0' + (candidate?.release_id ?? '') + '\0' + reason);
  const file = reviewPath(session, id);
  const previous = readHandoffFile<Review>(file);
  if (previous && previous.status !== 'pending') return previous;
  const evidenceRef = previous?.evidenceRef ||
    ['conversation', session.conversationId, 'intent', intent.id, execution?.runId ?? rejection!.code].join(':');
  const record: Review = { id, target, recommendedTarget, status: 'pending', intentId: intent.id, evidenceRef, reason, candidate,
    url: reviewLink(intent, target, candidate) };
  if (!previous) writeRecord(file, record);
  if (target === 'data') {
    const reply = await callExperienceMcp('submit_data_review', {
      submission_id: id, run_id: intent.id, evidence_ref: evidenceRef,
      snapshot_id: intent.definition.snapshot_id, definition_revision: intent.definition.revision,
      definition_digest: intent.definition.digest, reason,
    }, signal);
    if (typeof reply.review_id !== 'string' || (reply.shared_review_id !== undefined && reply.shared_review_id !== id) ||
        !['pending', 'resolved'].includes(String(reply.status)))
      throw handoffError('Data Studio did not confirm the review receipt.');
    record.remoteId = reply.review_id;
    record.remoteStatus = String(reply.status);
  }
  if (target === 'knowledge' && candidate) {
    const { release_id, entry_id, collection_id, revision, digest } = candidate;
    const reference = { release_id, entry_id, collection_id, revision, digest };
    const reply = await callExperienceMcp('submit_experience_feedback', {
      submission_id: id, run_id: intent.id, evidence_ref: evidenceRef,
      question: intent.title.slice(0, 2000), initial_interpretation: 'Review of ' + intent.operation + ' using ' + intent.sampleBasis,
      correction: reason, experience: reference, data_refs: [intent.definition.snapshot_id],
    }, signal);
    if (typeof reply.feedback_id !== 'string') throw handoffError('Graph Studio did not confirm the review receipt.');
    record.remoteId = reply.feedback_id;
    record.remoteStatus = typeof reply.status === 'string' ? reply.status : 'received';
  }
  const latest = readHandoffFile<Review>(file);
  if (latest && latest.status !== 'pending') return latest;
  record.status = 'routed';
  record.url = reviewLink(intent, target, candidate, target === 'data' ? id : record.remoteId);
  writeRecord(file, record);
  return record;
}

export function inspectHandoffReview(session: HandoffSession, reviewId: unknown) {
  if (typeof reviewId !== 'string' || !/^review_[a-f0-9]{64}$/.test(reviewId))
    throw handoffError('A valid review ID is required.');
  const file = reviewPath(session, reviewId);
  const review = readHandoffFile<Review>(file);
  if (!review || review.id !== reviewId) throw handoffError('This review is unavailable in the conversation.');
  // Previous releases could close locally before the Data Studio receipt existed.
  if (review.target === 'data' && review.status === 'resolved' && !review.dataSync?.receipt) {
    review.status = 'resolution_pending';
    review.remoteStatus = 'unconfirmed';
  }
  return { file, review };
}

function checkReplacementScope(old: Intent, replacement: Intent) {
  const expected = old.filters.map(filter => {
    const labels = old.userAnchors.filter(anchor => anchor.column === filter.column).map(anchor => anchor.label);
    if (!labels.length) return filter;
    const aliases = replacement.fields.find(field => field.column === filter.column)?.aliases ?? [];
    const values = labels.map(label => aliases.find(alias => alias.label === label)?.value);
    if (values.some(value => value === undefined) || new Set(values).size !== 1)
      throw handoffError('The new definition does not settle the original review scope.');
    return { column: filter.column, value: values[0] };
  });
  if (expected.length !== replacement.filters.length ||
      expected.some(filter => !replacement.filters.some(other => other.column === filter.column && other.value === filter.value)))
    throw handoffError('The rerun does not match the original review scope under the new definition.');
}

function validateRerun(session: HandoffSession, review: Review, input: HandoffInput & { reason: string }) {
  const old = getIntent(session, review.intentId), replacement = getIntent(session, input.intentId);
  const execution = readHandoffFile<Execution>(executionPath(session, replacement.id));
  if (!execution || replacement.id === old.id || replacement.definition.snapshot_id !== old.definition.snapshot_id ||
      replacement.definition.scope !== old.definition.scope || replacement.csvSha !== old.csvSha)
    throw handoffError('A new executed intent against the same snapshot is required.');
  if (replacement.operation !== old.operation || replacement.metric !== old.metric ||
      replacement.sampleBasis !== old.sampleBasis || JSON.stringify(replacement.groupBy) !== JSON.stringify(old.groupBy) ||
      old.timeRoles.some(role => !replacement.timeRoles.includes(role)))
    throw handoffError('Rerun the same comparison and required time roles before closing its review.');
  const timeEvidence = replacement.timeRoles.map(role => {
    const entry = readHandoffFile<Execution>(executionPath(session, replacement.id + '-' + role));
    if (!entry || entry.intentId !== replacement.id) throw handoffError('The replacement intent has outstanding time evidence.');
    return { role, run_id: entry.runId, plan_digest: entry.planDigest };
  });
  if (review.target === 'data' && replacement.definition.revision <= old.definition.revision)
    throw handoffError('Confirm a newer Data Studio definition and execute the replacement intent.');
  if (review.target === 'data') checkReplacementScope(old, replacement);
  if (review.target !== 'data' && replacement.definition.digest !== old.definition.digest)
    throw handoffError('This review rerun must use the original data definition.');
  const revisedRule = replacement.decisions.find(item => item.candidate.release_id === input.releaseId)?.candidate;
  if (review.target === 'knowledge' && (!revisedRule || !review.candidate ||
      revisedRule.collection_id !== review.candidate.collection_id || revisedRule.entry_id !== review.candidate.entry_id ||
      revisedRule.revision <= review.candidate.revision || !review.remoteId || !revisedRule.feedback_ids?.includes(review.remoteId)))
    throw handoffError('The rerun must evaluate a newer release of the reviewed rule linked to the accepted Graph Studio feedback.');
  const resolution = {
    intentId: replacement.id, runId: execution.runId, planDigest: execution.planDigest,
    definition: replacement.definition, reason: input.reason.trim(),
    ...(revisedRule ? { releaseId: revisedRule.release_id } : {}),
  };
  return { resolution, old, replacement, timeEvidence };
}

const resolving = new Map<string, Promise<Review>>();

function sendClosure(file: string, review: Review, signal?: AbortSignal) {
  if (review.status === 'resolved') return Promise.resolve(review);
  const existing = resolving.get(file);
  if (existing) return existing;
  const sync = review.dataSync;
  if (!sync || !review.resolution) throw handoffError('No verified rerun is available to retry.');
  const scope = review.resolution.definition.scope;
  const result = (async () => {
    try {
      sync.receipt = await syncDataResolution(sync.request, scope, signal);
      delete sync.lastError;
      review.status = 'resolved';
      review.remoteStatus = 'resolved';
    } catch (error) {
      sync.lastError = error instanceof Error ? error.message.slice(0, 400) : 'Data Studio did not confirm the closure.';
    }
    writeRecord(file, review);
    return review;
  })().finally(() => { resolving.delete(file); });
  resolving.set(file, result);
  return result;
}

export async function closeHandoffReview(session: HandoffSession, input: HandoffInput, signal?: AbortSignal) {
  const reason = input.reason?.trim();
  if (!reason) throw handoffError('Closing needs the reviewer’s confirmation reason.');
  const { file, review } = inspectHandoffReview(session, input.reviewId);
  if (review.target === 'data' && (Buffer.byteLength(reason) > 2000 || /\p{Cc}/u.test(reason)))
    throw handoffError('Give a Data Studio confirmation reason on one line, up to 2000 UTF-8 bytes.');
  if (review.status === 'pending') throw handoffError('The review was not routed.');
  if (review.resolution) {
    if (review.resolution.intentId !== input.intentId || review.resolution.reason !== reason)
      throw handoffError('That review already has a different confirmed rerun.');
    if (review.status === 'resolved') return review;
    if (review.dataSync) return sendClosure(file, review, signal);
  }
  const { resolution, old, replacement, timeEvidence } = validateRerun(session, review, { ...input, reason });
  if (review.resolution && (review.resolution.runId !== resolution.runId || review.resolution.planDigest !== resolution.planDigest))
    throw handoffError('The originally verified rerun has changed. Preserve the previous closure record.');
  review.resolution = resolution;
  if (review.target === 'data') {
    review.status = 'resolution_pending';
    review.remoteStatus = 'unconfirmed';
    review.dataSync = { request: {
      review_id: review.id, snapshot_id: replacement.definition.snapshot_id,
      from_definition_revision: old.definition.revision, from_definition_digest: old.definition.digest,
      definition_revision: replacement.definition.revision, definition_digest: replacement.definition.digest,
      rerun_intent_id: replacement.id, rerun_id: resolution.runId, plan_digest: resolution.planDigest,
      evidence_ref: ['conversation', session.conversationId, 'intent', replacement.id, resolution.runId].join(':'),
      time_evidence: timeEvidence, reason,
    } };
    writeRecord(file, review);
    return sendClosure(file, review, signal);
  }
  review.status = 'resolved';
  writeRecord(file, review);
  return review;
}

export async function retryHandoffResolution(session: HandoffSession, reviewId: unknown, signal?: AbortSignal) {
  const { file, review } = inspectHandoffReview(session, reviewId);
  if (review.target !== 'data' || !review.resolution) throw handoffError('No Data Studio closure is available to retry.');
  if (review.status === 'resolved') return review;
  if (review.dataSync) return sendClosure(file, review, signal);
  return closeHandoffReview(session, { action: 'resolve', reviewId: review.id,
    intentId: review.resolution.intentId, reason: review.resolution.reason }, signal);
}
