import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { getPlatformProfile } from './platform-profile.mjs';

const BUCKET = 'oss://transportx-agent/';
const ROOT = path.resolve(import.meta.dirname, '../..');
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function isNewer(version, previous) {
  const left = version.split('.').map(Number), right = previous.split('.').map(Number);
  const different = left.findIndex((value, index) => value !== right[index]);
  return different >= 0 && left[different] > right[different];
}

function digest(file, algorithm, encoding = 'hex') {
  return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);
}

export function createReleasePlan(directory, version, profile) {
  if (!stableVersion.test(version)) throw new Error('A stable SemVer version is required');
  const manifestPath = path.join(directory, profile.update.manifest);
  const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest?.version !== version || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Missing or mixed-version update manifest');
  if (typeof manifest.releaseNotes !== 'string' || !manifest.releaseNotes.trim()) throw new Error('Release notes are required');
  const files = [];
  for (const entry of manifest.files) {
    if (typeof entry.url !== 'string' || !profile.update.requiredExtensions.some((extension) => entry.url === profile.update.artifactName.replace('${version}', version).replace('${ext}', extension.slice(1)))) throw new Error('Unexpected version, architecture or artifact name');
    const source = path.join(directory, entry.url);
    if (!fs.lstatSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) throw new Error('Artifacts must be regular files');
    const size = fs.statSync(source).size;
    if (!Number.isSafeInteger(entry.size) || entry.size !== size || digest(source, 'sha512', 'base64') !== entry.sha512) throw new Error(`Artifact size or SHA-512 mismatch: ${entry.url}`);
    files.push({ source, name: entry.url, size, sha256: digest(source, 'sha256') });
    const blockmap = `${source}.blockmap`;
    if (fs.existsSync(blockmap)) {
      if (!fs.lstatSync(blockmap).isFile() || fs.lstatSync(blockmap).isSymbolicLink()) throw new Error('Invalid blockmap');
      files.push({ source: blockmap, name: `${entry.url}.blockmap`, size: fs.statSync(blockmap).size, sha256: digest(blockmap, 'sha256') });
    }
  }
  for (const extension of profile.update.requiredExtensions) {
    if (!files.some((file) => file.name.endsWith(extension))) throw new Error(`Missing ${extension} update artifact`);
  }
  if (new Set(files.map((file) => file.name)).size !== files.length) throw new Error('Duplicate manifest artifacts');
  return { version, profile: profile.key, update: profile.update, manifestPath, files };
}

