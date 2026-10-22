import fs from 'node:fs';
import path from 'node:path';
import { diagnosticMessage, parseModuleManifestStructured } from '../contracts/index.js';
import { validateModulePackage } from './module-installer.js';
import { isWithin } from './util/path.js';

// Only a generated package inside the current task. Inspection is static;
// execution trust and installation still belong to the existing installer.
export function inspectTaskModule(cwd: string, relativePath: unknown) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath)) throw new Error('packagePath must be a task-relative package directory');
  const root = fs.realpathSync(cwd), packageRoot = fs.realpathSync(path.resolve(root, relativePath));
  if (!isWithin(root, packageRoot) || packageRoot === root) throw new Error('Module package must be inside the current task');
  const parsed = parseModuleManifestStructured(JSON.parse(fs.readFileSync(path.join(packageRoot, 'manifest.json'), 'utf8')));
  if (!parsed.ok) throw new Error(parsed.diagnostics.map(diagnosticMessage).join('; '));
  validateModulePackage(packageRoot, parsed.value);
  return { packageRoot, manifest: parsed.value };
}
