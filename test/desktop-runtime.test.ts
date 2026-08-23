const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveAppPaths } = require('../bin/app-paths.js');
const { loadRuntimeManifest, validateRuntimeManifest } = require('../bin/runtime-resolver.js');

function digest(filePath: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('desktop app paths keep durable data outside application resources', () => {
  const resourcesDir = '/Applications/TransportX.app/Contents/Resources';
  const userDataDir = path.join('/Users/example', '.transportx', 'traffic-agent');
  const paths = resolveAppPaths({ HOME: '/Users/example', TAU_APP_ROOT: '/Applications/TransportX.app/app', TAU_RESOURCES_DIR: resourcesDir }, 'darwin');
  // path.resolve produces absolute paths the same way on every platform; the
  // expected values are recomputed through path.join to stay portable.
  assert.equal(paths.resourcesDir, path.resolve(resourcesDir));
  assert.equal(paths.userDataDir, path.resolve(userDataDir));
  assert.equal(paths.scenarioDir, path.join(paths.userDataDir, 'scenario'));
  assert.equal(paths.piAgentDir, path.resolve(userDataDir));
  assert.equal(paths.sessionsDir, path.join(paths.userDataDir, 'sessions'));
  assert.equal(paths.modulesDir, path.join(paths.userDataDir, 'modules'));
  assert.ok(!paths.sessionsDir.startsWith(paths.resourcesDir));
});

test('Windows desktop app paths use roaming user data outside application resources', () => {
  const appData = process.platform === 'win32' ? 'C:\\Users\\example\\AppData\\Roaming' : '/Users/example/AppData/Roaming';
  const paths = resolveAppPaths({ APPDATA: appData, TAU_APP_ROOT: '/opt/TransportX/resources/app.asar', TAU_RESOURCES_DIR: '/opt/TransportX/resources' }, 'win32');
  assert.equal(paths.userDataDir, path.join(appData, 'TransportX Traffic Agent'));
  assert.equal(paths.scenarioDir, path.join(paths.userDataDir, 'scenario'));
  assert.equal(paths.modulesDir, path.join(paths.userDataDir, 'modules'));
  assert.ok(!paths.userDataDir.startsWith(paths.resourcesDir));
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
    product: { name: 'TransportX Traffic Agent', version: '3.0.3' },
    agentHost: { ...entry('agent-host/tau.js', '3.0.3'), protocolVersion: 1 },
    pi: entry('runtimes/pi/cli.js', '0.80.10'),
    python: entry('runtimes/python/python', '3.10.0'),
  }));
  assert.equal(loadRuntimeManifest(root).product.name, 'TransportX Traffic Agent');
  assert.equal(validateRuntimeManifest(root).pi, path.join(root, 'runtimes/pi/cli.js'));
  fs.writeFileSync(path.join(root, 'runtimes/pi/cli.js'), 'tampered');
  assert.throws(() => validateRuntimeManifest(root), /checksum mismatch/);
});

test('ffmpeg executables resolve from the packaged manifest, env overrides, or dev PATH', (t: any) => {
  const { resolveFfmpegExecutables } = require('../bin/runtime-resolver.js');

  // Development desktop mode: no runtime manifest, explicit overrides injected by the supervisor.
  const devRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-ffmpeg-dev-'));
  t.after(() => fs.rmSync(devRoot, { recursive: true, force: true }));
  const overridden = resolveFfmpegExecutables({ resourcesDir: devRoot, desktop: true, env: { TAU_FFMPEG_COMMAND: '/opt/homebrew/bin/ffmpeg', TAU_FFPROBE_COMMAND: '/opt/homebrew/bin/ffprobe' } });
  assert.equal(overridden.ffmpeg.command, '/opt/homebrew/bin/ffmpeg');
  assert.equal(overridden.ffprobe.command, '/opt/homebrew/bin/ffprobe');
  assert.throws(() => resolveFfmpegExecutables({ resourcesDir: devRoot, desktop: true, env: {} }), /runtime manifest|ffmpeg/, 'packaged mode without a manifest or overrides must fail loudly');

  // Packaged mode: both entries resolve with checksum validation.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-ffmpeg-packaged-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of ['agent-host/tau.js', 'runtimes/pi/cli.js', 'runtimes/python/python', 'runtimes/ffmpeg/ffmpeg', 'runtimes/ffmpeg/ffprobe']) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, relative);
  }
  const entry = (relative: string, version: string) => ({ version, path: relative, sha256: digest(path.join(root, relative)) });
  fs.writeFileSync(path.join(root, 'runtime-manifest.json'), JSON.stringify({
    manifestVersion: 1,
    product: { name: 'TransportX Traffic Agent', version: '3.0.9' },
    agentHost: { ...entry('agent-host/tau.js', '3.0.9'), protocolVersion: 1 },
    pi: entry('runtimes/pi/cli.js', '0.80.10'),
    python: entry('runtimes/python/python', '3.10.20'),
    ffmpeg: { ...entry('runtimes/ffmpeg/ffmpeg', '8.0'), arch: 'arm64' },
    ffprobe: { ...entry('runtimes/ffmpeg/ffprobe', '8.0'), arch: 'arm64' },
  }));
  const packaged = resolveFfmpegExecutables({ resourcesDir: root, desktop: true, env: {} });
  assert.equal(packaged.ffmpeg.command, path.join(root, 'runtimes/ffmpeg/ffmpeg'));
  assert.equal(packaged.ffmpeg.version, '8.0');
  assert.equal(packaged.ffprobe.command, path.join(root, 'runtimes/ffmpeg/ffprobe'));

  // Development non-desktop mode falls back to PATH.
  const fallback = resolveFfmpegExecutables({ resourcesDir: devRoot, desktop: false, env: {} });
  assert.equal(fallback.ffmpeg.command, 'ffmpeg');
  assert.equal(fallback.ffprobe.command, 'ffprobe');

  // The desktop supervisor must inject ffmpeg overrides alongside python in development mode.
  const supervisor = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'agent-host-supervisor.ts'), 'utf8');
  assert.match(supervisor, /TAU_FFMPEG_COMMAND/);
  assert.match(supervisor, /TAU_FFPROBE_COMMAND/);
});

