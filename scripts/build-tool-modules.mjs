import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { generateToolContracts } from './generate-tool-contracts.mjs';
import { pilotToolContracts } from '../src/contracts/tool-definitions.mts';

generateToolContracts();
const root = process.cwd();
const packages = path.join(root, 'dist/tool-modules');
const extensions = path.join(root, 'dist/module-extensions');
for (const output of [packages, extensions]) fs.rmSync(output, { recursive: true, force: true });
for (const moduleId of new Set(pilotToolContracts.map((contract) => contract.moduleId))) {
  const directory = moduleId.slice('com.transportx.'.length);
  const source = path.join(root, 'modules/capabilities', directory);
  const target = path.join(packages, directory);
  fs.cpSync(source, target, { recursive: true, filter: (file) => !['__pycache__', '.DS_Store'].includes(path.basename(file)) && !file.endsWith('.pyc') });
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
  for (const entry of manifest.entrypoints.piExtensions) {
    const output = path.join(target, entry);
    await build({ entryPoints: [path.join(source, entry)], outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'inline' });
    const packaged = path.join(extensions, 'capabilities', directory, entry);
    fs.mkdirSync(path.dirname(packaged), { recursive: true });
    fs.copyFileSync(output, packaged);
  }
}
