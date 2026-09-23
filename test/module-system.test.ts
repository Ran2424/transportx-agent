const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ModuleRegistry, moduleRuntimeCompatible } = require('../bin/module-registry.js');
const { AssetResolver } = require('../bin/asset-resolver.js');
const { SessionAssembler, SessionPlanError, planExtensions, planSkills } = require('../bin/session-assembly.js');
const { ModuleInstaller } = require('../bin/module-installer.js');
const { renderProjectPrompt } = require('../bin/session-prompt.js');

const ROOT = process.cwd();
const MANIFESTS = [
  'modules/capabilities/web-bridge/manifest.json',
  'modules/capabilities/task/manifest.json',
  'modules/capabilities/citation/manifest.json',
  'modules/capabilities/canvas/manifest.json',
  'modules/capabilities/document/manifest.json',
  'modules/capabilities/geo/manifest.json',
  'modules/capabilities/spatial-analysis/manifest.json',
  'modules/official/traffic-report/manifest.json',
  'modules/official/module-authoring/manifest.json',
  'modules/official/cli/manifest.json',
  'modules/official/workbench/manifest.json',
];
function registry(extra: Array<{ manifestPath: string; packageRoot?: string; origin?: 'builtin' | 'installed' | 'external' }> = []) {
  return new ModuleRegistry('3.0.0').load([
    ...MANIFESTS.map((manifestPath) => ({ manifestPath: path.join(ROOT, manifestPath), packageRoot: path.join(ROOT, path.dirname(manifestPath)), origin: 'builtin' })),
    ...extra,
  ]);
}

function writeInstallableModule(root: string, directoryName: string, manifest: any) {
  const packageRoot = path.join(root, directoryName);
  fs.mkdirSync(path.join(packageRoot, 'skill'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'skill', 'SKILL.md'), `# ${manifest.name}\n`);
  fs.writeFileSync(path.join(packageRoot, 'manifest.json'), `${JSON.stringify({
    manifestVersion: 2,
    type: 'module',
    platformVersion: '>=3.0.0 <4.0.0',
    entrypoints: { skills: ['skill/SKILL.md'] },
    contributes: {},
    ...manifest,
  }, null, 2)}\n`);
  return packageRoot;
}

test('built-in manifests register only platform capabilities', () => {
  const modules = registry();
  assert.deepEqual(modules.errors, []);
  assert.equal(modules.enabled().length, 11);
  assert.equal(modules.get('com.transportx.shanghaidata'), undefined);
  assert.equal(modules.get('com.transportx.traffic-assurance-knowledge'), undefined);
  const order = modules.dependencyOrder('com.transportx.workbench');
  assert.equal(order.at(-1).manifest.type, 'domain');
  assert.ok(order.some((item: any) => item.manifest.id === 'com.transportx.geo'));
});

test('required native runtimes are compatible only with their declared platform and architecture', () => {
  const manifest = {
    contributes: {
      requiredNativeRuntimes: ['ffmpeg'],
      nativeRuntimes: [{ id: 'ffmpeg', platform: 'darwin', arch: 'arm64' }],
    },
  };
  assert.equal(moduleRuntimeCompatible(manifest, 'darwin', 'arm64').compatible, true);
  assert.deepEqual(moduleRuntimeCompatible(manifest, 'win32', 'x64'), { compatible: false, missingRuntime: 'ffmpeg' });
});

