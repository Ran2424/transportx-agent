const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yazl = require('yazl');

const { ModuleInstaller, validateModulePackage } = require('../bin/module-installer.js');
const { ModuleRegistry } = require('../bin/module-registry.js');

function temp(t: any, prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeAggregatePackage(root: string, id = 'local.aggregate.test', version = '1.0.0') {
  for (const file of ['skill/SKILL.md', 'extension/index.js', 'data/catalog.sqlite', 'knowledge/original.txt']) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file);
  }
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'knowledge', 'original.txt'))).digest('hex');
  fs.writeFileSync(path.join(root, 'knowledge', 'SHA256SUMS.txt'), `${digest}  original.txt\n`);
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    manifestVersion: 2, id, name: 'Aggregate test', version, type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [],
    entrypoints: { skills: ['skill/SKILL.md'], piExtensions: ['extension/index.js'] },
    contributes: { assets: [{ id: 'data:test', kind: 'data', path: 'data' }, { id: 'knowledge:test', kind: 'knowledge', path: 'knowledge', integrityFile: 'knowledge/SHA256SUMS.txt' }] },
  }));
}

function archivePackageEntries(id: string, version: string, name = 'Archive test') {
  return [
    { path: `${id}/${version}/manifest.json`, content: JSON.stringify({ manifestVersion: 2, id, name, version, type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [], entrypoints: { skills: ['skill/SKILL.md'] } }) },
    { path: `${id}/${version}/skill/SKILL.md`, content: `# ${name}` },
  ];
}

function writeArchive(filePath: string, entries: Array<{ path: string; content: string }>) {
  return new Promise<void>((resolve, reject) => {
    const archive = new yazl.ZipFile();
    for (const entry of entries) archive.addBuffer(Buffer.from(entry.content), entry.path);
    const output = fs.createWriteStream(filePath);
    output.on('close', resolve);
    output.on('error', reject);
    archive.outputStream.on('error', reject).pipe(output);
    archive.end();
  });
}

test('an aggregate Module installs Skill, extension, data and knowledge into a versioned package root', (t: any) => {
  const root = temp(t, 'transportx-module-install-');
  const source = path.join(root, 'source');
  const managed = path.join(root, 'managed');
  writeAggregatePackage(source);
  fs.writeFileSync(path.join(source, '.DS_Store'), 'finder metadata');
  const installer = new ModuleInstaller(managed);
  const installed = installer.install(source);
  assert.equal(installed.path, path.join(managed, 'local.aggregate.test', '1.0.0'));
  assert.equal(fs.existsSync(path.join(installed.path, 'data/catalog.sqlite')), true);
  assert.equal(fs.existsSync(path.join(installed.path, '.DS_Store')), false);
  const registry = new ModuleRegistry('3.0.0').load(installer.sources());
  assert.equal(registry.get(installed.id).origin, 'installed');
  installer.uninstall(installed.id, registry);
  assert.equal(fs.existsSync(path.join(managed, installed.id)), false);
});

