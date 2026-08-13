const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