test('CLI domain loads only explicitly selected capabilities', () => {
  const modules = registry();
  const assembler = new SessionAssembler(modules, new AssetResolver(modules), '3.0.0', { command: 'node', args: [] }, { command: 'python', args: [] });
  const profile = {
    schemaVersion: 1,
    task: { kind: 'data-query', expectedOutputs: ['answer'] },
    modules: { selectionMode: 'explicit', selected: [{ id: 'com.transportx.citation', version: '1.0.2' }] },
  };
  const plan = assembler.assemble('com.transportx.cli', process.cwd(), profile);
  assert.deepEqual(plan.modules.map((module: any) => module.id), ['com.transportx.cli', 'com.transportx.citation']);
  assert.equal(plan.modules.some((module: any) => module.id === 'com.transportx.geo'), false);
  assert.equal(plan.modules.some((module: any) => module.id === 'com.transportx.video'), false);
  const spatialPlan = assembler.assemble('com.transportx.cli', process.cwd(), {
    ...profile,
    modules: { selectionMode: 'explicit', selected: [{ id: 'com.transportx.spatial-analysis', version: '1.0.1' }] },
  });
  assert.deepEqual(spatialPlan.modules.map((module: any) => module.id), ['com.transportx.cli', 'com.transportx.canvas', 'com.transportx.geo', 'com.transportx.spatial-analysis']);
  assert.throws(() => assembler.assemble('com.transportx.cli', process.cwd(), {
    ...profile,
    modules: { selectionMode: 'explicit', selected: [{ id: 'com.transportx.citation', version: '9.9.9' }] },
  }), /version is unavailable/);
});

test('data, knowledge and plot-style packages install independently from the platform', (t: any) => {
  const managed = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-installable-modules-'));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-installable-module-sources-'));
  t.after(() => fs.rmSync(managed, { recursive: true, force: true }));
  t.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  const installableModules = [
    writeInstallableModule(sourceRoot, 'shanghaidata', { id: 'com.transportx.shanghaidata', name: 'Shanghai Data', version: '2.0.1', dependencies: ['com.transportx.geo'] }),
    writeInstallableModule(sourceRoot, 'traffic-assurance-knowledge', { id: 'com.transportx.traffic-assurance-knowledge', name: 'Traffic Assurance Knowledge', version: '1.0.0', dependencies: ['com.transportx.citation'] }),
    writeInstallableModule(sourceRoot, 'plot-style', { id: 'com.transportx.plot-style', name: 'Plot Style', version: '1.0.0', dependencies: [] }),
  ];
  const installer = new ModuleInstaller(managed);
  for (const packageRoot of installableModules) installer.install(packageRoot);
  const modules = registry(installer.sources());
  assert.deepEqual(modules.errors, []);
  assert.equal(modules.get('com.transportx.shanghaidata').origin, 'installed');
  assert.equal(modules.get('com.transportx.traffic-assurance-knowledge').origin, 'installed');
  assert.equal(modules.get('com.transportx.plot-style').origin, 'installed');
  assert.deepEqual(modules.get('com.transportx.shanghaidata').manifest.dependencies, ['com.transportx.geo']);
  assert.deepEqual(modules.get('com.transportx.traffic-assurance-knowledge').manifest.dependencies, ['com.transportx.citation']);
  const plan = new SessionAssembler(modules, new AssetResolver(modules), '3.0.0', { command: 'node', args: [] }, { command: 'python', args: [] }).assemble('com.transportx.workbench', managed);
  assert.equal(planSkills(plan).length, 8);
  assert.ok(planExtensions(plan).every((entry: string) => entry.includes(`${path.sep}modules${path.sep}`)));
  assert.ok(planSkills(plan).some((entry: string) => entry.includes(path.join('modules', 'official', 'module-authoring'))));
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
  fs.writeFileSync(path.join(installed, 'manifest.json'), JSON.stringify({ manifestVersion: 2, id: 'local.installed.test', name: 'Installed test', version: '1.0.0', type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [], entrypoints: { skills: ['skill/SKILL.md'] }, contributes: { assets: [{ id: 'data:installed-test', kind: 'data', path: 'data' }] } }));
  const modules = registry([{ manifestPath: path.join(installed, 'manifest.json'), packageRoot: installed, origin: 'installed' }]);
  const assembler = new SessionAssembler(modules, new AssetResolver(modules), '3.0.0', { command: 'node', args: [], version: '0.80.10' }, { command: 'python', args: [], version: '3.10' });
  const plan = assembler.assemble('com.transportx.workbench', workspace);
  assert.equal(planExtensions(plan).length, 6);
  assert.equal(planSkills(plan).length, 6);
  assert.ok(plan.assets.some((asset: any) => asset.id === 'data:installed-test'));
  assert.ok(plan.assets.some((asset: any) => asset.id === 'template:traffic-analysis-report'));
  assert.ok(plan.modules.some((module: any) => module.id === 'local.installed.test'));
  const saved = assembler.save(plan);
  const persisted = JSON.parse(fs.readFileSync(saved, 'utf8'));
  assert.equal(persisted.schemaVersion, 3);
  assert.equal(persisted.domain.id, 'com.transportx.workbench');
  assert.equal(persisted.profile.modules.selectionMode, 'compat-default');
  assert.ok(persisted.modules.every((module: any) => /^[a-f0-9]{64}$/.test(module.manifestSha256)));
  assert.ok(persisted.modules.find((module: any) => module.id === 'com.transportx.document').canvasViews.some((view: any) => view.adapterId === 'com.transportx.canvas.document'));
  assert.deepEqual(assembler.load(workspace), plan);

  persisted.platform.name = 'TransportX Traffic Agent';
  fs.writeFileSync(saved, JSON.stringify(persisted));
  assert.equal(assembler.load(workspace).platform.name, 'TransportX Agent');

  fs.writeFileSync(path.join(installed, 'skill', 'SKILL.md'), '# Tampered Skill');
  assert.throws(() => assembler.load(workspace), (error: any) => error instanceof SessionPlanError && error.code === 'module_content_mismatch');
});

