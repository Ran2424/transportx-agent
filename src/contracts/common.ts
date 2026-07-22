/**
 * Shared primitives used across every contract surface.
 *
 * These are the lowest-level shapes crossing Pi RPC, JSONL and the Browser
 * Kernel. They must stay free of React, DOM and Node-only imports so the same
 * module is importable from Server, Extension and Web Feature code.
 */

export type JsonRecord = Record<string, unknown>;

export type JsonPrimitive = string | number | boolean | null;

export type ValidationIssue = {
  path: string;
  code: string;
  message: string;
};

export type ValidationResult<T> =
  | { ok: true; value: T; issues: [] }
  | { ok: false; value: null; issues: ValidationIssue[] };

/**
 * Model identity used by the Pi Web Bridge envelope, the SessionSnapshot's
 * live `model` field and any Feature that needs to display the current model.
 */
export type ModelIdentity = {
  provider?: string;
  id?: string;
  name?: string;
  contextWindow?: number;
  [key: string]: unknown;
};

/**
 * Convenience helpers used by every parser so they all share consistent
 * coercion behavior. None of these throw — they return null/false when the
 * value is not of the expected shape, so parsers can collect diagnostics
 * instead of aborting on the first failure.
 */
export function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

export function asString(value: unknown, max = 200): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (text.length > max) return null;
  return text;
}

export function asOptionalText(value: unknown, max = 200): string | null | undefined {
  if (value === undefined) return undefined;
  return asString(value, max);
}

export function asFiniteNumber(value: unknown): number | null {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : null;
  return n;
}

export function asInteger(value: unknown): number | null {
  return Number.isInteger(value) ? (value as number) : null;
}

export function asPositiveInteger(value: unknown): number | null {
  const n = asInteger(value);
  return n !== null && n >= 1 ? n : null;
}
