import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const sourcePythonDir = process.env.TRANSPORTX_PYTHON_RUNTIME_DIR;
if (!sourcePythonDir) {
  throw new Error('TRANSPORTX_PYTHON_RUNTIME_DIR must point to a self-contained Python 3.10 runtime directory');
}

const sourceRoot = path.resolve(sourcePythonDir);
const pythonRelative = process.platform === 'win32' ? 'python.exe' : 'bin/python3';
const sourcePython = path.join(sourceRoot, pythonRelative);
if (!fs.existsSync(sourcePython)) throw new Error(`Bundled Python entrypoint is missing: ${sourcePython}`);

const buildRoot = path.join(root, 'desktop', 'build');
const stagedPythonRoot = path.join(buildRoot, 'runtimes', 'python');
fs.rmSync(buildRoot, { recursive: true, force: true });
fs.mkdirSync(buildRoot, { recursive: true });
fs.cpSync(sourceRoot, stagedPythonRoot, { recursive: true, verbatimSymlinks: true });
const stagedPython = path.join(stagedPythonRoot, pythonRelative);

const probeSource = [
  'import importlib.util, json, platform, sys',
  "required = ['ssl', 'sqlite3', 'yaml', 'numpy', 'matplotlib', 'pandas', 'pyproj', 'shapely']",
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
if (process.platform === 'darwin' && pythonProbe.machine !== 'arm64') throw new Error(`Bundled macOS Python must be arm64, got ${pythonProbe.machine}`);
if (process.platform === 'win32' && !/^(amd64|x86_64)$/i.test(String(pythonProbe.machine))) throw new Error(`Bundled Windows Python must be x64, got ${pythonProbe.machine}`);
if (pythonProbe.missing.length) throw new Error(`Bundled Python is missing required modules: ${pythonProbe.missing.join(', ')}`);
for (const [label, runtimePath] of [['prefix', pythonProbe.prefix], ['executable', pythonProbe.executable]]) {
  const relative = path.relative(stagedPythonRoot, path.resolve(runtimePath));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Bundled Python ${label} escapes the staged runtime: ${runtimePath}`);
}

const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const piPkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8'));
const agentHostSource = path.join(root, 'bin', 'tau.js');
const piSource = path.join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');

// Video processing is a shipped desktop capability on macOS arm64 and Windows
// x64. Packaged apps always resolve this pair through the integrity manifest.
function stageFfmpegRuntime() {
  const sourceFfmpegDir = process.env.TRANSPORTX_FFMPEG_RUNTIME_DIR;
  const requiresFfmpeg = process.platform === 'darwin' || process.platform === 'win32';
  if (!requiresFfmpeg && !sourceFfmpegDir) return null;
  if (!sourceFfmpegDir) throw new Error('TRANSPORTX_FFMPEG_RUNTIME_DIR must point to a directory containing static ffmpeg and ffprobe binaries');
  const stagedFfmpegRoot = path.join(buildRoot, 'runtimes', 'ffmpeg');
  fs.mkdirSync(stagedFfmpegRoot, { recursive: true });
  const entries = {};
  for (const name of ['ffmpeg', 'ffprobe']) {
    const filename = process.platform === 'win32' ? `${name}.exe` : name;
    const source = path.join(path.resolve(sourceFfmpegDir), filename);
    if (!fs.existsSync(source)) throw new Error(`Bundled ${name} is missing: ${source}`);
    const staged = path.join(stagedFfmpegRoot, filename);
    fs.copyFileSync(source, staged);
    if (process.platform !== 'win32') fs.chmodSync(staged, 0o755);
    const versionResult = spawnSync(staged, ['-version'], { encoding: 'utf8' });
    if (versionResult.status !== 0) throw new Error(`Bundled ${name} failed to run after staging: ${(versionResult.stderr || versionResult.stdout || '').trim()}`);
    const version = (versionResult.stdout.match(/version\s+([^\s]+)/) || [])[1];
    if (!version) throw new Error(`Cannot determine bundled ${name} version`);
    if (process.platform === 'darwin') {
      const fileResult = spawnSync('file', [staged], { encoding: 'utf8' });
      if (!fileResult.stdout.includes('arm64')) throw new Error(`Bundled macOS ${name} must be arm64: ${fileResult.stdout.trim()}`);
    }
    entries[name] = { version, path: `runtimes/ffmpeg/${filename}`, sha256: sha256(staged), arch: process.platform === 'darwin' ? 'arm64' : 'x64' };
  }
  for (const extra of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'NOTICES.md']) {
    const notice = path.join(path.resolve(sourceFfmpegDir), extra);
    if (fs.existsSync(notice)) fs.copyFileSync(notice, path.join(stagedFfmpegRoot, extra));
  }
  return entries;
}
const ffmpegEntries = stageFfmpegRuntime();

const manifest = {
  manifestVersion: 1,
  product: { name: 'TransportX Traffic Agent', version: pkg.version },
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
    path: `runtimes/python/${pythonRelative}`,
    sha256: sha256(stagedPython),
  },
  ...(ffmpegEntries ? { ffmpeg: ffmpegEntries.ffmpeg, ffprobe: ffmpegEntries.ffprobe } : {}),
};
fs.writeFileSync(path.join(buildRoot, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Prepared TransportX runtime: Pi ${piPkg.version}, Python ${manifest.python.version}${ffmpegEntries ? `, ffmpeg ${ffmpegEntries.ffmpeg.version}` : ''}`);
