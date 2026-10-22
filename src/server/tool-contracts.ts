import fs from 'node:fs';
import path from 'node:path';
import { PILOT_TOOL_IDS, parseToolInterfaceContract, type ToolInterfaceContract } from '../contracts/tool-interface.js';

export function readPilotToolContract(packageRoot: string, moduleId: string): ToolInterfaceContract | null {
  const identity = PILOT_TOOL_IDS[moduleId];
  if (!identity) return null;
  const file = path.join(packageRoot, 'tool-contract.json');
  // A pre-contract module remains installable/resumable via the original Pi
  // interface. Missing optional metadata cannot establish availability.
  if (!fs.existsSync(file)) return null;
  const value = parseToolInterfaceContract(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!value || value.moduleId !== moduleId || value.toolId !== identity.toolId || value.piName !== identity.piName) throw new Error(`Invalid Tool Contract in Module ${moduleId}`);
  return value;
}

