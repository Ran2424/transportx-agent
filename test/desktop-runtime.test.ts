const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveAppPaths } = require('../bin/app-paths.js');
const { loadRuntimeManifest, validateRuntimeManifest, resolvePiExecutable } = require('../bin/runtime-resolver.js');

function digest(filePath: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('desktop app paths keep durable data outside application resources', () => {
  const paths = resolveAppPaths({ HOME: '/Users/example', TAU_APP_ROOT: '/Applications/TransportX.app/app', TAU_RESOURCES_DIR: '/Applications/TransportX.app/Contents/Resources' }, 'darwin');
  assert.equal(paths.resourcesDir, '/Applications/TransportX.app/Contents/Resources');
  assert.equal(paths.userDataDir, '/Users/example/.transportx/traffic-agent');
  assert.equal(paths.scenarioDir, '/Users/example/.transportx/traffic-agent/scenario');
  assert.equal(paths.piAgentDir, '/Users/example/.transportx/traffic-agent');
  assert.equal(paths.sessionsDir, '/Users/example/.transportx/traffic-agent/sessions');
  assert.equal(paths.modulesDir, '/Users/example/.transportx/traffic-agent/modules');
  assert.ok(!paths.sessionsDir.startsWith(paths.resourcesDir));
});

test('runtime manifest validates relative paths and checksums', (t: any) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of ['agent-host/tau.js', 'runtimes/pi/cli.js', 'runtimes/python/python']) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, relative);
  }
  const entry = (relative: string, version: string) => ({ version, path: relative, sha256: digest(path.join(root, relative)) });
  fs.writeFileSync(path.join(root, 'runtime-manifest.json'), JSON.stringify({
    manifestVersion: 1,
    product: { name: 'TransportX Traffic Agent', version: '2.14.0' },
    agentHost: { ...entry('agent-host/tau.js', '2.14.0'), protocolVersion: 1 },
    pi: entry('runtimes/pi/cli.js', '0.80.10'),
    python: entry('runtimes/python/python', '3.10.0'),
  }));
  assert.equal(loadRuntimeManifest(root).product.name, 'TransportX Traffic Agent');
  assert.equal(validateRuntimeManifest(root).pi, path.join(root, 'runtimes/pi/cli.js'));
  fs.writeFileSync(path.join(root, 'runtimes/pi/cli.js'), 'tampered');
  assert.throws(() => validateRuntimeManifest(root), /checksum mismatch/);
});

test('desktop Pi resolution never falls back to a global command', () => {
  assert.throws(() => resolvePiExecutable({ appRoot: '/missing', resourcesDir: '/missing', desktop: true, env: {} }), /runtime manifest/);
});

test('unsigned macOS test builds replace Electron linker signatures before creating the DMG', () => {
  const builder = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'electron-builder.yml'), 'utf8');
  const hook = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'scripts', 'after-pack.cjs'), 'utf8');
  const prepareRuntime = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'scripts', 'prepare-runtime.mjs'), 'utf8');
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'desktop-smoke.mjs'), 'utf8');
  assert.match(builder, /afterPack: desktop\/scripts\/after-pack\.cjs/);
  assert.match(builder, /asarUnpack:[\s\S]*traffic-data\/skill\/\*\*/);
  assert.match(builder, /asarUnpack:[\s\S]*traffic-knowledge\/skill\/\*\*/);
  assert.match(builder, /asarUnpack:[\s\S]*skills\/\*\*/);
  assert.match(builder, /prompts\/\*\*/);
  assert.match(hook, /TRANSPORTX_ALLOW_UNSIGNED_BUILD/);
  assert.match(hook, /--verify/);
  assert.match(prepareRuntime, /\['-B', '-I', '-c'/);
  assert.match(smoke, /\['-B', '-I', '-c'/);
});
