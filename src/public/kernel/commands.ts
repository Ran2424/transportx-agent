/**
 * Command ports (migration plan §4.2). Components never fetch(), touch the
 * WebSocket or assemble RPC JSON themselves — they call these ports.
 * Transport/HTTP failures are converted to serializable AppErrors here and
 * thrown; the kernel stores never see raw Error instances.
 */

import type { LiveSession, PendingImage, SessionSnapshot } from '../app-types.js';
import type { AppAction } from './actions.js';
import { appError, toAppError, type AppError, type AppErrorCategory } from './errors.js';

export type HttpInit = { method?: string; body?: unknown };

/** Minimal structural subset of fetch()'s Response used by the kernel. */
export type HttpResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type HttpClient = (path: string, init?: HttpInit) => Promise<HttpResponse>;

export type CommandDeps = {
  transport: { send(data: unknown): void };
  http: HttpClient;
  dispatch: (action: AppAction) => void;
  isStreaming: (sessionId: string) => boolean;
};

export type SendPromptInput = { sessionId: string; message: string; images?: PendingImage[] };
export type SteerInput = { sessionId: string; message: string };
export type FollowUpInput = { sessionId: string; message: string };
export type SetModelInput = { sessionId: string; model: string };
export type SetThinkingLevelInput = { sessionId: string; level: string };
export type CreateSessionInput = { cwd?: string; name?: string; model?: string };
export type ResumeSessionInput = { filePath: string; model?: string; cwd?: string };
export type ExtensionUiResponseInput = {
  sessionId: string | null;
  id?: string;
  response?: Record<string, unknown>;
};

export type AgentCommands = {
  sendPrompt(input: SendPromptInput): Promise<void>;
  abort(sessionId: string): Promise<void>;
  steer(input: SteerInput): Promise<void>;
  followUp(input: FollowUpInput): Promise<void>;
  setModel(input: SetModelInput): Promise<void>;
  setThinkingLevel(input: SetThinkingLevelInput): Promise<void>;
};

export type SessionCommands = {
  list(): Promise<LiveSession[]>;
  create(input: CreateSessionInput): Promise<LiveSession>;
  resume(input: ResumeSessionInput): Promise<LiveSession>;
  loadSnapshot(sessionId: string): Promise<SessionSnapshot>;
  loadHistory(filePath: string): Promise<SessionSnapshot>;
  close(sessionId: string): Promise<void>;
};

export type ExtensionUiCommands = {
  respond(input: ExtensionUiResponseInput): Promise<void>;
};

/** fetch() wrapper: network/HTTP-status/payload errors all become AppError. */
async function httpJson(
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
    const message = (data as { error?: string } | null)?.error ?? `HTTP ${response.status}`;
    throw appError({
      code: 'http_error',
      category: 'transport',
      message,
      sessionId: context.sessionId,
      retryable: response.status >= 500,
      diagnostics: { status: response.status, path },
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

async function rpcCommand(http: HttpClient, command: Record<string, unknown>): Promise<unknown> {
  const sessionId = command.sessionId as string | undefined;
  const data = await httpJson(http, '/api/rpc', { method: 'POST', body: command }, { category: 'session', sessionId });
  if (data && typeof data === 'object' && (data as { success?: unknown }).success === false) {
    throw appError({
      code: 'rpc_command_failed',
      category: 'session',
      message: String((data as { error?: unknown }).error ?? 'RPC command failed'),
      sessionId,
      retryable: false,
      diagnostics: { command: String(command.type) },
    });
  }
  return data;
}

export function createAgentCommands(deps: CommandDeps): AgentCommands {
  return {
    async sendPrompt({ sessionId, message, images }) {
      // While streaming, prompts queue per session instead of hitting the
      // transport; the kernel flushes them when the run ends.
      if (deps.isStreaming(sessionId)) {
        deps.dispatch({ type: 'conversation/promptQueued', sessionId, message, images });
        return;
      }
      deps.transport.send({ type: 'prompt', sessionId, message, ...(images?.length ? { images } : {}) });
      deps.dispatch({ type: 'conversation/promptSent', sessionId, message, images });
    },

    async abort(sessionId) {
      deps.transport.send({ type: 'abort', sessionId });
    },

    async steer({ sessionId, message }) {
      deps.transport.send({ type: 'steer', sessionId, message });
    },

    async followUp({ sessionId, message }) {
      deps.transport.send({ type: 'follow_up', sessionId, message });
    },

    async setModel({ sessionId, model }) {
      await rpcCommand(deps.http, { type: 'set_model', sessionId, model });
    },

    async setThinkingLevel({ sessionId, level }) {
      await rpcCommand(deps.http, { type: 'set_thinking_level', sessionId, level });
    },
  };
}

export function createSessionCommands(deps: CommandDeps): SessionCommands {
  const context = { category: 'session' as AppErrorCategory };
  return {
    async list() {
      const data = await httpJson(deps.http, '/api/live-sessions', undefined, context);
      return ((data as { sessions?: LiveSession[] })?.sessions ?? []) as LiveSession[];
    },

    async create(input) {
      const data = await httpJson(deps.http, '/api/live-sessions', { method: 'POST', body: input }, context);
      return (data as { session: LiveSession }).session;
    },

    async resume(input) {
      const data = await httpJson(deps.http, '/api/live-sessions/resume', { method: 'POST', body: input }, context);
      return (data as { session: LiveSession }).session;
    },

    async loadSnapshot(sessionId) {
      const data = await httpJson(deps.http, `/api/live-sessions/${encodeURIComponent(sessionId)}/snapshot`, undefined, { ...context, sessionId });
      return data as SessionSnapshot;
    },

    async loadHistory(filePath) {
      const data = await httpJson(deps.http, `/api/session-history?filePath=${encodeURIComponent(filePath)}`, undefined, context);
      return data as SessionSnapshot;
    },

    async close(sessionId) {
      await httpJson(deps.http, `/api/live-sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }, { ...context, sessionId });
    },
  };
}

export function createExtensionUiCommands(deps: CommandDeps): ExtensionUiCommands {
  return {
    async respond({ sessionId, id, response }) {
      deps.transport.send({
        type: 'extension_ui_response',
        id,
        ...(sessionId ? { sessionId } : {}),
        ...(response ?? { cancelled: true }),
      });
      deps.dispatch({ type: 'extensionUi/resolved', sessionId, requestId: id });
    },
  };
}

export type KernelCommands = {
  agent: AgentCommands;
  session: SessionCommands;
  extensionUi: ExtensionUiCommands;
};

export function createCommands(deps: CommandDeps): KernelCommands {
  return {
    agent: createAgentCommands(deps),
    session: createSessionCommands(deps),
    extensionUi: createExtensionUiCommands(deps),
  };
}
