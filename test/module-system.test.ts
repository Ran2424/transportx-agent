const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ModuleRegistry } = require('../bin/module-registry.js');
const { AssetResolver } = require('../bin/asset-resolver.js');
const { SessionAssembler } = require('../bin/session-assembly.js');

const ROOT = process.cwd();
const MANIFESTS = [
  'modules/capabilities/web-bridge/manifest.json',
  'modules/capabilities/task/manifest.json',
  'modules/capabilities/citation/manifest.json',
  'modules/capabilities/geo/manifest.json',
  'modules/official/traffic-skills/manifest.json',
  'modules/official/traffic-knowledge/manifest.json',
  'modules/official/traffic-data/manifest.json',
  'modules/official/traffic-report/manifest.json',
  'modules/official/traffic-assurance/manifest.json',
];

function registry(extra: Array<{ manifestPath: string; packageRoot?: string; origin?: 'builtin' | 'installed' | 'external' }> = []) {
  return new ModuleRegistry('3.0.0').load([
    ...MANIFESTS.map((manifestPath) => ({ manifestPath: path.join(ROOT, manifestPath), packageRoot: /traffic-(?:data|knowledge)\/manifest\.json$/.test(manifestPath) ? path.join(ROOT, path.dirname(manifestPath)) : ROOT, origin: 'builtin' })),
    ...extra,
  ]);
}

test('official manifests register all current capabilities without hard-coded assembly', () => {
  const modules = registry();
  assert.deepEqual(modules.errors, []);
  assert.equal(modules.enabled().length, 9);
  const order = modules.dependencyOrder('com.transportx.traffic-assurance');
  assert.equal(order.at(-1).manifest.type, 'domain');
  assert.ok(order.some((item: any) => item.manifest.id === 'com.transportx.geo'));
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
  const plan = assembler.assemble('com.transportx.traffic-assurance', workspace);
  assert.equal(plan.piExtensions.length, 4);
  assert.equal(plan.skills.length, 5);
  assert.ok(plan.assets.some((asset: any) => asset.id === 'data:installed-test'));
  assert.ok(plan.assets.some((asset: any) => asset.id === 'template:traffic-analysis-report'));
  assert.ok(plan.modules.some((module: any) => module.id === 'local.installed.test'));
  const saved = assembler.save(plan);
  assert.equal(JSON.parse(fs.readFileSync(saved, 'utf8')).domain.id, 'com.transportx.traffic-assurance');
});

test('Session Assembly prefers one installed asset and rejects ambiguous peers', (t: any) => {
  const roots = ['one', 'two'].map((name) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `transportx-${name}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'asset'));
    fs.writeFileSync(path.join(root, 'asset', 'catalog.sqlite'), name);
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ manifestVersion: 1, id: `local.data.${name}`, name, version: '1.0.0', type: 'data', platformVersion: '>=3.0.0 <4.0.0', dependencies: [], contributes: { assets: [{ id: `data:${name}`, kind: 'data', path: 'asset' }] } }));
    return root;
  });
  const one = registry([{ manifestPath: path.join(roots[0], 'manifest.json'), packageRoot: roots[0], origin: 'installed' }]);
  const selected = new SessionAssembler(one, new AssetResolver(one), '3.0.0', { command: 'node', args: [] }, { command: 'python', args: [] }).assemble('com.transportx.traffic-assurance', roots[0]);
  assert.equal(selected.assets.find((asset: any) => asset.kind === 'data').id, 'data:one');
  const two = registry(roots.map((root) => ({ manifestPath: path.join(root, 'manifest.json'), packageRoot: root, origin: 'installed' as const })));
  assert.throws(() => new SessionAssembler(two, new AssetResolver(two), '3.0.0', { command: 'node', args: [] }, { command: 'python', args: [] }).assemble('com.transportx.traffic-assurance', roots[0]), /Multiple data assets/);
});

test('Session Assembly prefers unpacked Skill paths for packaged apps', (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-app-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packed = path.join(root, 'app.asar', 'skills', 'test', 'SKILL.md');
  const unpacked = path.join(root, 'app.asar.unpacked', 'skills', 'test', 'SKILL.md');
  fs.mkdirSync(path.dirname(packed), { recursive: true });
  fs.mkdirSync(path.dirname(unpacked), { recursive: true });
  fs.writeFileSync(packed, 'packed');
  fs.writeFileSync(unpacked, 'unpacked');
  const { preferUnpackedPath } = require('../bin/session-assembly.js');
  assert.equal(preferUnpackedPath(packed), unpacked);
});

test('data and knowledge tools require runtime-injected asset roots', () => {
  const dataScript = fs.readFileSync(path.join(ROOT, 'modules/official/traffic-data/skill/scripts/query_assets.py'), 'utf8');
  const knowledgeScript = fs.readFileSync(path.join(ROOT, 'modules/official/traffic-knowledge/skill/scripts/search_knowledge.py'), 'utf8');
  const geoExtension = fs.readFileSync(path.join(ROOT, 'extensions/pi-geo-visualization/index.ts'), 'utf8');
  assert.match(dataScript, /TRANSPORTX_TRAFFIC_DATA_ROOT or --data-root is required/);
  assert.match(dataScript, /--data-root/);
  assert.doesNotMatch(dataScript, /parents\[1\].*assets/);
  assert.match(knowledgeScript, /TRANSPORTX_KNOWLEDGE_ROOT or --knowledge-root is required/);
  assert.doesNotMatch(knowledgeScript, /parent\.parent.*references/);
  assert.match(geoExtension, /process\.env\.TRANSPORTX_TRAFFIC_DATA_ROOT/);
  assert.doesNotMatch(geoExtension, /TRAFFIC_SKILL_DIR, 'assets', 'databases'/);
  assert.doesNotMatch(geoExtension, /PROJECT_SKILLS_DIR, 'shanghai-traffic-data-assets'/);
});

test('a broken optional module is recorded without blocking official modules', (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-broken-module-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, 'manifest.json');
  fs.writeFileSync(manifestPath, '{broken');
  const modules = registry([{ manifestPath }]);
  assert.equal(modules.errors.length, 1);
  assert.equal(modules.get('com.transportx.traffic-assurance').enabled, true);
});
