const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveAppPaths } = require('../../bin/app-paths.js');
const { loadRuntimeManifest, validateRuntimeManifest } = require('../../bin/runtime-resolver.js');
const { toPosixPath, relativePosixPath, isWithin } = require('../../bin/util/path.js');

function digest(filePath: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

caseTest('desktop updates require explicit download and install, deduplicate actions and recover failures', async () => {
  const { EventEmitter } = require('node:events');
  const { UpdateService } = require('../../dist-desktop/update-service.js');
  let checks = 0, downloads = 0, installs = 0, preparations = 0, recoveries = 0;
  let busy = false;
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => { checks += 1; updater.emit('update-available', { version: '3.23.0', releaseNotes: '<script>plain text</script>' }); };
  updater.downloadUpdate = async () => { downloads += 1; updater.emit('download-progress', { percent: 40 }); updater.emit('update-downloaded', { version: '3.23.0', releaseNotes: 'Notes' }); };
  updater.quitAndInstall = () => { installs += 1; };
  const service = new UpdateService(updater, '3.22.0', true, {
    prepare: async () => { preparations += 1; if (busy) throw Object.assign(new Error('busy'), { code: 'host_busy' }); },
    recover: async () => { recoveries += 1; },
    onInstalling: () => {},
  });
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  await service.install();
  assert.equal(preparations, 0);
  const check = service.check();
  assert.equal(service.check(), check);
  await check;
  assert.equal(checks, 1);
  assert.equal(downloads, 0);
  assert.equal(service.getState().phase, 'available');
  const download = service.download();
  assert.equal(service.download(), download);
  await download;
  assert.equal(downloads, 1);
  assert.equal(service.getState().percent, 100);
  busy = true;
  await service.install();
  assert.equal(service.getState().phase, 'downloaded');
  assert.equal(service.getState().errorCode, 'host_busy');
  assert.equal(installs, 0);
  assert.equal(recoveries, 1);
  busy = false;
  const install = service.install();
  assert.equal(service.install(), install);
  await install;
  assert.equal(installs, 1);
  updater.emit('error', new Error('https://host/token=secret'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.getState().errorCode, 'install_failed');
  assert.equal(JSON.stringify(service.getState()).includes('secret'), false);
  let notifications = 0;
  const unsubscribe = service.subscribe(() => { notifications += 1; });
  unsubscribe();
  updater.emit('update-not-available', {});
  assert.equal(notifications, 0);
  service.dispose();
  assert.equal(updater.listenerCount('error'), 0);
});

caseTest('update check/download failures keep the application running and support retries', async () => {
  const { EventEmitter } = require('node:events');
  const { UpdateService } = require('../../dist-desktop/update-service.js');
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => { throw new Error('403'); };
  updater.downloadUpdate = async () => { throw new Error('checksum failed'); };
  updater.quitAndInstall = () => { throw new Error('must not install'); };
  const service = new UpdateService(updater, '3.22.0', true, { prepare: async () => {}, recover: async () => {}, onInstalling: () => {} });
  await service.check();
  assert.equal(service.getState().errorCode, 'check_failed');
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '3.23.0' });
  await service.check();
  await service.download();
  assert.equal(service.getState().errorCode, 'download_failed');
  await service.install();
  updater.downloadUpdate = async () => updater.emit('update-downloaded', { version: '3.23.0' });
  await service.download();
  assert.equal(service.getState().phase, 'downloaded');
  service.dispose();
  const disabled = new UpdateService(updater, '3.22.0', false, { prepare: async () => {}, recover: async () => {}, onInstalling: () => {} });
  await disabled.check();
  assert.equal(disabled.getState().phase, 'disabled');
  disabled.dispose();
});

