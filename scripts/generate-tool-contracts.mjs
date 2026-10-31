import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORE_TOOL_BINDINGS, coreModulePath } from '../src/contracts/tool-interface.ts';
import { coreToolContracts } from '../src/contracts/tool-definitions.mts';

export function generateToolContracts() {
  for (const contract of coreToolContracts) {
    const binding = CORE_TOOL_BINDINGS[contract.moduleId]?.find((item) => item.toolId === contract.toolId);
    if (!binding || binding.piName !== contract.piName) throw new Error(`Missing core Tool binding: ${contract.toolId}`);
    const file = new URL(`../modules/${coreModulePath(contract.moduleId)}/${binding.file}`, import.meta.url);
    const text = JSON.stringify({ $comment: 'Generated from src/contracts/tool-definitions.mts; do not edit.', ...contract }, null, 2) + '\n';
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) generateToolContracts();
