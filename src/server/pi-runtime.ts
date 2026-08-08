const { execFileSync } = require('node:child_process');

export const MIN_PI_VERSION = '0.80.10';
export const MAX_PI_VERSION_EXCLUSIVE = '0.81.0';

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

export function assertSupportedPiVersion(value: unknown) {
  const actual = parsePiVersion(value);
  const minimum = parsePiVersion(MIN_PI_VERSION)!;
  const maximum = parsePiVersion(MAX_PI_VERSION_EXCLUSIVE)!;
  if (!actual) throw new Error(`Cannot parse Pi version: ${String(value || '<empty>')}`);
  if (compareVersion(actual, minimum) < 0 || compareVersion(actual, maximum) >= 0) {
    throw new Error(`Unsupported Pi version ${actual.raw}; expected >=${MIN_PI_VERSION} <${MAX_PI_VERSION_EXCLUSIVE}`);
  }
  return actual.raw;
}

export function inspectPiRuntime(command: string, prefixArgs: string[] = []) {
  let output: string;
  try {
    output = execFileSync(command, [...prefixArgs, '--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot execute Pi CLI '${[command, ...prefixArgs, '--version'].join(' ')}': ${message}`);
  }
  return { command: [command, ...prefixArgs].join(' '), version: assertSupportedPiVersion(output) };
}