caseTest('update IPC rejects unrelated windows, subframes and foreign origins', () => {
  const { assertUpdateSender } = require('../../dist-desktop/update-service.js');
  const frame = { url: 'http://127.0.0.1:3000/' };
  const contents = { mainFrame: frame };
  const window = { webContents: contents };
  const event = { sender: contents, senderFrame: frame };
  assert.doesNotThrow(() => assertUpdateSender(event, window, 'http://127.0.0.1:3000'));
  assert.throws(() => assertUpdateSender(event, null, 'http://127.0.0.1:3000'));
  assert.throws(() => assertUpdateSender({ ...event, sender: {} }, window, 'http://127.0.0.1:3000'));
  assert.throws(() => assertUpdateSender({ ...event, senderFrame: { ...frame } }, window, 'http://127.0.0.1:3000'));
  assert.throws(() => assertUpdateSender(event, window, 'https://example.org'));
});

caseTest('cache restoration uses the pinned updater verifier and never downloads on a miss', async (t: any) => {
  const { AppUpdater } = require('electron-updater/out/AppUpdater.js');
  const { DownloadedUpdateHelper } = require('electron-updater/out/DownloadedUpdateHelper.js');
  const { restoreCachedUpdate } = require('../../dist-desktop/update-cache.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-update-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const body = Buffer.from('verified cached installer');
  const sha512 = crypto.createHash('sha512').update(body).digest('base64');
  const info = { version: '3.23.0', files: [{ url: 'installer.zip', size: body.length, sha512 }] };
  let networkDownloads = 0;
  class CacheTestUpdater extends AppUpdater {
    constructor() {
      super(null, { version: '3.22.0', name: 'TransportX', isPackaged: true });
      this.logger = { info() {}, warn() {}, error() {} };
      this.downloadedUpdateHelper = new DownloadedUpdateHelper(root);
      this.updateInfoAndProvider = { info, provider: {} };
    }
    getOrCreateDownloadHelper() { return Promise.resolve(this.downloadedUpdateHelper); }
    doDownloadUpdate(options: any) {
      return this.executeDownload({ fileExtension: 'zip', fileInfo: { url: new URL('https://updates.test/installer.zip'), info: info.files[0] }, downloadUpdateOptions: options,
        task: async (destination: string) => { networkDownloads += 1; fs.writeFileSync(destination, body); },
        done: async (event: any) => this.dispatchUpdateDownloaded(event),
      });
    }
  }
  const pending = path.join(root, 'pending');
  fs.mkdirSync(pending);
  fs.writeFileSync(path.join(pending, 'installer.zip'), body);
  fs.writeFileSync(path.join(pending, 'update-info.json'), JSON.stringify({ fileName: 'installer.zip', sha512 }));
  const updater = new CacheTestUpdater();
  let restored = 0;
  updater.on('update-downloaded', () => { restored += 1; });
  const execute = updater.executeDownload;
  assert.equal(await restoreCachedUpdate(updater), true);
  assert.equal(restored, 1);
  assert.equal(networkDownloads, 0);
  assert.equal(updater.executeDownload, execute);
  // A new launch must rehash the file, even if the previous launch accepted it.
  fs.writeFileSync(path.join(pending, 'installer.zip'), 'corrupt');
  const restarted = new CacheTestUpdater();
  assert.equal(await restoreCachedUpdate(restarted), false);
  assert.equal(networkDownloads, 0);
  assert.equal(await restoreCachedUpdate(new CacheTestUpdater()), false);
  assert.equal(networkDownloads, 0);
  // A subsequent explicit download still uses the original network task.
  await restarted.downloadUpdate();
  assert.equal(networkDownloads, 1);
});

caseTest('checking restores verified downloaded state while a cache miss keeps user download consent', async () => {
  const { EventEmitter } = require('node:events');
  const { UpdateService } = require('../../dist-desktop/update-service.js');
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => updater.emit('update-available', { version: '3.23.0' });
  updater.downloadUpdate = async () => { throw new Error('Must not automatically download'); };
  updater.quitAndInstall = () => {};
  const installation = { prepare: async () => {}, recover: async () => {}, onInstalling() {} };
  const restored = new UpdateService(updater, '3.22.0', true, installation, async () => { updater.emit('update-downloaded', { version: '3.23.0' }); return true; });
  await restored.check();
  assert.equal(restored.getState().phase, 'downloaded');
  assert.equal(restored.getState().currentVersion, '3.22.0');
  restored.dispose();
  const missed = new UpdateService(updater, '3.22.0', true, installation, async () => false);
  await missed.check();
  assert.equal(missed.getState().phase, 'available');
  missed.dispose();
});

caseTest('supervisor requires acknowledgement and exit, cancels timed-out preparation and can restart', async () => {
  const { EventEmitter } = require('node:events');
  const { AgentHostSupervisor } = require('../../dist-desktop/agent-host-supervisor.js');
  const make = (reply: (child: any, message: any) => void) => {
    const sent: any[] = [];
    const child = new EventEmitter();
    child.postMessage = (message: any) => { sent.push(message); reply(child, message); };
    child.kill = () => { throw new Error('Update must not force termination'); };
    const supervisor = new AgentHostSupervisor({ paths: {}, updatePreparationTimeoutMs: 20 });
    supervisor.child = child;
    child.on('exit', () => { supervisor.child = null; });
    return { child, supervisor, sent };
  };
  for (const exitFirst of [false, true]) {
    const { supervisor } = make((child, message) => {
      if (message.type !== 'transportx-update-stop') return;
      setImmediate(() => {
        if (exitFirst) child.emit('exit', 0);
        child.emit('message', { type: 'transportx-update-stopped', id: message.id, ok: true });
        if (!exitFirst) child.emit('exit', 0);
      });
    });
    await supervisor.stopForUpdate();
    let starts = 0;
    supervisor.start = async () => { starts += 1; return 'http://127.0.0.1:1234'; };
    assert.equal(await supervisor.recoverAfterUpdate(), 'http://127.0.0.1:1234');
    assert.equal(starts, 1);
  }
  const busy = make((child, message) => {
    if (message.type === 'transportx-update-stop') setImmediate(() => child.emit('message', { type: 'transportx-update-stopped', id: message.id, ok: false, code: 'host_busy' }));
  });
  await assert.rejects(busy.supervisor.stopForUpdate(), (error: any) => error.code === 'host_busy');
  assert.equal(busy.supervisor.stopping, false);
  assert.equal(await busy.supervisor.recoverAfterUpdate(), null);
  const timedOut = make(() => {});
  await assert.rejects(timedOut.supervisor.stopForUpdate(), /timed out/);
  assert.equal(timedOut.sent.at(-1).type, 'transportx-update-cancel');
  assert.equal(timedOut.supervisor.stopping, false);
  assert.equal(timedOut.child.listenerCount('message'), 0);
  const noConfirmation = make((child, message) => { if (message.type === 'transportx-update-stop') setImmediate(() => child.emit('exit', 0)); });
  await assert.rejects(noConfirmation.supervisor.stopForUpdate(), /timed out/);
});

caseTest('Host update preparation locks new work, refuses active work and unlocks on failure/cancellation', async () => {
  const { UpdatePreparation } = require('../../bin/update-preparation.js');
  const gate = new UpdatePreparation();
  const complete = gate.beginOperation();
  await assert.rejects(gate.prepare('one', async () => {}), (error: any) => error.code === 'host_busy');
  complete(); complete();
  await assert.rejects(gate.prepare('one', async () => { throw new Error('save failed'); }), /save failed/);
  const finish = gate.beginOperation(); finish();
  let save: () => void = () => {};
  const preparing = gate.prepare('two', () => new Promise<void>((resolve) => { save = resolve; }));
  assert.throws(() => gate.beginOperation(), (error: any) => error.status === 503);
  gate.cancel('wrong-token');
  assert.throws(() => gate.beginOperation());
  gate.cancel('two'); save();
  await assert.rejects(preparing, /cancelled/);
  await gate.prepare('three', async () => {});
  gate.assertPrepared('three');
  gate.cancel('three');
  gate.beginOperation()();
});

caseTest('OSS release validation checks architecture/hashes and publishes the manifest last', async (t: any) => {
  const { pathToFileURL } = require('node:url');
  const yaml = require('js-yaml');
  const { createReleasePlan, publishRelease, assertAcceptance, assertBuildProvenance } = await import(pathToFileURL(path.join(process.cwd(), 'desktop/scripts/publish-oss.mjs')).href);
  const { PLATFORM_PROFILES } = await import(pathToFileURL(path.join(process.cwd(), 'desktop/scripts/platform-profile.mjs')).href);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profile = PLATFORM_PROFILES.darwin;
  const files = profile.update.requiredExtensions.map((extension: string) => {
    const name = profile.update.artifactName.replace('${version}', '3.23.0').replace('${ext}', extension.slice(1));
    const file = path.join(directory, name);
    fs.writeFileSync(file, `signed-artifact-fixture${extension}`);
    return { url: name, size: fs.statSync(file).size, sha512: crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64') };
  });
  const manifest = { version: '3.23.0', releaseNotes: 'Notes', files };
  const manifestPath = path.join(directory, profile.update.manifest);
  fs.writeFileSync(manifestPath, yaml.dump(manifest));
  const plan = createReleasePlan(directory, '3.23.0', profile);
  assert.equal(plan.files.length, 2);
  assert.throws(() => createReleasePlan(directory, '3.24.0', profile), /mixed-version/);
  files[0].sha512 = 'invalid'; fs.writeFileSync(manifestPath, yaml.dump(manifest));
  assert.throws(() => createReleasePlan(directory, '3.23.0', profile), /SHA-512/);
  files[0].sha512 = crypto.createHash('sha512').update(fs.readFileSync(path.join(directory, files[0].url))).digest('base64');
  fs.writeFileSync(manifestPath, yaml.dump(manifest));
  const sequence: string[] = [];
  const io = {
    readManifest: async () => 'version: 3.22.0\n',
    record: async (record: any) => { sequence.push(record.stage); },
    assertAbsent: async () => {},
    upload: async (_file: any, mutable: boolean) => { sequence.push(mutable ? 'manifest' : 'package'); },
    verify: async (_file: any, mutable: boolean) => { sequence.push(mutable ? 'verify-manifest' : 'verify-package'); },
  };
  await publishRelease(plan, io);
  assert.deepEqual(sequence, ['prepared', ...Array.from({ length: 7 }, () => ['package', 'verify-package']).flat(), 'manifest', 'verify-manifest', 'published']);
  const revision = 'a'.repeat(40);
  const runtime = { product: { version: plan.version }, source: { revision, dirty: false, dependencyLockSha256: 'lock-hash' } };
  assert.doesNotThrow(() => assertBuildProvenance(runtime, plan.version, revision, 'lock-hash'));
  assert.throws(() => assertBuildProvenance({ ...runtime, source: { ...runtime.source, dirty: true } }, plan.version, revision, 'lock-hash'), /provenance/);
  assert.throws(() => assertBuildProvenance(runtime, plan.version, 'b'.repeat(40), 'lock-hash'), /provenance/);
  assert.throws(() => assertBuildProvenance(runtime, plan.version, revision, 'different-lock'), /provenance/);
  const acceptance = { version: plan.version, profile: plan.profile, sourceRevision: revision, testedFromVersion: '3.22.1', testedAt: '2026-10-09T00:00:00Z', testedBy: 'tester', signingIdentity: 'Developer ID fixture', evidence: ['upgrade.log'], signed: true, upgradePassed: true, dataPreserved: true, normalQuitDoesNotInstall: true, sha256: Object.fromEntries(plan.files.map((file: any) => [file.name, file.sha256])) };
  assert.doesNotThrow(() => assertAcceptance(plan, acceptance, revision));
  assert.throws(() => assertAcceptance(plan, acceptance, 'b'.repeat(40)), /source commit/);
  assert.throws(() => assertAcceptance(plan, { ...acceptance, sha256: {} }, revision), /artifacts/);
  assert.throws(() => assertAcceptance(plan, { ...acceptance, evidence: [] }, revision), /evidence/);
  assert.throws(() => assertAcceptance(plan, { ...acceptance, testedFromVersion: '3.24.0' }, revision), /previous version/);
  sequence.length = 0;
  await assert.rejects(publishRelease(plan, { ...io, upload: async () => { throw new Error('upload failed'); } }), /upload failed/);
  assert.equal(sequence.includes('manifest'), false);
  await assert.rejects(publishRelease(plan, { ...io, verify: async () => { throw new Error('verification failed'); } }), /verification failed/);
  assert.equal(sequence.includes('manifest'), false);
  await assert.rejects(publishRelease(plan, { ...io, readManifest: async () => 'version: 3.24.0\n' }), /newer/);
});

caseTest('path utilities produce host-stable POSIX output', () => {
  // toPosixPath on a Windows-shaped path must always yield forward slashes.
  assert.equal(toPosixPath('a\\b\\c'), 'a/b/c');
  assert.equal(toPosixPath('a\\\\b'), 'a/b');
  assert.equal(toPosixPath(''), '');
  // relativePosixPath runs path.relative first, then POSIX-normalizes.
  assert.equal(relativePosixPath(path.resolve('/tmp'), path.resolve('/tmp/foo/bar')), 'foo/bar');
  // Windows path semantics must be supplied by path.win32 when the test runs
  // on another host; path.resolve intentionally uses the current host only.
  assert.equal(toPosixPath(path.win32.relative('C:\\tmp', 'C:\\tmp\\foo\\bar')), 'foo/bar');
  // isWithin re-exports the canonical asset-integrity boundary formula and
  // must reject symlink-shaped escapes regardless of host.
  assert.equal(isWithin(path.resolve('/root'), path.resolve('/root/inner')), true);
  assert.equal(isWithin(path.resolve('/root'), path.resolve('/root-evil')), false);
});

caseTest('platform-profile registry exposes frozen mac/win profiles with required contract', async () => {
  const url = require('node:url');
  const profilePath = path.join(__dirname, '..', '..', 'desktop', 'scripts', 'platform-profile.mjs');
  const profileModule = await import(url.pathToFileURL(profilePath).toString());
  const { PLATFORM_PROFILES, PROCESS_PLATFORM_TO_BUILDER, getPlatformProfile, builderPlatformFor } = profileModule;

  // mac/win mapping is stable; adding linux must be an explicit PR change here.
  assert.deepEqual({ ...PROCESS_PLATFORM_TO_BUILDER }, { darwin: 'mac', win32: 'win', linux: 'linux' });
  assert.equal(builderPlatformFor('darwin'), 'mac');
  assert.equal(builderPlatformFor('win32'), 'win');
  assert.equal(getPlatformProfile(builderPlatformFor('darwin')), PLATFORM_PROFILES.darwin);
  assert.equal(getPlatformProfile(builderPlatformFor('win32')), PLATFORM_PROFILES.win);

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
  assert.equal(mac.release.requiresFfmpeg, false, 'base macOS package excludes the optional video runtime');
  assert.equal(mac.ffmpeg.binName('ffmpeg'), 'ffmpeg', 'mac ffmpeg binary must not have a suffix');
  assert.equal(mac.ffmpeg.chmodRequired, true, 'mac ffmpeg needs +x');
  assert.equal(mac.ffmpeg.arch, 'arm64');
  assert.equal(mac.signing.hostArchRequired, 'arm64');
  assert.equal(mac.python.entry, 'bin/python3');

  const win = PLATFORM_PROFILES.win;
  assert.equal(win.release.requiresFfmpeg, false, 'base Windows package excludes the optional video runtime');
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

caseTest('check-desktop-release composes per-OS requirements behind one dispatcher', () => {
  const check = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'scripts', 'check-desktop-release.mjs'), 'utf8');
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

caseTest('base runtime packages Python without the optional video runtime', () => {
  const prepare = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'scripts', 'prepare-runtime.mjs'), 'utf8');
  const videoPack = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'scripts', 'package-video-capability.mjs'), 'utf8');
  // Profile is the canonical data source.
  assert.match(prepare, /import \{ getPlatformProfile \} from '\.\/platform-profile\.mjs'/);
  // Python stays in the base installer; ffmpeg moves to the platform-specific Video Capability package.
  assert.match(prepare, /profile\.python\.entry/);
  assert.match(prepare, /profile\.python\.archCheck\(pythonProbe\.machine\)/);
  assert.doesNotMatch(prepare, /profile\.ffmpeg/);
  assert.match(videoPack, /profile\.ffmpeg\.binName/);
  assert.match(videoPack, /profile\.ffmpeg\.chmodRequired/);
  assert.match(videoPack, /profile\.ffmpeg\.archCheck\(target\)/);
  // Error message references profile fields, not platform literals, so a future
  // Linux profile inherits correct guidance.
  assert.match(prepare, /Bundled \$\{profile\.label\} Python must be \$\{profile\.python\.archErrorMessage\}/);
  // Hardcoded OS checks must NOT appear in the production script.
  assert.doesNotMatch(prepare, /process\.platform === '(?:darwin|win32)'/);
  assert.doesNotMatch(prepare, /python\.exe/);
  assert.doesNotMatch(prepare, /ffmpeg\.exe/);
});

