import path from 'node:path';
import { APP_PATHS } from './config.js';
import { readToolContract } from './tool-contracts.js';
import { coreModulePath, type ToolInterfaceContract } from '../contracts/tool-interface.js';

// Fixed, platform-reviewed operations use platform-owned definitions. Installed
// package declarations cannot weaken an operation's final input validation.
const inputContracts = new Map<string, ToolInterfaceContract>();
export function approvedHostToolContract(moduleId: string, toolId?: string) {
  const key = `${moduleId}:${toolId || 'primary'}`;
  let contract = inputContracts.get(key);
  if (!contract) {
    contract = readToolContract(path.join(APP_PATHS.appRoot, 'modules', coreModulePath(moduleId)), moduleId, toolId)!;
    if (!contract) throw new Error('No approved Host Tool Contract');
    inputContracts.set(key, contract);
  }
  return contract;
}

export async function validateToolRequest(moduleId: string, body: Record<string, unknown>, toolId?: string) {
  const contract = approvedHostToolContract(moduleId, toolId);
  const { sessionId: _sessionId, token: _token, toolCallId, contractVersion, operationId, ...input } = body;
  if ((toolId === 'spatial.execution' || toolId === 'cad.execution') && operationId !== undefined) input.operationId = operationId;
  const fail = (message: string, code = 'tool_input_invalid', status = 400) => Object.assign(new Error(message), { code, status, phase: 'validation', commit: 'not_started' });
  if (toolCallId !== undefined && (typeof toolCallId !== 'string' || !toolCallId || toolCallId.length > 200)) throw fail('Invalid toolCallId');
  if (operationId !== undefined && !(typeof operationId === 'string' && (moduleId === 'com.transportx.spatial-analysis' && /^spatial_[a-f0-9]{32}$/.test(operationId) || moduleId === 'com.transportx.cad' && toolId === 'cad.execution' && /^cad_[a-f0-9]{32}$/.test(operationId)))) throw fail('Invalid operationId');
  if (contractVersion !== undefined && (typeof contractVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(contractVersion) || contractVersion.split('.')[0] !== contract.contractVersion.split('.')[0])) throw fail('Tool Contract version is incompatible with this Host. Reopen the task with a compatible Module.', 'tool_contract_incompatible', 409);
  const { Check, Errors } = await import('typebox/value');
  // The definition is generated from TypeBox; the JSON parser intentionally
  // exposes serializable data rather than a second handwritten schema type.
  if (!Check(contract.input as any, input)) {
    const issue = Errors(contract.input as any, input)[0];
    throw Object.assign(fail(`Input does not match ${contract.toolId}@${contract.contractVersion}: ${issue?.message || 'invalid parameters'}`), { field: issue?.instancePath });
  }
  return input;
}