// Immutable packages are verified before the mutable discovery manifest is
// changed. Adapters make upload failure/order testable without credentials.
export async function publishRelease(plan, io) {
  const previous = await io.readManifest();
  if (previous) {
    const current = yaml.load(previous)?.version;
    if (!stableVersion.test(current || '')) throw new Error('Invalid live manifest version');
    if (!isNewer(plan.version, current)) throw new Error('Release must be newer than the live manifest');
  }
  const manualDirectory = `releases/v${plan.version}/`;
  const generated = (name, content) => ({ name, content, size: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex'), objectKey: `${manualDirectory}${name}` });
  const immutable = [
    ...plan.files.map((file) => ({ ...file, objectKey: `${plan.update.directory}${file.name}` })),
    ...plan.files.map((file) => ({ ...file, objectKey: `${manualDirectory}${file.name}` })),
    ...plan.files.map((file) => generated(`${file.name}.sha256`, `${file.sha256}  ${file.name}\n`)),
    generated(`release-notes-${plan.profile}.md`, yaml.load(fs.readFileSync(plan.manifestPath, 'utf8')).releaseNotes + '\n'),
  ];
  await io.record({ stage: 'prepared', previousManifest: previous, version: plan.version, profile: plan.profile, files: immutable });
  for (const file of immutable) {
    await io.assertAbsent(file.objectKey);
  }
  for (const file of immutable) {
    await io.upload(file, false);
    await io.verify(file, false);
  }
  // Refuse another publisher's changed manifest. CI must also serialize jobs.
  if (await io.readManifest() !== previous) throw new Error('Live manifest changed during publication');
  const file = { source: plan.manifestPath, name: plan.update.manifest, objectKey: `${plan.update.directory}${plan.update.manifest}`, size: fs.statSync(plan.manifestPath).size, sha256: digest(plan.manifestPath, 'sha256') };
  await io.upload(file, true);
  await io.verify(file, true);
  await io.record({ stage: 'published', version: plan.version, profile: plan.profile, previousManifest: previous, files: [...immutable, file] });
}

export function assertAcceptance(plan, acceptance, sourceRevision) {
  if (acceptance.version !== plan.version || acceptance.profile !== plan.profile || acceptance.sourceRevision !== sourceRevision || !/^[a-f0-9]{40}$/.test(sourceRevision) || acceptance.signed !== true || acceptance.upgradePassed !== true || acceptance.dataPreserved !== true || acceptance.normalQuitDoesNotInstall !== true) throw new Error('Signed cross-version acceptance is incomplete or belongs to another source commit');
  if (!stableVersion.test(acceptance.testedFromVersion || '') || !isNewer(plan.version, acceptance.testedFromVersion) || !acceptance.testedBy || !acceptance.signingIdentity || !Array.isArray(acceptance.evidence) || !acceptance.evidence.length || !Number.isFinite(Date.parse(acceptance.testedAt))) throw new Error('Acceptance evidence and previous version are required');
  for (const file of plan.files) if (acceptance.sha256?.[file.name] !== file.sha256) throw new Error('Acceptance does not match the artifacts');
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'Cache-Control': 'no-cache', ...options.headers } });
  if (!response.ok && response.status !== 404) throw new Error(`Release endpoint returned HTTP ${response.status}`);
  return response;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => args[args.indexOf(name) + 1];
  if (!args.includes('--version') || !args.includes('--platform')) throw new Error('Usage: release:oss -- --version X.Y.Z --platform mac|win [--publish]');
  const profile = getPlatformProfile(option('--platform'));
  const version = option('--version');
  const directory = path.join(ROOT, 'release');
  const plan = createReleasePlan(directory, version, profile);
  const packageVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const hostVersion = fs.readFileSync(path.join(ROOT, 'src/server/config.ts'), 'utf8').match(/PLATFORM_VERSION = '([^']+)'/)?.[1];
  if (version !== packageVersion || version !== hostVersion) throw new Error('Package, Host and release versions must match');
  if (!args.includes('--publish')) {
    console.log(JSON.stringify({ ...plan, mode: 'dry-run' }, null, 2));
    return;
  }
  if (getPlatformProfile().key !== profile.key) throw new Error('Publish signed artifacts on their native build host');
  // Formal publication requires the checked-in release entry, and a platform
  // upgrade acceptance record tied to these exact artifact hashes.
  const changelog = fs.readFileSync(path.join(ROOT, 'docs/CHANGELOG.md'), 'utf8');
  if (!changelog.includes(`\n## ${version} - `)) throw new Error('A dated CHANGELOG release entry is required');
  const acceptance = JSON.parse(fs.readFileSync(path.join(directory, `acceptance-${version}-${profile.key}.json`), 'utf8'));
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim();
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' });
  if (status.status !== 0 || status.stdout.trim()) throw new Error('Release source must be a clean checkout');
  assertAcceptance(plan, acceptance, revision);
  const toolVersion = spawnSync('ossutil', ['version'], { encoding: 'utf8' });
  if (toolVersion.status !== 0 || !/^2\./.test(toolVersion.stdout.trim())) throw new Error('ossutil 2.x is required');
  const recordPath = path.join(directory, `publication-${version}-${profile.key}.json`);
  const origin = new URL(plan.update.url).origin;
  const urlFor = (objectKey) => `${origin}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
  const io = {
    async readManifest() { const response = await request(urlFor(plan.update.directory + profile.update.manifest)); return response.status === 404 ? null : response.text(); },
    async assertAbsent(objectKey) {
      const response = await request(urlFor(objectKey), { method: 'HEAD' });
      if (response.status !== 404) throw new Error(`Refusing to overwrite ${objectKey}`);
    },
    async upload(file, manifest) {
      const destination = `${BUCKET}${file.objectKey}`;
      const generatedFile = path.join(directory, file.name);
      if (file.content !== undefined) fs.writeFileSync(generatedFile, file.content);
      const result = spawnSync('ossutil', ['cp', file.source || generatedFile, destination, '--acl', 'public-read', '--metadata', `transportx-sha256=${file.sha256}`, '--cache-control', manifest ? 'no-cache' : 'public,max-age=31536000,immutable', manifest ? '--force' : '--ignore-existing'], { stdio: 'ignore' });
      if (result.status !== 0) throw new Error(`OSS upload failed: ${file.name}`);
    },
    async verify(file, manifest) {
      const url = urlFor(file.objectKey);
      const head = await request(url, { method: 'HEAD' });
      if (head.status !== 200 || Number(head.headers.get('content-length')) !== file.size) throw new Error(`Public object size mismatch: ${file.name}`);
      if (head.headers.get('x-oss-meta-transportx-sha256') !== file.sha256) throw new Error(`OSS upload integrity metadata mismatch: ${file.name}`);
      if (manifest && !head.headers.get('cache-control')?.includes('no-cache')) throw new Error('Manifest must use no-cache');
      const range = await request(url, { headers: { Range: 'bytes=0-0' } });
      await range.body?.cancel();
      if (range.status !== 206 || range.headers.get('content-range') !== `bytes 0-0/${file.size}`) throw new Error(`Range download unavailable: ${file.name}`);
    },
    async record(value) { fs.writeFileSync(recordPath, JSON.stringify({ ...value, sourceRevision: revision, recordedAt: new Date().toISOString() }, null, 2)); },
  };
  await publishRelease(plan, io);
  console.log(`Published ${version} for ${profile.label}. Record: ${recordPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`[release:oss] ${error.message}`); process.exitCode = 1; });
}