caseTest('desktop app paths keep durable data outside application resources', () => {
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

caseTest('Windows desktop app paths use roaming user data outside application resources', () => {
  const appData = process.platform === 'win32' ? 'C:\\Users\\example\\AppData\\Roaming' : '/Users/example/AppData/Roaming';
  const paths = resolveAppPaths({ APPDATA: appData, TAU_APP_ROOT: '/opt/TransportX/resources/app.asar', TAU_RESOURCES_DIR: '/opt/TransportX/resources' }, 'win32');
  // Mirror the macOS vendor/product split: %APPDATA%\TransportX\traffic-agent\
  assert.equal(paths.userDataDir, path.join(appData, 'TransportX', 'traffic-agent'));
  assert.equal(paths.scenarioDir, path.join(paths.userDataDir, 'scenario'));
  assert.equal(paths.modulesDir, path.join(paths.userDataDir, 'modules'));
  assert.ok(!paths.userDataDir.startsWith(paths.resourcesDir));
});

caseTest('runtime manifest validates relative paths and checksums', (t: any) => {
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
    product: { name: 'TransportX Agent', version: '3.0.3' },
    agentHost: { ...entry('agent-host/tau.js', '3.0.3'), protocolVersion: 1 },
    pi: entry('runtimes/pi/cli.js', '0.80.10'),
    python: entry('runtimes/python/python', '3.10.0'),
  }));
  assert.equal(loadRuntimeManifest(root).product.name, 'TransportX Agent');
  assert.equal(validateRuntimeManifest(root).pi, path.join(root, 'runtimes/pi/cli.js'));
  fs.writeFileSync(path.join(root, 'runtimes/pi/cli.js'), 'tampered');
  assert.throws(() => validateRuntimeManifest(root), /checksum mismatch/);
});

