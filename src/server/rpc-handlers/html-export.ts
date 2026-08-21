import type { RpcHandlerRegistry } from '../rpc-handlers.js';

type ExportSession = { cwd: string; sessionFile: string | null | undefined };
type HtmlExportDependencies<T extends ExportSession> = {
  getLiveSession(sessionId: string): T | null | undefined;
  resolveSessionFile(filePath: string): string;
  runExport(input: { file: string; cwd: string; outputPath?: string }): Promise<string>;
  errorMessage(error: unknown): string;
};

export function createHtmlExportRpcHandlers<T extends ExportSession>(deps: HtmlExportDependencies<T>): RpcHandlerRegistry {
  return {
    export_html: {
      handle: async (command, reply) => {
        try {
          const session = command.sessionId ? deps.getLiveSession(command.sessionId) : null;
          if (command.sessionId && !session) throw new Error('Live session not found');
          const file = command.filePath ? deps.resolveSessionFile(command.filePath) : session?.sessionFile;
          if (!file) throw new Error('No session file to export yet');
          return reply.success({ path: await deps.runExport({ file, cwd: session?.cwd || '', outputPath: command.outputPath }) });
        } catch (error) {
          return reply.failure(deps.errorMessage(error));
        }
      },
    },
  };
}