test('native runtime entries are installed only when executable checksums match', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, (t: any) => {
  const root = temp(t, 'transportx-native-runtime-');
  const source = path.join(root, 'source');
  const managed = path.join(root, 'managed');
  fs.mkdirSync(path.join(source, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(source, 'runtime', 'ffmpeg'), 'ffmpeg-binary');
  fs.writeFileSync(path.join(source, 'runtime', 'ffprobe'), 'ffprobe-binary');
  fs.writeFileSync(path.join(source, 'runtime', 'NOTICES.md'), 'FFmpeg notices');
  const hash = (name: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(source, 'runtime', name))).digest('hex');
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({
    manifestVersion: 2, id: 'com.transportx.video', name: 'Video Capability', version: '1.3.0', type: 'capability', platformVersion: '>=3.0.0 <4.0.0', dependencies: [],
    contributes: { nativeRuntimes: [{ id: 'ffmpeg', kind: 'ffmpeg', platform: 'darwin', arch: 'arm64', version: '8.0', executables: { ffmpeg: { path: 'runtime/ffmpeg', sha256: hash('ffmpeg') }, ffprobe: { path: 'runtime/ffprobe', sha256: hash('ffprobe') } }, notices: 'runtime/NOTICES.md' }] },
  }));
  const installed = new ModuleInstaller(managed).install(source);
  assert.equal(fs.existsSync(path.join(installed.path, 'runtime', 'ffmpeg')), true);
  assert.notEqual(fs.statSync(path.join(installed.path, 'runtime', 'ffmpeg')).mode & 0o111, 0);
  fs.writeFileSync(path.join(source, 'runtime', 'ffmpeg'), 'tampered');
  assert.throws(() => validateModulePackage(source, JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'))), /checksum mismatch/);
});

test('legacy v1 packages migrate once to the versioned v2 store', (t: any) => {
  const root = temp(t, 'transportx-module-migrate-');
  const managed = path.join(root, 'managed');
  const legacy = path.join(managed, 'local.knowledge.traffic');
  fs.mkdirSync(path.join(legacy, 'asset'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'asset', 'source.pdf'), 'verified');
  const digest = crypto.createHash('sha256').update('verified').digest('hex');
  fs.writeFileSync(path.join(legacy, 'asset', 'SHA256SUMS.txt'), `${digest}  source.pdf\n`);
  fs.writeFileSync(path.join(legacy, 'manifest.json'), JSON.stringify({ manifestVersion: 1, id: 'local.knowledge.traffic', name: 'Traffic', version: '1.0.0', type: 'knowledge', platformVersion: '>=3.0.0 <4.0.0', dependencies: [], contributes: { assets: [{ id: 'knowledge:traffic', kind: 'knowledge', path: 'asset', integrityFile: 'asset/SHA256SUMS.txt' }] } }));
  const installer = new ModuleInstaller(managed);
  installer.migrateLegacyPackages();
  const source = installer.sources()[0];
  assert.equal(source.moduleId, 'local.knowledge.traffic');
  const manifest = JSON.parse(fs.readFileSync(source.manifestPath, 'utf8'));
  assert.equal(manifest.manifestVersion, 2);
  assert.equal(manifest.type, 'module');
  validateModulePackage(source.packageRoot!, manifest);
});

test('installer rejects loose resources, unsafe paths, symlinks and duplicate versions', (t: any) => {
  const root = temp(t, 'transportx-module-safety-');
  const managed = path.join(root, 'managed');
  const installer = new ModuleInstaller(managed);
  const loose = path.join(root, 'loose-skill');
  fs.mkdirSync(loose);
  fs.writeFileSync(path.join(loose, 'SKILL.md'), '# Loose');
  assert.throws(() => installer.install(loose), /manifest\.json/);
  assert.throws(() => installer.install(loose, 'skill' as never), /Only self-contained Module packages/);

  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ manifestVersion: 2, id: 'local.escape', name: 'Escape', version: '1.0.0', type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [], entrypoints: { skills: ['../outside/SKILL.md'] } }));
  assert.throws(() => installer.install(source), /escapes/);
  writeAggregatePackage(source, 'local.safe');
  fs.symlinkSync(path.join(source, 'manifest.json'), path.join(source, 'link.json'));
  assert.throws(() => installer.install(source), /symbolic links/);
  fs.unlinkSync(path.join(source, 'link.json'));
  installer.install(source);
  assert.throws(() => installer.install(source), /already installed/);
});

test('catalog exposes every installed version and selections resolve exactly', (t: any) => {
  const root = temp(t, 'transportx-module-catalog-');
  const managed = path.join(root, 'managed');
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  writeAggregatePackage(first, 'local.catalog', '1.0.0');
  writeAggregatePackage(second, 'local.catalog', '2.0.0');
  const installer = new ModuleInstaller(managed);
  installer.install(first);
  installer.install(second);
  assert.deepEqual(installer.catalog().map((entry: any) => entry.version), ['1.0.0', '2.0.0']);
  const selected = installer.sourcesForSelections([{ id: 'local.catalog', version: '1.0.0' }]);
  assert.match(selected[0].manifestPath, /1\.0\.0\/manifest\.json$/);
  assert.match(installer.sources()[0].manifestPath, /2\.0\.0\/manifest\.json$/);
  assert.throws(() => installer.sourcesForSelections([{ id: 'local.catalog', version: '3.0.0' }]), /not installed/);
});