caseTest('ffmpeg executables resolve from the packaged manifest, env overrides, or dev PATH', (t: any) => {
  const { resolveFfmpegExecutables } = require('../../bin/runtime-resolver.js');

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
    product: { name: 'TransportX Agent', version: '3.0.9' },
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
  const supervisor = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'agent-host-supervisor.ts'), 'utf8');
  assert.match(supervisor, /TAU_FFMPEG_COMMAND/);
  assert.match(supervisor, /TAU_FFPROBE_COMMAND/);
  assert.match(supervisor, /Buffer\.byteLength\(request\.html, 'utf8'\) > 50 \* 1024 \* 1024/);
});

caseTest('unsigned macOS test builds replace Electron linker signatures before creating the DMG', () => {
  const rootBuilder = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'electron-builder.yml'), 'utf8');
  const commonBuilder = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'electron-builder.common.yml'), 'utf8');
  const macBuilder = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'electron-builder.mac.yml'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'main.ts'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'web', 'styles.css'), 'utf8');
  const hook = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'scripts', 'after-pack.cjs'), 'utf8');
  const prepareRuntime = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'scripts', 'prepare-runtime.mjs'), 'utf8');
  const smoke = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'desktop-smoke.mjs'), 'utf8');
  // Top-level electron-builder.yml must compose platform-agnostic + per-OS fragments.
  assert.match(rootBuilder, /extends:[\s\S]*electron-builder\.common\.yml/);
  assert.match(rootBuilder, /extends:[\s\S]*electron-builder\.mac\.yml/);
  assert.match(rootBuilder, /extends:[\s\S]*electron-builder\.win\.yml/);
  assert.match(commonBuilder, /afterPack: desktop\/scripts\/after-pack\.cjs/);
  assert.match(commonBuilder, /asarUnpack:[\s\S]*modules\/\*\*\/skills\/\*\*/);
  assert.match(commonBuilder, /"!modules\/installable\/\*\*"/);
  assert.doesNotMatch(commonBuilder, /runtimes\/ffmpeg/);
  assert.match(commonBuilder, /prompts\/\*\*/);
  assert.match(macBuilder, /target:[\s\S]*dmg/);
  assert.match(macBuilder, /arch: arm64/);
  assert.match(main, /titleBarStyle:[\s\S]*hiddenInset[\s\S]*hidden/);
  assert.match(main, /Menu\.setApplicationMenu\(null\)/);
  assert.match(main, /trafficLightPosition: \{ x: 14, y: 14 \}/);
  assert.match(styles, /data-desktop-platform="darwin".*workspace-header-left.*padding-left: 66px/);
  assert.match(hook, /TRANSPORTX_ALLOW_UNSIGNED_BUILD/);
  assert.match(hook, /npm_lifecycle_event === 'desktop:dir:allow-unsigned'/);
  assert.match(hook, /--verify/);
  assert.match(prepareRuntime, /\['-B', '-I', '-c'/);
  assert.match(smoke, /\['-B', '-I', '-c'/);
});

