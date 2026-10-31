import fs from 'node:fs';
import path from 'node:path';
import { CORE_TOOL_BINDINGS, parseToolInterfaceContract, type ToolInterfaceContract } from '../contracts/tool-interface.js';

export function readToolContract(packageRoot: string, moduleId: string, toolId?: string): ToolInterfaceContract | null {
  const bindings = CORE_TOOL_BINDINGS[moduleId];
  const identity = toolId ? bindings?.find((binding) => binding.toolId === toolId) : bindings?.[0];
  if (!identity) return null;
  const file = path.join(packageRoot, identity.file);
  // Frozen pre-contract modules retain their original Pi interface.
  if (!fs.existsSync(file)) return null;
  const value = parseToolInterfaceContract(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!value || value.moduleId !== moduleId || value.toolId !== identity.toolId || value.piName !== identity.piName) throw new Error(`Invalid Tool Contract in Module ${moduleId}`);
  return value;
}

export function readModuleToolContracts(packageRoot: string, moduleId: string) {
  return (CORE_TOOL_BINDINGS[moduleId] || []).map((binding) => readToolContract(packageRoot, moduleId, binding.toolId));
}
