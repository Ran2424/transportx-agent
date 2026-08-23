const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveAppPaths } = require('../bin/app-paths.js');
const { loadRuntimeManifest, validateRuntimeManifest } = require('../bin/runtime-resolver.js');
const { toPosixPath, relativePosixPath, isWithin } = require('../bin/util/path.js');

function digest(filePath: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('path utilities produce host-stable POSIX output', () => {
  // toPosixPath on a Windows-shaped path must always yield forward slashes.
  assert.equal(toPosixPath('a\\b\\c'), 'a/b/c');
  assert.equal(toPosixPath('a\\\\b'), 'a/b');
  assert.equal(toPosixPath(''), '');
  // relativePosixPath runs path.relative first, then POSIX-normalizes.
  assert.equal(relativePosixPath(path.resolve('/tmp'), path.resolve('/tmp/foo/bar')), 'foo/bar');
  // Same call with Windows-shaped arguments yields the same relative string.
  assert.equal(relativePosixPath(path.resolve('C:\\tmp'), path.resolve('C:\\tmp\\foo\\bar')), 'foo/bar');
  // isWithin re-exports the canonical asset-integrity boundary formula and
  // must reject symlink-shaped escapes regardless of host.
  assert.equal(isWithin(path.resolve('/root'), path.resolve('/root/inner')), true);
  assert.equal(isWithin(path.resolve('/root'), path.resolve('/root-evil')), false);
});

test('platform-profile registry exposes frozen mac/win profiles with required contract', async () => {
  const url = require('node:url');
  const profilePath = path.join(__dirname, '..', 'desktop', 'scripts', 'platform-profile.mjs');
  const profileModule = await import(url.pathToFileURL(profilePath).toString());
  const { PLATFORM_PROFILES, PROCESS_PLATFORM_TO_BUILDER, getPlatformProfile, builderPlatformFor } = profileModule;

  // mac/win mapping is stable; adding linux must be an explicit PR change here.
  assert.deepEqual({ ...PROCESS_PLATFORM_TO_BUILDER }, { darwin: 'mac', win32: 'win', linux: 'linux' });
  assert.equal(builderPlatformFor('darwin'), 'mac');
  assert.equal(builderPlatformFor('win32'), 'win');

  const profileExpectations: Record<string, { key: string; builderPlatform: string; installerArtifact: string }> = {
    darwin: { key: 'darwin', builderPlatform: 'mac', installerArtifact: 'dmg' },
    win: { key: 'win', builderPlatform: 'win', installerArtifact: 'nsis' },
  };

  for (const [entry, expected] of Object.entries(profileExpectations)) {
    const profile = PLATFORM_PROFILES[entry];
    assert.ok(profile, `profile ${entry} missing`);
    assert.equal(profile.key, expected.key);
    assert.equal(profile.builderPlatform, expected.builderPlatform);
    assert.equal(typeof profile.python.archCheck, 'function');
    assert.match(profile.python.archErrorMessage, /./);
    assert.ok(Array.isArray(profile.python.requiredModules) && profile.python.requiredModules.length >= 4);
    assert.equal(typeof profile.ffmpeg.binName, 'function');
    assert.equal(typeof profile.ffmpeg.chmodRequired, 'boolean');
    assert.equal(typeof profile.ffmpeg.archCheck, 'function');
    assert.match(profile.ffmpeg.arch, /arm64|x64/);
    assert.match(profile.signing.hostArchRequired, /arm64|x64/);
    assert.match(profile.signing.description, /./);
    assert.ok(Array.isArray(profile.signing.requiredEnv) && profile.signing.requiredEnv.length >= 1);
    assert.match(profile.signing.allowUnsignedEnv, /./);
    assert.match(profile.signing.allowUnsignedPurpose, /./);
    assert.equal(profile.release.installerArtifact, expected.installerArtifact);
    assert.match(profile.release.productExeBasename, /./);
    assert.match(profile.release.productExeSuffix, /\.exe|/);
    assert.equal(typeof profile.release.requiresFfmpeg, 'boolean');
    assert.equal(typeof profile.release.supportsInstallerSmoke, 'boolean');
    assert.match(profile.release.notes, /./);
  }

  // OS-specific invariants baked into the contract:
  const mac = PLATFORM_PROFILES.darwin;
  assert.equal(mac.ffmpeg.binName('ffmpeg'), 'ffmpeg', 'mac ffmpeg binary must not have a suffix');
  assert.equal(mac.ffmpeg.chmodRequired, true, 'mac ffmpeg needs +x');
  assert.equal(mac.ffmpeg.arch, 'arm64');
  assert.equal(mac.signing.hostArchRequired, 'arm64');
  assert.equal(mac.python.entry, 'bin/python3');

  const win = PLATFORM_PROFILES.win;
  assert.equal(win.ffmpeg.binName('ffmpeg'), 'ffmpeg.exe', 'win ffmpeg binary must end in .exe');
  assert.equal(win.ffmpeg.chmodRequired, false, 'win ffmpeg inherits +x from NTFS');
  assert.equal(win.ffmpeg.arch, 'x64');
  assert.equal(win.signing.hostArchRequired, 'x64');
  assert.equal(win.python.entry, 'python.exe');
  assert.equal(win.release.installerArtifact, 'nsis');
  assert.equal(typeof win.release.uninstallName, 'string');
  assert.ok(Array.isArray(win.release.installerSilentArgs(path.join('C:', 'install'))));

  // getPlatformProfile with a non-registered builderPlatform must throw clearly.
  assert.throws(() => getPlatformProfile('plan9'), /Platform profile missing/);
});

test('check-desktop-release composes per-OS requirements behind one dispatcher', () => {
  const check = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'scripts', 'check-desktop-release.mjs'), 'utf8');
  // Single entry point; per-OS scripts are retired.
  assert.match(check, /import \{ builderPlatformFor, getPlatformProfile \} from '\.\/platform-profile\.mjs'/);
  // Each OS branch resolves env via profile.signing, not inline literals.
  for (const fragment of [
    /profile\.signing\.hostArchRequired/,
    /profile\.signing\.allowUnsignedPurpose/,
    /profile\.signing\.description/,
    /profile\.key === 'darwin'/,
    /profile\.key === 'win'/,
  ]) assert.match(check, fragment);
});