caseTest('Windows NSIS release stages x64 .exe runtimes and has a profile-aware pre-flight', () => {
  const winBuilder = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'electron-builder.win.yml'), 'utf8');
  const profile = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'scripts', 'platform-profile.mjs'), 'utf8');
  const releaseCheck = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'scripts', 'check-desktop-release.mjs'), 'utf8');
  const prepareRuntime = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'scripts', 'prepare-runtime.mjs'), 'utf8');
  const videoPack = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'scripts', 'package-video-capability.mjs'), 'utf8');
  const installerSmoke = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'windows-installer-smoke.mjs'), 'utf8');
  const smoke = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'desktop-smoke.mjs'), 'utf8');
  assert.match(winBuilder, /icon: app-icon\.ico/);
  assert.match(winBuilder, /target: nsis[\s\S]*arch: x64/);
  assert.match(winBuilder, /deleteAppDataOnUninstall: false/);
  // Profile is the single source of truth for Windows pre-flight requirements.
  assert.match(profile, /win[\s\S]*Authenticode/i);
  assert.match(profile, /hostArchRequired: 'x64'/);
  assert.match(profile, /binName:[\s\S]*\.exe/);
  assert.doesNotMatch(prepareRuntime, /profile\.ffmpeg/);
  assert.match(videoPack, /profile\.ffmpeg\.binName/);
  assert.match(prepareRuntime, /Bundled \$\{profile\.label\} Python must be \$\{profile\.python\.archErrorMessage\}/);
  assert.match(releaseCheck, /WIN_CSC_LINK/);
  assert.match(releaseCheck, /profile\.signing\.description/);
  assert.match(installerSmoke, /TRANSPORTX_WINDOWS_INSTALLER/);
  assert.match(installerSmoke, /Uninstall TransportX Agent\.exe/);
  assert.match(smoke, /process\.platform === 'win32'/);
});
