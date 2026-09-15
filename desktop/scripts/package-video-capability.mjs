import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { build } from 'esbuild';
import yazl from 'yazl';

import { getPlatformProfile } from './platform-profile.mjs';

const root = process.cwd();
const profile = getPlatformProfile();
const sourceRuntimeDir = process.env.TRANSPORTX_FFMPEG_RUNTIME_DIR;
if (!sourceRuntimeDir) throw new Error('TRANSPORTX_FFMPEG_RUNTIME_DIR must point to the ffmpeg/ffprobe runtime to package');

const sourceModule = path.join(root, 'modules', 'installable', 'video');
const sourceManifest = JSON.parse(fs.readFileSync(path.join(sourceModule, 'manifest.json'), 'utf8'));
const buildRoot = path.join(root, 'desktop', 'build', 'video-capability');
const packageRoot = path.join(buildRoot, sourceManifest.id, sourceManifest.version);
fs.rmSync(buildRoot, { recursive: true, force: true });
fs.mkdirSync(packageRoot, { recursive: true });
fs.cpSync(sourceModule, packageRoot, { recursive: true });

const extensionOutput = path.join(packageRoot, 'extensions', 'pi-video', 'index.js');
await build({
  entryPoints: [path.join(sourceModule, 'extensions', 'pi-video', 'index.ts')],
  outfile: extensionOutput,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  packages: 'bundle',
});
fs.rmSync(path.join(packageRoot, 'extensions', 'pi-video', 'index.ts'));

const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
const runtimeDir = path.join(packageRoot, 'runtime');
fs.mkdirSync(runtimeDir, { recursive: true });
const executables = {};
let runtimeVersion = '';
for (const name of ['ffmpeg', 'ffprobe']) {
  const filename = profile.ffmpeg.binName(name);
  const source = path.join(path.resolve(sourceRuntimeDir), filename);
  if (!fs.existsSync(source)) throw new Error(`${name} is missing: ${source}`);
  const target = path.join(runtimeDir, filename);
  fs.copyFileSync(source, target);
  if (profile.ffmpeg.chmodRequired) fs.chmodSync(target, 0o755);
  profile.ffmpeg.archCheck(target);
  const probe = spawnSync(target, ['-version'], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Error(`${name} failed to run: ${(probe.stderr || probe.stdout || '').trim()}`);
  const version = (probe.stdout.match(/version\s+([^\s]+)/) || [])[1];
  if (!version) throw new Error(`Cannot determine ${name} version`);
  if (runtimeVersion && runtimeVersion !== version) throw new Error(`ffmpeg/ffprobe version mismatch: ${runtimeVersion} vs ${version}`);
  runtimeVersion = version;
  executables[name] = { path: `runtime/${filename}`, sha256: sha256(target) };
}

const noticeName = ['NOTICES.md', 'LICENSE', 'LICENSE.txt', 'LICENSE.md'].find((name) => fs.existsSync(path.join(path.resolve(sourceRuntimeDir), name)));
if (!noticeName) throw new Error('The ffmpeg runtime must include NOTICES.md or a LICENSE file');
fs.copyFileSync(path.join(path.resolve(sourceRuntimeDir), noticeName), path.join(runtimeDir, noticeName));

const manifest = {
  ...sourceManifest,
  entrypoints: { ...sourceManifest.entrypoints, piExtensions: ['extensions/pi-video/index.js'] },
  contributes: {
    ...sourceManifest.contributes,
    nativeRuntimes: [{
      id: 'ffmpeg',
      kind: 'ffmpeg',
      platform: process.platform,
      arch: process.arch,
      version: runtimeVersion,
      executables,
      notices: `runtime/${noticeName}`,
    }],
  },
};
fs.writeFileSync(path.join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const outputDir = path.join(root, 'release', 'modules');
fs.mkdirSync(outputDir, { recursive: true });
const archivePath = path.join(outputDir, `transportx-video-${sourceManifest.version}-${process.platform}-${process.arch}.zip`);
const zip = new yazl.ZipFile();
const addTree = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) addTree(absolute);
    else zip.addFile(absolute, path.relative(buildRoot, absolute).split(path.sep).join('/'), { mode: fs.statSync(absolute).mode });
  }
};
addTree(packageRoot);
zip.end();
await new Promise((resolve, reject) => {
  const output = fs.createWriteStream(archivePath);
  zip.outputStream.once('error', reject);
  output.once('error', reject);
  output.once('close', resolve);
  zip.outputStream.pipe(output);
});
console.log(`Created ${archivePath} (Video Capability ${sourceManifest.version}, ffmpeg ${runtimeVersion}, ${process.platform}/${process.arch})`);
