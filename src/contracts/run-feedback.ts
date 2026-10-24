/** Only classified feedback reaches the UI; provider payloads stay private. */
export type FailureReason = 'authentication' | 'rate_limit' | 'context_limit' | 'output_limit' | 'invalid_request' | 'network' | 'provider';
export type RetryState = { attempt: number; maxAttempts: number; delayMs: number; reason: FailureReason };
export type RunOutcome = { status: 'failed' | 'cancelled'; reason?: FailureReason };

export function classifyFailure(value: unknown): FailureReason {
  const text = typeof value === 'string' ? value : '';
  if (/\b(401|403)\b|unauthorized|authentication|invalid.*api.?key/i.test(text)) return 'authentication';
  if (/\b429\b|rate.?limit|too many requests/i.test(text)) return 'rate_limit';
  if (/context.*(length|limit|window)|too many tokens/i.test(text)) return 'context_limit';
  if (/\b400\b|invalid request|bad request/i.test(text)) return 'invalid_request';
  if (/network|fetch failed|ECONN|timeout|timed out/i.test(text)) return 'network';
  return 'provider';
}

export function messageOutcome(message: { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | undefined): RunOutcome | null {
  if (message?.role !== 'assistant') return null;
  if (message.stopReason === 'length') return { status: 'failed', reason: 'output_limit' };
  if (message.stopReason === 'aborted') return { status: 'cancelled' };
  if (message.stopReason === 'error' || message.errorMessage) return { status: 'failed', reason: classifyFailure(message.errorMessage) };
  return null;
}

export function retryState(event: Record<string, unknown>): RetryState {
  const number = (value: unknown, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : 0;
  return { attempt: number(event.attempt, 100), maxAttempts: number(event.maxAttempts, 100), delayMs: number(event.delayMs, 3600000), reason: classifyFailure(event.errorMessage) };
}