test('prepare-runtime reads platform-profile fields and never hardcodes a platform', () => {
  const prepare = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'scripts', 'prepare-runtime.mjs'), 'utf8');
  // Profile is the canonical data source.
  assert.match(prepare, /import \{ getPlatformProfile \} from '\.\/platform-profile\.mjs'/);
  // Python entrypoint, arch probe and ffmpeg filename/chmod all reach through the profile.
  assert.match(prepare, /profile\.python\.entry/);
  assert.match(prepare, /profile\.python\.archCheck\(pythonProbe\.machine\)/);
  assert.match(prepare, /profile\.ffmpeg\.binName/);
  assert.match(prepare, /profile\.ffmpeg\.chmodRequired/);
  assert.match(prepare, /profile\.ffmpeg\.archCheck\(staged\)/);
  // Error message references profile fields, not platform literals, so a future
  // Linux profile inherits correct guidance.
  assert.match(prepare, /Bundled \$\{profile\.label\} Python must be \$\{profile\.python\.archErrorMessage\}/);
  // Hardcoded OS checks must NOT appear in the production script.
  assert.doesNotMatch(prepare, /process\.platform === '(?:darwin|win32)'/);
  assert.doesNotMatch(prepare, /python\.exe/);
  assert.doesNotMatch(prepare, /ffmpeg\.exe/);
});

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
  // Mirror the macOS vendor/product split: %APPDATA%\TransportX\traffic-agent\
  assert.equal(paths.userDataDir, path.join(appData, 'TransportX', 'traffic-agent'));
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