test('Session Resume tolerates builtin module drift but still enforces installed modules', (t: any) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-plan-builtin-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const geoManifest = path.join(ROOT, 'modules/capabilities/geo/manifest.json');
  const geoSkill = path.join(ROOT, 'modules/capabilities/geo/skills/SKILL.md');
  const originalManifest = fs.readFileSync(geoManifest, 'utf8');
  const originalSkill = fs.readFileSync(geoSkill, 'utf8');
  t.after(() => {
    fs.writeFileSync(geoManifest, originalManifest);
    fs.writeFileSync(geoSkill, originalSkill);
  });
  const modules = registry();
  const assembler = new SessionAssembler(modules, new AssetResolver(modules), '3.0.0', { command: 'node', args: [], version: '0.80.10' }, { command: 'python', args: [], version: '3.10' });
  const plan = assembler.assemble('com.transportx.workbench', workspace);
  const geoPlan = plan.modules.find((module: any) => module.id === 'com.transportx.geo');
  assert.equal(geoPlan.origin, 'builtin');
  assembler.save(plan);
  assert.equal(assembler.load(workspace).modules.find((module: any) => module.id === 'com.transportx.geo').version, geoPlan.version);
  assert.doesNotThrow(() => assembler.verify({
    ...plan,
    modules: [...plan.modules, {
      ...geoPlan,
      id: 'com.transportx.timing',
      packageRoot: path.join(workspace, 'retired-timing-module'),
      entrypoints: [],
    }],
  }));

  // Builtin modules are replaced in place on platform upgrades: version bumps and
  // content changes must not make older sessions unloadable.
  const bumped = JSON.parse(originalManifest);
  bumped.version = '99.0.0';
  fs.writeFileSync(geoManifest, JSON.stringify(bumped));
  fs.writeFileSync(geoSkill, `${originalSkill}\n\nUpgraded in place.\n`);
  assert.doesNotThrow(() => assembler.load(workspace));

  // A missing builtin package is still a hard failure.
  fs.rmSync(geoManifest);
  assert.throws(() => assembler.load(workspace), (error: any) => error instanceof SessionPlanError && error.code === 'module_version_missing');
});

