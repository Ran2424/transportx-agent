import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedPlanModule } from '../contracts/index.js';
import { sha256File } from './asset-integrity.js';
import { isWithin, relativePosixPath } from './util/path.js';

type ModuleIdentity = Pick<ResolvedPlanModule, 'id' | 'version' | 'packageRoot'>;
const digestPattern = /^[a-f0-9]{64}$/;
const pathComponent = /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/;
const generatedFile = (file: string) => /^(?:__pycache__|\.DS_Store)$|\.pyc$/.test(path.basename(file));

function digestTree(root: string) {
  const hash = crypto.createHash('sha256');
  function visit(directory: string) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      const relative = relativePosixPath(root, file);
      if (stat.isDirectory()) { hash.update(JSON.stringify([relative, 'directory'])); visit(file); }
      else if (stat.isFile()) hash.update(JSON.stringify([relative, sha256File(file)]));
      else throw new Error(`Unsupported file in built-in Module archive: ${relative}`);
    }
  }
  visit(root);
  return hash.digest('hex');
}

export class BuiltinModuleArchive {
  constructor(private root: string) {}

  private versions(module: ModuleIdentity) {
    if (!pathComponent.test(module.id) || !pathComponent.test(module.version)) throw new Error('Invalid built-in Module archive identity.');
    return path.join(this.root, module.id, module.version);
  }

  private assertPath(directory: string) {
    for (let current = directory; isWithin(this.root, current); current = path.dirname(current)) {
      if (fs.existsSync(current) && !fs.lstatSync(current).isDirectory()) throw new Error('Invalid built-in Module archive directory.');
      if (current === this.root) break;
    }
  }

  freeze(module: ModuleIdentity, source: string, bundles?: string) {
    const versions = this.versions(module);
    this.assertPath(versions);
    fs.mkdirSync(versions, { recursive: true, mode: 0o700 });
    const staging = fs.mkdtempSync(path.join(versions, '.staging-'));
    try {
      fs.cpSync(source, staging, { recursive: true, filter: (file) => !generatedFile(file) });
      if (bundles && fs.existsSync(bundles)) fs.cpSync(bundles, staging, { recursive: true });
      const destination = path.join(versions, digestTree(staging));
      if (!fs.existsSync(destination)) {
        try { fs.renameSync(staging, destination); }
        catch (error) { if (!fs.existsSync(destination)) throw error; }
      }
      this.verify({ ...module, packageRoot: destination });
      return destination;
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }

  contains(packageRoot: string) { return isWithin(this.root, packageRoot); }

  find(module: ModuleIdentity) {
    const versions = this.versions(module);
    const savedVersion = path.dirname(module.packageRoot), digest = path.basename(module.packageRoot);
    if (digestPattern.test(digest) && path.basename(savedVersion) === module.version && path.basename(path.dirname(savedVersion)) === module.id) return path.join(versions, digest);
    this.assertPath(versions);
    if (!fs.existsSync(versions)) return undefined;
    const hashes = fs.readdirSync(versions).filter((name) => digestPattern.test(name));
    return hashes.length === 1 ? path.join(versions, hashes[0]) : undefined;
  }

  verify(module: ModuleIdentity) {
    const root = path.resolve(module.packageRoot), digest = path.basename(root);
    if (path.dirname(root) !== this.versions(module) || !digestPattern.test(digest)) throw new Error('Invalid built-in Module archive path.');
    this.assertPath(root);
    if (digestTree(root) !== digest) throw new Error('Built-in Module archive content has changed.');
  }
}
