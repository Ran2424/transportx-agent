import { isDeepStrictEqual } from 'node:util';
import { callExperienceMcp } from './experience-exchange.js';
import type { TimeRole } from '../contracts/workspace-handoff.js';
import { handoffError } from './workspace-handoff.js';

export type DataResolutionRequest = {
  review_id: string; snapshot_id: string;
  from_definition_revision: number; from_definition_digest: string;
  definition_revision: number; definition_digest: string;
  rerun_intent_id: string; rerun_id: string; plan_digest: string; evidence_ref: string;
  time_evidence: { role: TimeRole; run_id: string; plan_digest: string }[];
  reason: string;
};
export type DataResolutionReceipt = DataResolutionRequest & { resolved_at: string };

export async function syncDataResolution(request: DataResolutionRequest, scope: string, signal?: AbortSignal) {
  const result = await callExperienceMcp('resolve_data_review', request, signal);
  if (result.scope !== scope || result.review_id !== request.review_id || result.status !== 'resolved' ||
      !result.resolution || typeof result.resolution !== 'object' || Array.isArray(result.resolution))
    throw handoffError('Data Studio did not confirm this review closure.');
  const { resolved_at, ...evidence } = result.resolution as Record<string, unknown>;
  if (typeof resolved_at !== 'string' || !Number.isFinite(Date.parse(resolved_at)) ||
      !isDeepStrictEqual(request, evidence))
    throw handoffError('Data Studio closure receipt differs from the verified rerun.');
  return { ...request, resolved_at };
}
