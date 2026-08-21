import type { RpcHandlerRegistry } from '../rpc-handlers.js';

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
