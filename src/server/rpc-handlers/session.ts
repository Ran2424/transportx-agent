import type { RpcHandlerRegistry } from '../rpc-handlers.js';
import type { RpcResponse } from '../types.js';

type SessionNameTarget = { sessionFile: string | null | undefined };
type SessionRpcDependencies<T extends SessionNameTarget> = {
  getLiveSession(sessionId: string): T | null | undefined;
  findLiveSessionByFile(filePath: string): T | null | undefined;
  appendSessionName(filePath: string, name: string): string;
  updateLiveSessionName(session: T, name: string): void;
};

export function createSessionRpcHandlers<T extends SessionNameTarget>(deps: SessionRpcDependencies<T>): RpcHandlerRegistry {
  return {
    set_session_name: {
      handle: (command, reply) => {
        const name = command.name?.trim();
        if (!name) return reply.failure('Name cannot be empty');
        if (name.length > 120) return reply.failure('Name cannot exceed 120 characters');
        const session = command.sessionId ? deps.getLiveSession(command.sessionId) : null;
        const resolvedFile = command.filePath || session?.sessionFile ? deps.appendSessionName(command.filePath || session!.sessionFile!, name) : null;
        const matching = resolvedFile ? deps.findLiveSessionByFile(resolvedFile) : null;
        if (session) deps.updateLiveSessionName(session, name);
        else if (matching) deps.updateLiveSessionName(matching, name);
        else if (!resolvedFile) return reply.failure('sessionId or filePath required');
        return reply.success({ name });
      },
    },
  };
}

type SessionReadTarget = { id: string; entries: unknown[]; snapshot(): Record<string, unknown> };

export function createSessionReadRpcHandlers<T extends SessionReadTarget>(getLiveSession: (sessionId: string) => T | null | undefined): RpcHandlerRegistry {
  return {
    get_messages: {
      handle: (command, reply) => {
        const session = command.sessionId ? getLiveSession(command.sessionId) : null;
        return session ? reply.success({ entries: session.entries }) : reply.failure('No active Tau session. 没有活跃的交通任务，请先创建或选择一个任务。');
      },
    },
    live_session_snapshot_request: {
      handle: (command, reply) => {
        const session = command.sessionId ? getLiveSession(command.sessionId) : null;
        return session ? { type: 'live_session_snapshot', sessionId: session.id, ...session.snapshot() } : reply.failure('No active Tau session. 没有活跃的交通任务，请先创建或选择一个任务。');
      },
    },
  };
}
