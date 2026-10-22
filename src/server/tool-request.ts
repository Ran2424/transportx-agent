import path from 'node:path';
import { APP_PATHS } from './config.js';
import { readPilotToolContract } from './tool-contracts.js';
import type { ToolInterfaceContract } from '../contracts/tool-interface.js';

// Fixed, platform-reviewed operations use platform-owned definitions. Installed
// package declarations cannot weaken an operation's final input validation.
const inputContracts = new Map<string, ToolInterfaceContract>();
export function approvedHostToolContract(moduleId: string) {
  let contract = inputContracts.get(moduleId);
  if (!contract) {
    const directory = moduleId === 'com.transportx.citation' ? 'citation' : 'spatial-analysis';
    contract = readPilotToolContract(path.join(APP_PATHS.appRoot, 'modules', 'capabilities', directory), moduleId)!;
    if (!contract) throw new Error('No approved Host Tool Contract');
    inputContracts.set(moduleId, contract);
  }
  return contract;
}

export async function validatePilotToolRequest(moduleId: string, body: Record<string, unknown>) {
  const contract = approvedHostToolContract(moduleId);
  const { sessionId: _sessionId, token: _token, toolCallId, contractVersion, ...input } = body;
  const fail = (message: string, code = 'tool_input_invalid', status = 400) => Object.assign(new Error(message), { code, status, phase: 'validation', commit: 'not_started' });
  if (toolCallId !== undefined && (typeof toolCallId !== 'string' || !toolCallId || toolCallId.length > 200)) throw fail('Invalid toolCallId');
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
