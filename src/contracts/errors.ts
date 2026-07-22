/**
 * Unified serializable error model (migration plan §4.5). Stores never hold
 * Error instances or arbitrary causes — only this plain shape.
 *
 * Browser Kernel, Server and Feature UIs exchange `AppError` directly; it is
 * transported over HTTP responses, WebSocket frames and AppAction payloads.
 */

export type AppErrorCategory =
  | 'transport'
  | 'protocol'
  | 'session'
  | 'extension'
  | 'resource'
  | 'feature'
  | 'runtime';

export type AppError = {
  code: string;
  category: AppErrorCategory;
  message: string;
  sessionId?: string;
  retryable: boolean;
  diagnostics?: Record<string, string | number | boolean>;
};

export function appError(init: AppError): AppError {
  return { ...init };
}

/** Convert an arbitrary thrown value into a serializable AppError. */
export function toAppError(cause: unknown, init: Omit<AppError, 'message'> & { message?: string }): AppError {
  const { message, ...rest } = init;
  return {
    ...rest,
    message: message ?? (cause instanceof Error ? cause.message : String(cause)),
  };
}

/**
 * Build an `AppError` (`category: 'protocol'`) from a list of
 * `ContractDiagnostic` entries. Used by every contract parser when it returns
 * `ok: false`.
 */
import type { ContractDiagnostic } from './diagnostic.ts';

export function protocolError(diagnostics: ContractDiagnostic[], sessionId?: string): AppError {
  return {
    code: 'contract_invalid',
    category: 'protocol',
    message: diagnostics.length ? diagnostics.map((diag) => `${diag.path}: ${diag.message}`).join('; ') : 'Protocol payload rejected',
    ...(sessionId ? { sessionId } : {}),
    retryable: false,
    diagnostics: {
      count: diagnostics.length,
      firstCode: diagnostics[0]?.code ?? 'unknown',
      severity: diagnostics.some((diag) => diag.severity === 'error') ? 'error' : 'warning',
    },
  };
}
