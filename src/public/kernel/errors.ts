/**
 * Unified serializable error model (migration plan §4.5). Stores never hold
 * Error instances or arbitrary causes — only this plain shape.
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
