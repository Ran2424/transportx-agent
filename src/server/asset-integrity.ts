const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function within(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function verifyChecksumFile(assetRoot: string, integrityFile: string) {
  const root = path.resolve(assetRoot);
  const checksumPath = path.resolve(integrityFile);
  if (!within(root, checksumPath) || !fs.existsSync(checksumPath)) throw new Error(`Asset integrity file is missing: ${checksumPath}`);
  const entries = fs.readFileSync(checksumPath, 'utf8').split(/\r?\n/).filter((line: string) => line.trim());
  if (!entries.length) throw new Error(`Asset integrity file is empty: ${checksumPath}`);
  for (const line of entries) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match) throw new Error(`Invalid asset integrity entry: ${line}`);
    const target = path.resolve(path.dirname(checksumPath), match[2]);
    if (!within(root, target) || !fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`Asset integrity target is missing or unsafe: ${match[2]}`);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    if (actual !== match[1].toLowerCase()) throw new Error(`Asset integrity mismatch: ${match[2]}`);
  }
  return entries.length;
}