test('Session Resume replaces the retired builtin Video module with an installed version', (t: any) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-plan-video-migration-'));
  const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-installed-video-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  t.after(() => fs.rmSync(installed, { recursive: true, force: true }));
  fs.writeFileSync(path.join(installed, 'manifest.json'), JSON.stringify({
    manifestVersion: 2,
    id: 'com.transportx.video',
    name: 'Video Capability',
    version: '1.3.0',
    type: 'capability',
    platformVersion: '>=3.0.0 <4.0.0',
    dependencies: [],
  }));
  const modules = registry([{ manifestPath: path.join(installed, 'manifest.json'), packageRoot: installed, origin: 'installed' }]);
  const assembler = new SessionAssembler(modules, new AssetResolver(modules), '3.2.0', { command: 'node', args: [] }, { command: 'python', args: [] });
  const plan = assembler.assemble('com.transportx.workbench', workspace);
  const baseModule = plan.modules.find((module: any) => module.id === 'com.transportx.geo');
  plan.modules.push({
    ...baseModule,
    id: 'com.transportx.video',
    version: '1.2.0',
    origin: 'builtin',
    packageRoot: path.join(workspace, 'removed-builtin-video'),
    entrypoints: [],
    nativeRuntimes: [],
  });

  const resumed = assembler.verify(plan);
  const video = resumed.modules.find((module: any) => module.id === 'com.transportx.video');
  assert.equal(video.origin, 'installed');
  assert.equal(video.version, '1.3.0');
  assert.equal(video.packageRoot, installed);
});

test('Session Assembly keeps every active Data and Knowledge asset in one session plan', (t: any) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-multiple-data-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-data-first-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-data-second-'));
  t.after(() => fs.rmSync(first, { recursive: true, force: true }));
  t.after(() => fs.rmSync(second, { recursive: true, force: true }));
  for (const [root, id, kind] of [[first, 'data:first', 'data'], [second, 'data:second', 'data'], [first, 'knowledge:first', 'knowledge'], [second, 'knowledge:second', 'knowledge']] as const) {
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'assets', 'records.csv'), 'value\n1\n');
    const manifestPath = path.join(root, 'manifest.json');
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { manifestVersion: 2, id: `local.${id.split(':')[1]}`, name: root, version: '1.0.0', type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [], contributes: { assets: [] } };
    manifest.contributes.assets.push({ id, kind, path: 'assets' });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  }
  const modules = registry([
    { manifestPath: path.join(first, 'manifest.json'), packageRoot: first, origin: 'installed' },
    { manifestPath: path.join(second, 'manifest.json'), packageRoot: second, origin: 'installed' },
  ]);
  const plan = new SessionAssembler(modules, new AssetResolver(modules), '3.0.0', { command: 'node', args: [] }, { command: 'python', args: [] }).assemble('com.transportx.workbench', workspace);
  assert.deepEqual(plan.assets.filter((asset: any) => asset.kind === 'data').map((asset: any) => asset.id).sort(), ['data:first', 'data:second']);
  assert.deepEqual(plan.assets.filter((asset: any) => asset.kind === 'knowledge').map((asset: any) => asset.id).sort(), ['knowledge:first', 'knowledge:second']);
  assert.equal(plan.schemaVersion, 3);
});

test('project prompt makes resolved Module skills and assets discoverable to the Agent', () => {
  const prompt = renderProjectPrompt('{{MODULE_RESOURCE_GUIDE}}', '/tmp/transportx-task', {
    modules: [{ entrypoints: [{ kind: 'skill', path: '/tmp/modules/com.example.city/1.0.0/skill/SKILL.md' }] }],
    assets: [
      { id: 'data:city-traffic', kind: 'data', moduleId: 'com.example.city', moduleVersion: '1.0.0', path: '/tmp/modules/com.example.city/1.0.0/assets/databases' },
      { id: 'knowledge:city-policy', kind: 'knowledge', moduleId: 'com.example.policy', moduleVersion: '1.0.0', path: '/tmp/modules/com.example.policy/1.0.0/assets/policy-library' },
    ],
  } as any);
  assert.match(prompt, /Skill 根目录：`\/tmp\/modules\/com\.example\.city\/1\.0\.0\/skill`/);
  assert.match(prompt, /TRANSPORTX_DATA_ASSETS_JSON/);
  assert.match(prompt, /TRANSPORTX_KNOWLEDGE_ASSETS_JSON/);
  assert.match(prompt, /assets\/policy-library/);
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
