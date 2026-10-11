import type { RpcCommand } from './types.js';

/** Validate the shared envelope before invoking side effects. Domain parsers
 * retain their specific schemas; additional Pi fields remain compatible. */
export function parseRpcCommand(value: unknown): RpcCommand {
  const invalid = (field: string): never => { throw Object.assign(new Error(`Invalid RPC field: ${field}`), { code: 'invalid_command', status: 400 }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('command');
  const command = value as Record<string, unknown>;
  if (typeof command.type !== 'string' || !command.type.trim()) invalid('type');
  for (const field of ['id', 'clientCommandId', 'sessionId', 'filePath', 'outputPath', 'cwd', 'model', 'provider', 'modelId', 'api', 'baseUrl', 'apiKey', 'level', 'name', 'sourcePath', 'importId', 'kind', 'moduleId', 'message']) {
    if (command[field] !== undefined && typeof command[field] !== 'string') invalid(field);
  }
  for (const field of ['enabled', 'reasoning']) if (command[field] !== undefined && typeof command[field] !== 'boolean') invalid(field);
  for (const field of ['attachmentIds', 'geoContextIds', 'canvasContextIds']) {
    const ids = command[field];
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id))) invalid(field);
  }
  return command as RpcCommand;
}
