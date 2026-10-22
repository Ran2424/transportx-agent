import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pilotToolContracts } from '../src/contracts/tool-definitions.mts';

export function generateToolContracts() {
  for (const contract of pilotToolContracts) {
    const directory = contract.moduleId === 'com.transportx.citation' ? 'citation' : 'spatial-analysis';
    const file = new URL(`../modules/capabilities/${directory}/${contract.toolId === 'spatial.execution' ? 'execution-contract.json' : 'tool-contract.json'}`, import.meta.url);
    const text = JSON.stringify({ $comment: 'Generated from src/contracts/tool-definitions.mts; do not edit.', ...contract }, null, 2) + '\n';
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) generateToolContracts();
