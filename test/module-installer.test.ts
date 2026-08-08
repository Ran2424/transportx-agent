const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ModuleInstaller } = require('../bin/module-installer.js');
const { ModuleRegistry } = require('../bin/module-registry.js');

function temp(t: any, prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('an aggregate module installs Skill, extension, data and knowledge as one managed package', (t: any) => {
  const root = temp(t, 'transportx-module-install-');
  const source = path.join(root, 'source');
  const managed = path.join(root, 'managed');
  for (const file of ['skill/SKILL.md', 'extension/index.js', 'data/catalog.sqlite', 'knowledge/SHA256SUMS.txt']) {
    const target = path.join(source, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file);
  }
  fs.writeFileSync(path.join(source, '.DS_Store'), 'finder metadata');
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({
    manifestVersion: 1, id: 'local.aggregate.test', name: 'Aggregate test', version: '1.0.0', type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [],
    entrypoints: { skills: ['skill/SKILL.md'], piExtensions: ['extension/index.js'] },
    contributes: { assets: [{ id: 'data:test', kind: 'data', path: 'data' }, { id: 'knowledge:test', kind: 'knowledge', path: 'knowledge', integrityFile: 'knowledge/SHA256SUMS.txt' }] },
  }));
  const installer = new ModuleInstaller(managed);
  const installed = installer.install(source);
  assert.equal(installed.id, 'local.aggregate.test');
  assert.equal(fs.existsSync(path.join(installed.path, 'data/catalog.sqlite')), true);
  assert.equal(fs.existsSync(path.join(installed.path, '.DS_Store')), false);
  const registry = new ModuleRegistry('3.0.0').load(installer.sources());
  assert.equal(registry.get(installed.id).origin, 'installed');
  installer.uninstall(installed.id, registry);
  assert.equal(fs.existsSync(installed.path), false);
});

test('standalone resources are wrapped in managed one-contribution modules', (t: any) => {
  const root = temp(t, 'transportx-standalone-install-');
  const installer = new ModuleInstaller(path.join(root, 'managed'));
  const fixtures: Record<string, string> = { skill: 'skill/SKILL.md', extension: 'extension/index.ts', data: 'data/catalog.sqlite', knowledge: 'knowledge/documents.jsonl' };
  for (const [kind, relative] of Object.entries(fixtures)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, kind);
    const installed = installer.install(kind === 'skill' || kind === 'extension' ? path.dirname(target) : target, kind);
    assert.equal(fs.existsSync(path.join(installed.path, 'manifest.json')), true);
  }
  assert.equal(installer.sources().length, 4);
});

test('module installation rejects path escape, symlinks and duplicate ids', (t: any) => {
  const root = temp(t, 'transportx-module-safety-');
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ manifestVersion: 1, id: 'local.escape', name: 'Escape', version: '1.0.0', type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [], entrypoints: { skills: ['../outside/SKILL.md'] } }));
  const installer = new ModuleInstaller(path.join(root, 'managed'));
  assert.throws(() => installer.install(source), /escapes/);
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ manifestVersion: 1, id: 'local.safe', name: 'Safe', version: '1.0.0', type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [] }));
  fs.symlinkSync(path.join(source, 'manifest.json'), path.join(source, 'link.json'));
  assert.throws(() => installer.install(source), /symbolic links/);
  fs.unlinkSync(path.join(source, 'link.json'));
  installer.install(source);
  assert.throws(() => installer.install(source), /already installed/);
  assert.throws(() => installer.install(source, 'unknown' as any), /Unsupported install kind/);
});
