import type { JsonRecord } from './types.js';

export function mergeContextUsage(current: JsonRecord | null, incoming: JsonRecord) {
  const tokens = incoming.tokens;
  const contextWindow = incoming.contextWindow;
  const hasTokens = typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0;
  const hasContextWindow = typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0;
  const estimatedTokens = current?.tokens;
  if (!hasTokens && hasContextWindow && typeof estimatedTokens === 'number' && Number.isFinite(estimatedTokens) && estimatedTokens >= 0) {
    return { ...incoming, tokens: estimatedTokens, percent: estimatedTokens / contextWindow * 100 };
  }
  return incoming;
}

export function withUsageTotals(current: JsonRecord | null, usage: JsonRecord) {
  return { ...(current || {}), usage };
}

export function contextUsageAfterCompaction(current: JsonRecord | null, modelContextWindow: unknown, estimatedTokensAfter: unknown) {
  const tokens = Number(estimatedTokensAfter);
  const contextWindow = Number(current?.contextWindow ?? modelContextWindow);
  if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(contextWindow) || contextWindow <= 0) return current;
  return { ...(current || {}), tokens, contextWindow, percent: tokens / contextWindow * 100 };
}
