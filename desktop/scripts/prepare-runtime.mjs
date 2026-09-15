import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { getPlatformProfile } from './platform-profile.mjs';

const profile = getPlatformProfile();

const root = process.cwd();
const sourcePythonDir = process.env.TRANSPORTX_PYTHON_RUNTIME_DIR;
if (!sourcePythonDir) {
  throw new Error('TRANSPORTX_PYTHON_RUNTIME_DIR must point to a self-contained Python 3.10 runtime directory');
}

const sourceRoot = path.resolve(sourcePythonDir);
const sourcePython = path.join(sourceRoot, profile.python.entry);
if (!fs.existsSync(sourcePython)) throw new Error(`Bundled Python entrypoint is missing: ${sourcePython}`);

const buildRoot = path.join(root, 'desktop', 'build');
const stagedPythonRoot = path.join(buildRoot, 'runtimes', 'python');
fs.rmSync(buildRoot, { recursive: true, force: true });
fs.mkdirSync(buildRoot, { recursive: true });
fs.cpSync(sourceRoot, stagedPythonRoot, { recursive: true, verbatimSymlinks: true });
const stagedPython = path.join(stagedPythonRoot, profile.python.entry);

const probeSource = [
  'import importlib.util, json, platform, sys',
  `required = ${JSON.stringify(profile.python.requiredModules)}`,
  'print(json.dumps({',
  "  'version': platform.python_version(),",
  "  'machine': platform.machine(),",
  "  'prefix': sys.prefix,",
  "  'executable': sys.executable,",
  "  'missing': [name for name in required if importlib.util.find_spec(name) is None],",
  '}))',
].join('\n');
const probeResult = spawnSync(stagedPython, ['-B', '-I', '-c', probeSource], {
  encoding: 'utf8',
  env: { ...process.env, PYTHONHOME: '', PYTHONPATH: '' },
});
if (probeResult.status !== 0) {
  throw new Error(`Bundled Python failed after staging: ${(probeResult.stderr || probeResult.stdout).trim()}`);
}
const pythonProbe = JSON.parse(probeResult.stdout);
if (!String(pythonProbe.version).startsWith('3.10.')) throw new Error(`Bundled Python must be 3.10.x, got ${pythonProbe.version}`);
if (!profile.python.archCheck(pythonProbe.machine)) {
  throw new Error(`Bundled ${profile.label} Python must be ${profile.python.archErrorMessage}, got ${pythonProbe.machine}`);
}
if (pythonProbe.missing.length) {
  // TRANSPORTX_ALLOW_INCOMPLETE_PYTHON_RUNTIME=1 lets CI / offline hosts
  // proceed past a partial Python install for distribution structure
  // verification only. The runtime manifest still records the actual
  // version + SHA-256 of whatever Python was bundled; this is purely a
  // pre-flight escape hatch and is never required for a real release.
  const allowIncomplete = process.env.TRANSPORTX_ALLOW_INCOMPLETE_PYTHON_RUNTIME === '1';
  if (!allowIncomplete) throw new Error(`Bundled Python is missing required modules: ${pythonProbe.missing.join(', ')}. Run 'desktop/python-requirements.txt' in your Python tree, or set TRANSPORTX_ALLOW_INCOMPLETE_PYTHON_RUNTIME=1 for offline / verification builds only.`);
  console.warn(`[prepare-runtime] WARNING: bundled Python is missing ${pythonProbe.missing.join(', ')}; TRANSPORTX_ALLOW_INCOMPLETE_PYTHON_RUNTIME=1 was set.`);
}
for (const [label, runtimePath] of [['prefix', pythonProbe.prefix], ['executable', pythonProbe.executable]]) {
  const relative = path.relative(stagedPythonRoot, path.resolve(runtimePath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Bundled Python ${label} escapes the staged runtime: ${runtimePath}`);
}

const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const piPkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8'));
const agentHostSource = path.join(root, 'bin', 'tau.js');
const piSource = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');

const manifest = {
  manifestVersion: 1,
  product: { name: 'TransportX Agent', version: pkg.version },
  agentHost: {
    version: pkg.version,
    protocolVersion: 1,
    path: 'app.asar/bin/tau.js',
    sha256: sha256(agentHostSource),
  },
  pi: {
    version: piPkg.version,
    path: 'app.asar/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
    sha256: sha256(piSource),
  },
  python: {
    version: pythonProbe.version,
    path: `runtimes/python/${profile.python.entry}`,
    sha256: sha256(stagedPython),
  },
};
fs.writeFileSync(path.join(buildRoot, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Prepared TransportX runtime: Pi ${piPkg.version}, Python ${manifest.python.version}`);
