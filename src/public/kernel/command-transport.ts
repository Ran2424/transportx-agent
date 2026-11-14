import type { AppAction } from './actions.js';
import { appError, toAppError, type AppErrorCategory } from '../../contracts/errors.ts';

export type HttpInit = { signal?: AbortSignal; method?: string; body?: unknown; headers?: Record<string, string> };

/** Minimal structural subset of fetch()'s Response used by the kernel. */
export type HttpResponse = {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
};

export type HttpClient = (path: string, init?: HttpInit) => Promise<HttpResponse>;

export type CommandDeps = {
  http: HttpClient;
  liveSessionId(conversationId: string): string | null;
  dispatch: (action: AppAction) => void;
  isStreaming: (sessionId: string) => boolean;
  isCompacting: (sessionId: string) => boolean;
};

/** fetch() wrapper: network/HTTP-status/payload errors all become AppError. */
export async function httpJson(
  http: HttpClient,
  path: string,
  init: HttpInit | undefined,
  context: { category: AppErrorCategory; sessionId?: string },
): Promise<unknown> {
  let response: HttpResponse;
  try {
    response = await http(path, init);
  } catch (cause) {
    throw toAppError(cause, {
      code: 'http_network_error',
      category: 'transport',
      sessionId: context.sessionId,
      retryable: true,
      diagnostics: { path },
    });
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON body; status decides success below.
  }
  if (!response.ok) {
    const errorPayload = data as { error?: string; code?: string; report?: string; itemId?: string; conversationId?: string; details?: { workspaceId?: string; path?: string; relationship?: string } } | null;
    const message = errorPayload?.error ?? `HTTP ${response.status}`;
    const conflict = errorPayload?.code === 'workspace_identity_conflict' ? errorPayload.details : undefined;
    throw appError({
      code: errorPayload?.code || 'http_error',
      category: context.category,
      message,
      sessionId: context.sessionId,
      retryable: response.status >= 500,
      diagnostics: { status: response.status, path, ...(errorPayload?.report ? { report: errorPayload.report } : {}), ...(errorPayload?.itemId ? { itemId: errorPayload.itemId } : {}), ...(errorPayload?.conversationId ? { conversationId: errorPayload.conversationId } : {}), ...(conflict?.workspaceId && conflict.path && conflict.relationship ? { conflictingWorkspaceId: conflict.workspaceId, conflictingPath: conflict.path, relationship: conflict.relationship } : {}) },
    });
  }
  // RPC envelopes carry both `success` and `error`; those are interpreted by
  // rpcCommand below, not by this generic payload check.
  const isRpcEnvelope = data && typeof data === 'object' && 'success' in data;
  if (!isRpcEnvelope && data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
    throw appError({
      code: 'api_error',
      category: context.category,
      message: (data as { error: string }).error,
      sessionId: context.sessionId,
      retryable: false,
      diagnostics: { path },
    });
  }
  return data;
}

export async function httpText(http: HttpClient, path: string, context: { category: AppErrorCategory; sessionId?: string }) {
  let response: HttpResponse;
  try {
    response = await http(path);
  } catch (cause) {
    throw toAppError(cause, { code: 'http_network_error', category: 'transport', sessionId: context.sessionId, retryable: true, diagnostics: { path } });
  }
  if (!response.ok) {
    throw appError({ code: response.headers?.get('X-Citation-Error') || 'http_error', category: context.category, message: `HTTP ${response.status}`, sessionId: context.sessionId, retryable: response.status >= 500, diagnostics: { status: response.status, path } });
  }
  return { content: await response.text(), stale: response.headers?.get('X-Citation-Resource-Stale') === '1' };
}

export async function rpcCommand(deps: CommandDeps, command: Record<string, unknown>): Promise<unknown> {
  const sessionId = command.sessionId as string | undefined;
  if (sessionId) {
    const liveSessionId = deps.liveSessionId(sessionId);
    if (!liveSessionId && !['get_available_models', 'refresh_models'].includes(String(command.type))) throw appError({ code: 'conversation_not_active', category: 'session', message: '会话运行已结束，请重试当前操作。', sessionId, retryable: false });
    command = { ...command, sessionId: liveSessionId || undefined };
  }
  const data = await httpJson(deps.http, '/api/rpc', { method: 'POST', body: command }, { category: 'session', sessionId });
  if (data && typeof data === 'object' && (data as { success?: unknown }).success === false) {
    const message = String((data as { error?: unknown }).error ?? 'RPC command failed');
    const deliveryUnknown = (data as { delivery?: string }).delivery === 'unknown' || message.startsWith('RPC command timed out:');
    throw appError({
      code: deliveryUnknown ? 'delivery_unknown' : 'rpc_command_failed',
      category: 'session',
      message,
      sessionId,
      retryable: false,
      diagnostics: { command: String(command.type) },
    });
  }
  return data;
}
