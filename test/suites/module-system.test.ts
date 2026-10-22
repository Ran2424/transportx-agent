const { test } = require('node:test') as typeof import('node:test');

test('Module assembly and resume resolve explicit capabilities and exact installed versions', async (t) => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { ModuleRegistry, moduleRuntimeCompatible } = require('../../bin/module-registry.js');
  const { AssetResolver } = require('../../bin/asset-resolver.js');
  const { SessionAssembler, SessionPlanError, planExtensions, planSkills } = require('../../bin/session-assembly.js');
  const ROOT = process.cwd();
  // Trust is established outside Pi; stored origin labels and RPC booleans are not evidence.
  {
    const { ModuleTrustStore, ensureSessionModuleTrust } = require('../../bin/module-trust.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-trust-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const manifest = { manifestVersion: 2, id: 'local.trust-probe', name: 'Trust probe', version: '1.0.0', type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [], entrypoints: { piExtensions: ['extension.ts'] } };
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(root, 'extension.ts'), 'throw new Error("Static inspection must never execute this");');
    const file = path.join(root, 'trust.json');
    let accepted = false, decisions = 0;
    const store = new ModuleTrustStore(file, async () => { decisions++; return accepted; });
    const module = { id: manifest.id, version: manifest.version, origin: 'builtin', packageRoot: root, entrypoints: [{ kind: 'extension', path: path.join(root, 'extension.ts') }] };
    const plan = { modules: [module] };
    await assert.rejects(ensureSessionModuleTrust(plan, [], store), /trust was not accepted/);
    assert.equal(fs.existsSync(file), false);
    accepted = true;
    await ensureSessionModuleTrust(plan, [], store);
    fs.appendFileSync(path.join(root, 'extension.ts'), '\n// User edits remain permitted');
    await ensureSessionModuleTrust(plan, [], new ModuleTrustStore(file, async () => { throw new Error('Do not prompt again'); }));
    assert.equal(decisions, 2);
    await assert.rejects(ensureSessionModuleTrust({ modules: [{ ...module, entrypoints: [{ kind: 'extension', path: __filename }] }] }, [], store), /Undeclared/);
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ ...manifest, dependencies: ['local.new-dependency'] }));
    accepted = false;
    await assert.rejects(ensureSessionModuleTrust(plan, [], store), /trust was not accepted/);
    await ensureSessionModuleTrust(plan, [path.join(root, 'manifest.json')], store);
    assert.equal(decisions, 3, 'only a platform-controlled root receives the builtin exception');
    store.forget([root]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
  }
  const MANIFESTS = [
    'modules/capabilities/web-bridge/manifest.json',
    'modules/capabilities/interaction/manifest.json',
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

  // required native runtimes are compatible only with their declared platform and architecture
  {
    const manifest = {
      contributes: {
        requiredNativeRuntimes: ['ffmpeg'],
        nativeRuntimes: [{ id: 'ffmpeg', platform: 'darwin', arch: 'arm64' }],
      },
    };
    assert.equal(moduleRuntimeCompatible(manifest, 'darwin', 'arm64').compatible, true);
    assert.deepEqual(moduleRuntimeCompatible(manifest, 'win32', 'x64'), { compatible: false, missingRuntime: 'ffmpeg' });
  }

  // CLI domain loads only explicitly selected capabilities
  {
    const modules = registry();
    const assembler = new SessionAssembler(modules, new AssetResolver(modules), '3.0.0', { command: 'node', args: [] }, { command: 'python', args: [] });
    const profile = {
      schemaVersion: 1,
      task: { kind: 'data-query', expectedOutputs: ['answer'] },
      modules: { selectionMode: 'explicit', selected: [{ id: 'com.transportx.citation', version: modules.get('com.transportx.citation').manifest.version }] },
    };
    const plan = assembler.assemble('com.transportx.cli', process.cwd(), profile);
    assert.deepEqual(plan.modules.map((module: any) => module.id), ['com.transportx.cli', 'com.transportx.citation']);
    assert.equal(plan.modules.some((module: any) => module.id === 'com.transportx.geo'), false);
    assert.equal(plan.modules.some((module: any) => module.id === 'com.transportx.video'), false);
    const spatialPlan = assembler.assemble('com.transportx.cli', process.cwd(), {
      ...profile,
      modules: { selectionMode: 'explicit', selected: [{ id: 'com.transportx.spatial-analysis', version: modules.get('com.transportx.spatial-analysis').manifest.version }] },
    });
    assert.deepEqual(spatialPlan.modules.map((module: any) => module.id), ['com.transportx.cli', 'com.transportx.canvas', 'com.transportx.geo', 'com.transportx.citation', 'com.transportx.spatial-analysis']);
    assert.throws(() => assembler.assemble('com.transportx.cli', process.cwd(), {
      ...profile,
      modules: { selectionMode: 'explicit', selected: [{ id: 'com.transportx.citation', version: '9.9.9' }] },
    }), /version is unavailable/);
  }

  // Session Assembly resolves extensions, skills, assets and persists a versioned plan
  {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-plan-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-installed-module-'));
    t.after(() => fs.rmSync(installed, { recursive: true, force: true }));
    fs.mkdirSync(path.join(installed, 'skill'));
    fs.mkdirSync(path.join(installed, 'data'));
    fs.writeFileSync(path.join(installed, 'skill', 'SKILL.md'), '---\nname: installed-test\ndescription: >-\n  Analyze station access\n  with connected data.\n---\n\n# Installed Skill');
    fs.writeFileSync(path.join(installed, 'data', 'catalog.sqlite'), 'fixture');
    fs.writeFileSync(path.join(installed, 'manifest.json'), JSON.stringify({ manifestVersion: 2, id: 'local.installed.test', name: 'Installed test', version: '1.0.0', type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [], entrypoints: { skills: ['skill/SKILL.md'] }, contributes: { assets: [{ id: 'data:installed-test', kind: 'data', path: 'data' }] } }));
    const modules = registry([{ manifestPath: path.join(installed, 'manifest.json'), packageRoot: installed, origin: 'installed' }]);
    const { platformOverview, resolveModuleDirectory } = require('../../bin/platform-overview.js');
    const { resolveAppPaths } = require('../../bin/app-paths.js');
    const overview = platformOverview(resolveAppPaths({ TAU_USER_DATA_DIR: workspace }), modules, new AssetResolver(modules));
    const skill = overview.modules.find((module: any) => module.id === 'local.installed.test').skillFiles[0];
    assert.equal(skill.name, 'Installed Skill');
    assert.equal(skill.description, 'Analyze station access with connected data.');
    assert.match(skill.content, /name: installed-test/);
    assert.equal(resolveModuleDirectory(installed), fs.realpathSync(installed));
    const archivedModule = path.join(workspace, 'app.asar', 'modules', 'example');
    const unpackedModule = path.join(workspace, 'app.asar.unpacked', 'modules', 'example');
    fs.mkdirSync(unpackedModule, { recursive: true });
    assert.equal(resolveModuleDirectory(archivedModule), fs.realpathSync(unpackedModule));
    assert.throws(() => resolveModuleDirectory(path.join(workspace, 'missing')));
    const assembler = new SessionAssembler(modules, new AssetResolver(modules), '3.0.0', { command: 'node', args: [], version: '0.80.10' }, { command: 'python', args: [], version: '3.10' });
    const plan = assembler.assemble('com.transportx.workbench', workspace);
    assert.equal(planExtensions(plan).length, 7);
    assert.equal(planSkills(plan).length, 6);
    assert.ok(plan.assets.some((asset: any) => asset.id === 'data:installed-test'));
    assert.ok(plan.assets.some((asset: any) => asset.id === 'template:traffic-analysis-report'));
    assert.ok(plan.modules.some((module: any) => module.id === 'local.installed.test'));
    const saved = assembler.save(plan);
    const persisted = JSON.parse(fs.readFileSync(saved, 'utf8'));
    assert.equal(persisted.schemaVersion, 3);
    assert.equal(persisted.domain.id, 'com.transportx.workbench');
    assert.equal(persisted.profile.modules.selectionMode, 'compat-default');
    assert.ok(persisted.modules.every((module: any) => !('manifestSha256' in module) && module.entrypoints.every((entry: any) => !('sha256' in entry))));
    assert.ok(persisted.modules.find((module: any) => module.id === 'com.transportx.document').canvasViews.some((view: any) => view.adapterId === 'com.transportx.canvas.document'));
    assert.deepEqual(assembler.load(workspace), plan);
    assert.doesNotThrow(() => assembler.verify({ ...plan, workspace: fs.realpathSync(workspace) }, workspace), 'canonical aliases resolve to the same workspace during recovery');

    persisted.platform.name = 'TransportX Traffic Agent';
    fs.writeFileSync(saved, JSON.stringify(persisted));
    assert.equal(assembler.load(workspace).platform.name, 'TransportX Agent');

    // Old plans retain their schema version and may contain now-ignored content hashes.
    for (const module of persisted.modules) {
      module.manifestSha256 = '0'.repeat(64);
      for (const entry of module.entrypoints) entry.sha256 = '0'.repeat(64);
    }
    fs.writeFileSync(saved, JSON.stringify(persisted));
    fs.writeFileSync(path.join(installed, 'skill', 'SKILL.md'), '# User-edited Skill');
    const editedManifest = JSON.parse(fs.readFileSync(path.join(installed, 'manifest.json'), 'utf8'));
    editedManifest.name = 'User-edited module';
    fs.writeFileSync(path.join(installed, 'manifest.json'), JSON.stringify(editedManifest));
    assert.deepEqual(assembler.load(workspace), plan);
    const editableExtension = path.join(installed, 'extension.ts');
    const editablePrompt = path.join(installed, 'prompt.md');
    fs.writeFileSync(editableExtension, 'export default () => {};');
    fs.writeFileSync(editablePrompt, 'User-edited prompt');
    const legacyModule = persisted.modules.find((module: any) => module.id === 'local.installed.test');
    legacyModule.entrypoints.push({ kind: 'extension', path: editableExtension, sha256: '0'.repeat(64) }, { kind: 'prompt', path: editablePrompt, sha256: '0'.repeat(64) });
    fs.writeFileSync(saved, JSON.stringify(persisted));
    assert.doesNotThrow(() => assembler.load(workspace));
    fs.rmSync(path.join(installed, 'skill', 'SKILL.md'));
    assert.throws(() => assembler.load(workspace), (error: any) => error instanceof SessionPlanError && error.code === 'module_entrypoint_missing');
  }

  // Session Resume permits builtin edits while retaining missing-package checks
  {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-plan-builtin-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const geoManifest = path.join(ROOT, 'modules/capabilities/geo/manifest.json');
    const geoSkill = path.join(ROOT, 'modules/capabilities/geo/skills/SKILL.md');
    const originalManifest = fs.readFileSync(geoManifest, 'utf8');
    const originalSkill = fs.readFileSync(geoSkill, 'utf8');
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

    try {
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
    } finally {
      fs.writeFileSync(geoManifest, originalManifest);
      fs.writeFileSync(geoSkill, originalSkill);
    }
  }

  // Session Resume replaces the retired builtin Video module with an installed version
  {
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
  }

  // Session Assembly keeps every active Data and Knowledge asset in one session plan
  {
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
  }

  // a broken optional module is recorded without blocking built-in modules
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-broken-module-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const manifestPath = path.join(root, 'manifest.json');
    fs.writeFileSync(manifestPath, '{broken');
    const modules = registry([{ manifestPath }]);
    assert.equal(modules.errors.length, 1);
    assert.equal(modules.get('com.transportx.workbench').enabled, true);
  }
});
