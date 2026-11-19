import { createHash } from 'node:crypto';
import { closeSync, fstatSync, linkSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const maxFile = 16 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const jsonBytes = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

export function readInput(cwd: string, relativePath: string) {
  const segments = relativePath.split(/[/\\]/u);
  if (relativePath.length > 500 || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) ||
      segments.some(segment => !segment || segment.startsWith('.') || /[:\u0000-\u001f]/u.test(segment))) {
    throw new Error('Use a visible local file path relative to this workspace.');
  }
  const root = realpathSync(cwd);
  let candidate = root;
  for (const segment of segments) {
    candidate = path.join(candidate, segment);
    if (lstatSync(candidate).isSymbolicLink()) throw new Error('Linked input files are unavailable.');
  }
  candidate = realpathSync(candidate);
  const relation = path.relative(root, candidate);
  if (!relation || relation === '..' || relation.startsWith('..' + path.sep) || path.isAbsolute(relation)) {
    throw new Error('Input is outside the workspace.');
  }
  if (!lstatSync(candidate).isFile()) throw new Error('The supplied path must be a regular input file.');
  const fd = openSync(candidate, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxFile) throw new Error('Expected a regular input file of at most 16 MiB.');
    const bytes = readFileSync(fd);
    if (bytes.length > maxFile) throw new Error('Input exceeds 16 MiB.');
    return { text: utf8.decode(bytes), sha256: digest(bytes) };
  } finally {
    closeSync(fd);
  }
}

export type Artifact = { path: string; sha256: string };

// Publish an immutable workspace file without replacing an existing file. The
// temporary copy is complete before the final name can become visible.
export function publish(cwd: string, file: string, body: string): Artifact {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(file)) throw new Error('Invalid resilience artifact name.');
  if (Buffer.byteLength(body) > maxFile) throw new Error('A resilience artifact exceeds 16 MiB. Reduce the case or survey size.');
  const root = realpathSync(cwd);
  const target = path.join(root, file);
  const sha256 = digest(body);
  const stage = mkdtempSync(path.join(root, '.resilience-stage-'));
  try {
    const draft = path.join(stage, 'body');
    writeFileSync(draft, body, { flag: 'wx' });
    try {
      linkSync(draft, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = readInput(root, file);
      if (existing.sha256 !== sha256) throw new Error('A different file already occupies ' + file);
    }
    return { path: file, sha256 };
  } finally {
    rmSync(stage, { recursive: true });
  }
}