test('unsigned macOS test builds replace Electron linker signatures before creating the DMG', () => {
  const rootBuilder = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'electron-builder.yml'), 'utf8');
  const commonBuilder = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'electron-builder.common.yml'), 'utf8');
  const macBuilder = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'electron-builder.mac.yml'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.ts'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'styles.css'), 'utf8');
  const hook = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'scripts', 'after-pack.cjs'), 'utf8');
  const prepareRuntime = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'scripts', 'prepare-runtime.mjs'), 'utf8');
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'desktop-smoke.mjs'), 'utf8');
  // Top-level electron-builder.yml must compose platform-agnostic + per-OS fragments.
  assert.match(rootBuilder, /extends:[\s\S]*electron-builder\.common\.yml/);
  assert.match(rootBuilder, /extends:[\s\S]*electron-builder\.mac\.yml/);
  assert.match(rootBuilder, /extends:[\s\S]*electron-builder\.win\.yml/);
  assert.match(commonBuilder, /afterPack: desktop\/scripts\/after-pack\.cjs/);
  assert.match(commonBuilder, /asarUnpack:[\s\S]*modules\/\*\*\/skills\/\*\*/);
  assert.match(commonBuilder, /"!modules\/installable\/\*\*"/);
  assert.match(commonBuilder, /prompts\/\*\*/);
  assert.match(macBuilder, /target:[\s\S]*dmg/);
  assert.match(macBuilder, /arch: arm64/);
  assert.match(main, /titleBarStyle: process\.platform === 'darwin' \? 'hiddenInset'/);
  assert.match(main, /trafficLightPosition: \{ x: 14, y: 14 \}/);
  assert.match(styles, /data-desktop-platform="darwin".*workspace-header-left.*padding-left: 66px/);
  assert.match(hook, /TRANSPORTX_ALLOW_UNSIGNED_BUILD/);
  assert.match(hook, /--verify/);
  assert.match(prepareRuntime, /\['-B', '-I', '-c'/);
  assert.match(smoke, /\['-B', '-I', '-c'/);
});

test('Windows NSIS release stages x64 .exe runtimes and has a profile-aware pre-flight', () => {
  const winBuilder = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'electron-builder.win.yml'), 'utf8');
  const profile = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'scripts', 'platform-profile.mjs'), 'utf8');
  const releaseCheck = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'scripts', 'check-desktop-release.mjs'), 'utf8');
  const prepareRuntime = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'scripts', 'prepare-runtime.mjs'), 'utf8');
  const installerSmoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'windows-installer-smoke.mjs'), 'utf8');
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'desktop-smoke.mjs'), 'utf8');
  assert.match(winBuilder, /icon: app-icon\.ico/);
  assert.match(winBuilder, /target: nsis[\s\S]*arch: x64/);
  assert.match(winBuilder, /deleteAppDataOnUninstall: false/);
  // Profile is the single source of truth for Windows pre-flight requirements.
  assert.match(profile, /win[\s\S]*Authenticode/i);
  assert.match(profile, /hostArchRequired: 'x64'/);
  assert.match(profile, /binName:[\s\S]*\.exe/);
  assert.match(prepareRuntime, /profile\.ffmpeg\.binName/);
  assert.match(prepareRuntime, /Bundled \$\{profile\.label\} Python must be \$\{profile\.python\.archErrorMessage\}/);
  assert.match(releaseCheck, /WIN_CSC_LINK/);
  assert.match(releaseCheck, /profile\.signing\.description/);
  assert.match(installerSmoke, /TRANSPORTX_WINDOWS_INSTALLER/);
  assert.match(installerSmoke, /Uninstall TransportX Traffic Agent\.exe/);
  assert.match(smoke, /process\.platform === 'win32'/);
});
