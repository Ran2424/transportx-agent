const { execFileSync } = require('node:child_process');
import fs from 'node:fs';
import path from 'node:path';

import { PI_RUNTIME_MINIMUM } from '../contracts/version.js';
export const MAX_PI_VERSION_EXCLUSIVE = '0.85.0';

type PiVersion = { major: number; minor: number; patch: number; raw: string };

export function parsePiVersion(value: unknown): PiVersion | null {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), raw };
}

function compareVersion(left: PiVersion, right: PiVersion) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function piProcessEnv(extra: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    ...(process.env.TAU_DESKTOP === '1' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...extra,
  };
}

export function assertPiResourceBoundary(prefixArgs: string[]) {
  const entry = prefixArgs[0];
  // Custom executable overrides are operator-supplied runtimes; the bundled
  // CLI must carry our audited fix even if npm was run with --ignore-scripts.
  if (!entry || path.basename(entry) !== 'cli.js') return;
  const loader = fs.readFileSync(path.join(path.dirname(entry), 'core', 'resource-loader.js'), 'utf8');
  if (loader.split('TransportX: disabled resource discovery must not execute package-manager commands.').length !== 3) {
    throw new Error('Pi resource boundary patch is missing. Rebuild TransportX before starting a session.');
  }
}

export function assertSupportedPiVersion(value: unknown) {
  const actual = parsePiVersion(value);
  const minimum = parsePiVersion(PI_RUNTIME_MINIMUM)!;
  const maximum = parsePiVersion(MAX_PI_VERSION_EXCLUSIVE)!;
  if (!actual) throw new Error(`Cannot parse Pi version: ${String(value || '<empty>')}`);
  if (compareVersion(actual, minimum) < 0 || compareVersion(actual, maximum) >= 0) {
    throw new Error(`Unsupported Pi version ${actual.raw}; expected >=${PI_RUNTIME_MINIMUM} <${MAX_PI_VERSION_EXCLUSIVE}`);
  }
  return actual.raw;
}

export function inspectPiRuntime(command: string, prefixArgs: string[] = []) {
  let output: string;
  try {
    output = execFileSync(command, [...prefixArgs, '--version'], { encoding: 'utf8', timeout: 30000, env: piProcessEnv() }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot execute Pi CLI '${[command, ...prefixArgs, '--version'].join(' ')}': ${message}`);
  }
  return { command: [command, ...prefixArgs].join(' '), version: assertSupportedPiVersion(output) };
}
