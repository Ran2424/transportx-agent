const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
import { isWithin } from './util/path.js';

/**
 * Filesystem safety primitives shared by every server-side path boundary
 * (ARCHITECTURE.md §7): module install/assembly, asset resolution, session
 * attachments, live file/preview/export routes and spatial inputs.
 *
 * `isWithin` is pure lexical containment: root itself counts as inside. It does
 * NOT resolve symlinks — call sites protecting existing files must realpath()
 * both root and target first (see resolveLiveSessionPath / spatial safeInput),
 * and non-existent targets keep their own parent/symlink checks.
 */
export function sha256File(filePath: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function verifyChecksumFile(assetRoot: string, integrityFile: string) {
  const root = path.resolve(assetRoot);
  const checksumPath = path.resolve(integrityFile);
  if (!isWithin(root, checksumPath) || !fs.existsSync(checksumPath)) throw new Error(`Asset integrity file is missing: ${checksumPath}`);
  const entries = fs.readFileSync(checksumPath, 'utf8').split(/\r?\n/).filter((line: string) => line.trim());
  if (!entries.length) throw new Error(`Asset integrity file is empty: ${checksumPath}`);
  for (const line of entries) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match) throw new Error(`Invalid asset integrity entry: ${line}`);
    const target = path.resolve(path.dirname(checksumPath), match[2]);
    if (!isWithin(root, target) || !fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`Asset integrity target is missing or unsafe: ${match[2]}`);
    const actual = sha256File(target);
    if (actual !== match[1].toLowerCase()) throw new Error(`Asset integrity mismatch: ${match[2]}`);
  }
  return entries.length;
}
