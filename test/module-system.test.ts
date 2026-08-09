const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ModuleRegistry } = require('../bin/module-registry.js');
const { AssetResolver } = require('../bin/asset-resolver.js');
const { SessionAssembler } = require('../bin/session-assembly.js');
const { ModuleInstaller } = require('../bin/module-installer.js');

const ROOT = process.cwd();
const MANIFESTS = [
  'modules/capabilities/web-bridge/manifest.json',
  'modules/capabilities/task/manifest.json',
  'modules/capabilities/citation/manifest.json',
  'modules/capabilities/geo/manifest.json',
  'modules/official/traffic-report/manifest.json',
  'modules/official/workbench/manifest.json',
];
const INSTALLABLE_MODULES = [
  'modules/installable/shanghaidata/manifest.json',
  'modules/installable/traffic-assurance-knowledge/manifest.json',
  'modules/installable/plot-style/manifest.json',
];

function registry(extra: Array<{ manifestPath: string; packageRoot?: string; origin?: 'builtin' | 'installed' | 'external' }> = []) {
  return new ModuleRegistry('3.0.0').load([
    ...MANIFESTS.map((manifestPath) => ({ manifestPath: path.join(ROOT, manifestPath), packageRoot: ROOT, origin: 'builtin' })),
    ...extra,
  ]);
}

test('built-in manifests register only platform capabilities', () => {
  const modules = registry();
  assert.deepEqual(modules.errors, []);
  assert.equal(modules.enabled().length, 6);
  assert.equal(modules.get('com.transportx.shanghaidata'), undefined);
  assert.equal(modules.get('com.transportx.traffic-assurance-knowledge'), undefined);
  const order = modules.dependencyOrder('com.transportx.workbench');
  assert.equal(order.at(-1).manifest.type, 'domain');
  assert.ok(order.some((item: any) => item.manifest.id === 'com.transportx.geo'));
});

test('data, knowledge and plot-style packages install independently from the platform', (t: any) => {
  const managed = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-installable-modules-'));
  t.after(() => fs.rmSync(managed, { recursive: true, force: true }));
  const installer = new ModuleInstaller(managed);
  for (const manifestPath of INSTALLABLE_MODULES) installer.install(path.join(ROOT, path.dirname(manifestPath)));
  const modules = registry(installer.sources());
  assert.deepEqual(modules.errors, []);
  assert.equal(modules.get('com.transportx.shanghaidata').origin, 'installed');
  assert.equal(modules.get('com.transportx.traffic-assurance-knowledge').origin, 'installed');
  assert.equal(modules.get('com.transportx.plot-style').origin, 'installed');
  assert.deepEqual(modules.get('com.transportx.shanghaidata').manifest.dependencies, ['com.transportx.geo']);
  assert.deepEqual(modules.get('com.transportx.traffic-assurance-knowledge').manifest.dependencies, ['com.transportx.citation']);
  const plan = new SessionAssembler(modules, new AssetResolver(modules), '3.0.0', { command: 'node', args: [] }, { command: 'python', args: [] }).assemble('com.transportx.workbench', managed);
  assert.equal(plan.skills.length, 4);
  assert.equal(plan.assets.some((asset: any) => asset.kind === 'data' || asset.kind === 'knowledge'), false);
});

test('Session Assembly resolves extensions, skills, assets and persists a versioned plan', (t: any) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-plan-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-installed-module-'));
  t.after(() => fs.rmSync(installed, { recursive: true, force: true }));
  fs.mkdirSync(path.join(installed, 'skill'));
  fs.mkdirSync(path.join(installed, 'data'));
  fs.writeFileSync(path.join(installed, 'skill', 'SKILL.md'), '# Installed Skill');
  fs.writeFileSync(path.join(installed, 'data', 'catalog.sqlite'), 'fixture');
  fs.writeFileSync(path.join(installed, 'manifest.json'), JSON.stringify({ manifestVersion: 1, id: 'local.installed.test', name: 'Installed test', version: '1.0.0', type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [], entrypoints: { skills: ['skill/SKILL.md'] }, contributes: { assets: [{ id: 'data:installed-test', kind: 'data', path: 'data' }] } }));
  const modules = registry([{ manifestPath: path.join(installed, 'manifest.json'), packageRoot: installed, origin: 'installed' }]);
  const assembler = new SessionAssembler(modules, new AssetResolver(modules), '3.0.0', { command: 'node', args: [], version: '0.80.10' }, { command: 'python', args: [], version: '3.10' });
  const plan = assembler.assemble('com.transportx.workbench', workspace);
  assert.equal(plan.piExtensions.length, 4);
  assert.equal(plan.skills.length, 2);
  assert.ok(plan.assets.some((asset: any) => asset.id === 'data:installed-test'));
  assert.ok(plan.assets.some((asset: any) => asset.id === 'template:traffic-analysis-report'));
  assert.ok(plan.modules.some((module: any) => module.id === 'local.installed.test'));
  const saved = assembler.save(plan);
  assert.equal(JSON.parse(fs.readFileSync(saved, 'utf8')).domain.id, 'com.transportx.workbench');
});

test('a broken optional module is recorded without blocking built-in modules', (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-broken-module-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, '{broken');
  const modules = registry([{ manifestPath }]);
  assert.equal(modules.errors.length, 1);
  assert.equal(modules.get('com.transportx.workbench').enabled, true);
});