test('enabled modules and exact selections automatically include installed dependencies', (t: any) => {
  const root = temp(t, 'transportx-module-dependencies-');
  const managed = path.join(root, 'managed');
  const installer = new ModuleInstaller(managed);
  for (const [id, dependencies] of [
    ['com.transportx.video', []],
    ['local.video-data', ['com.transportx.video']],
    ['local.unrelated', []],
  ] as const) {
    const source = path.join(root, id);
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({
      manifestVersion: 2,
      id,
      name: id,
      version: '1.0.0',
      type: 'module',
      platformVersion: '>=3.0.0 <4.0.0',
      dependencies,
    }));
    installer.install(source);
  }

  const enabled = installer.sourcesForEnabledModules(['local.video-data']);
  assert.equal(enabled.find((source: any) => source.moduleId === 'local.video-data').enabled, true);
  assert.equal(enabled.find((source: any) => source.moduleId === 'com.transportx.video').enabled, true);
  assert.equal(enabled.find((source: any) => source.moduleId === 'local.unrelated').enabled, false);
  const registry = new ModuleRegistry('3.0.0').load(enabled);
  assert.deepEqual(registry.errors, []);
  assert.deepEqual(registry.dependencyOrder('local.video-data').map((module: any) => module.manifest.id), ['com.transportx.video', 'local.video-data']);

  const selected = installer.sourcesForSelectionsWithDependencies([{ id: 'local.video-data', version: '1.0.0' }]);
  assert.deepEqual(selected.map((source: any) => source.moduleId).sort(), ['com.transportx.video', 'local.video-data']);
});

test('ZIP archives are previewed before selected Module packages are installed', async (t: any) => {
  const root = temp(t, 'transportx-module-archive-');
  const managed = path.join(root, 'managed');
  const archive = path.join(root, 'modules.zip');
  await writeArchive(archive, [
    ...archivePackageEntries('local.archive.first', '1.0.0', 'First archive module'),
    ...archivePackageEntries('local.archive.second', '2.0.0', 'Second archive module'),
    ...archivePackageEntries('local.archive.conflict', '1.0.0', 'Conflicting archive module'),
    { path: '__MACOSX/._local.archive.first', content: 'finder metadata' },
  ]);
  const installer = new ModuleInstaller(managed);
  const preview = await installer.inspectArchive(archive, new Set(['local.archive.conflict']));
  assert.equal(preview.modules.length, 3);
  assert.equal(preview.modules.find((module: any) => module.id === 'local.archive.first').status, 'ready');
  assert.equal(preview.modules.find((module: any) => module.id === 'local.archive.conflict').status, 'conflict');
  const installed = await installer.installArchive(preview.importId, [{ id: 'local.archive.second', version: '2.0.0' }]);
  assert.deepEqual(installed.map((module: any) => module.id), ['local.archive.second']);
  assert.equal(fs.existsSync(path.join(managed, 'local.archive.second', '2.0.0', 'skill', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(managed, 'local.archive.first')), false);
  assert.equal(fs.readdirSync(path.join(managed, '.imports')).length, 0);

  const repeated = await installer.inspectArchive(archive);
  assert.equal(repeated.modules.find((module: any) => module.id === 'local.archive.second').status, 'installed');
});

test('ZIP preview rejects invalid package paths before installation', async (t: any) => {
  const root = temp(t, 'transportx-module-archive-invalid-');
  const archive = path.join(root, 'invalid.zip');
  await writeArchive(archive, [
    { path: 'local.archive.path/1.0.0/manifest.json', content: JSON.stringify({ manifestVersion: 2, id: 'local.archive.other', name: 'Wrong path', version: '1.0.0', type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [] }) },
  ]);
  const preview = await new ModuleInstaller(path.join(root, 'managed')).inspectArchive(archive);
  assert.equal(preview.modules[0].status, 'invalid');
  assert.match(preview.modules[0].message, /Archive path/);
});
