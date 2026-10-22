export type HostContext = { endpoint?: string; sessionId?: string; token?: string };
export type HostCallContext = { toolCallId: string; contractVersion: string; signal?: AbortSignal; timeoutMs: number; dispatched?(): void };

export class HostCallError extends Error {
  constructor(message: string, readonly code: string, readonly phase: string, readonly commit: 'not_started' | 'not_committed' | 'unknown', readonly field?: string) { super(message); }
}

// Private build input, bundled into each first-party Module. No retries, domain
// dispatch, business validation, Pi registration or execution queue lives here.
export async function postHostOperation<T>(host: HostContext, route: string, input: Record<string, unknown>, call: HostCallContext): Promise<T> {
  if (!host.endpoint || !host.sessionId || !host.token) throw new HostCallError('Agent Host bridge is unavailable for this session.', 'host_unavailable', 'prepare', 'not_started');
  if (call.signal?.aborted) throw new HostCallError('Call cancelled before dispatch.', 'cancelled', 'prepare', 'not_started');
  const signal = AbortSignal.any([AbortSignal.timeout(call.timeoutMs), ...(call.signal ? [call.signal] : [])]);
  const body = JSON.stringify({ ...input, sessionId: host.sessionId, token: host.token, toolCallId: call.toolCallId, contractVersion: call.contractVersion });
  let response: Response;
  call.dispatched?.();
  try {
    response = await fetch(host.endpoint + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal });
  } catch (error) {
    const phase = call.signal?.aborted ? 'cancel_requested' : (error as Error).name === 'TimeoutError' ? 'timeout' : 'transport';
    throw new HostCallError('The Host result was not confirmed. Do not repeat this operation automatically.', 'host_result_unknown', phase, 'unknown');
  }
  let payload: Record<string, unknown>;
  try {
    const value = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a Host response object');
    payload = value as Record<string, unknown>;
  } catch {
    throw new HostCallError('The Host response could not be decoded. Preserve existing results and verify them before another execution.', 'host_result_unknown', 'response_decode', 'unknown');
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new HostCallError('Agent Host authorization was refused.', 'authorization_denied', 'authorization', 'not_started');
    const commit = payload.commit === 'not_started' || payload.commit === 'not_committed' ? payload.commit : 'unknown';
    throw new HostCallError(String(payload.error || 'Agent Host operation failed.').slice(0, 1500), typeof payload.code === 'string' ? payload.code : 'host_result_unknown', typeof payload.phase === 'string' ? payload.phase : 'host', commit, typeof payload.field === 'string' ? payload.field : undefined);
  }
  if (payload.toolCallId !== undefined && payload.toolCallId !== call.toolCallId) throw new HostCallError('Host response call association differs.', 'host_result_unknown', 'response_decode', 'unknown');
  return payload as T;
}
