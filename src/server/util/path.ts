// Pure filesystem / path utilities consumed by every server-side module that
// needs to compare, normalize, or stringify file paths. Two principles:
//
// 1. In-memory path comparisons use Node's lexical `path.relative` — never
//    `path.startsWith(root + path.sep)` — because the latter breaks for any
//    share, drive, UNC, or case difference the OS introduces. The shared
//    `isWithin` wrapper exposes the canonical formula.
// 2. Paths serialized into JSON, manifests, citation resources, attachment
//    indexes or other platform-independent payloads are stored as POSIX
//    (forward-slash) relative strings. Storage and transport are
//    platform-agnostic; only OS APIs at the boundary convert via
//    `fromPosixPath`.
//
// These helpers do not hit the filesystem. Side-effecting operations (realpath,
// stat, open) stay in their callers.

import path from 'node:path';

export { within as isWithin } from '../asset-integrity.js';

/**
 * Convert any path string to forward-slash, POSIX form. Used to normalize
 * paths before they are written to JSON manifests, citation resources,
 * attachment indexes, or any other platform-independent payload. Collapses
 * runs of backslashes (a Windows-only artifact) into single forward slashes,
 * but preserves other slash repetition so that URL-shaped strings are not
 * rewritten.
 */
export function toPosixPath(value: string): string {
  if (!value) return value;
  return value.replace(/\\+/g, '/');
}

/**
 * Build a relative POSIX path from `root` to `target`. Both arguments are
 * expected to have been resolved via `path.resolve` by the caller; this
 * helper only does the relpath + separator normalization that every
 * serialization site used to inline.
 */
export function relativePosixPath(root: string, target: string): string {
  return toPosixPath(path.relative(path.resolve(root), path.resolve(target)));
}
