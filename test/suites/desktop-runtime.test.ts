const { test } = require('node:test') as typeof import('node:test');

test('Desktop updates, shutdown and packaged runtimes enforce lifecycle and platform boundaries', async (t) => {
  const assert = require('node:assert/strict');
  const crypto = require('node:crypto');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadRuntimeManifest, validateRuntimeManifest } = require('../../bin/runtime-resolver.js');
  const builder = require('js-yaml').load(fs.readFileSync(path.join(process.cwd(), 'desktop/electron-builder.common.yml'), 'utf8'));
  assert.ok(builder.asarUnpack.includes('modules/**'), 'native module browsing needs complete physical module folders');
  assert.ok(builder.asarUnpack.includes('src/contracts/**'), 'unpacked extensions retain their relative contract imports');
  assert.ok(builder.asarUnpack.includes('dist/module-extensions/**'), 'remapped bundled entries must also be unpacked by their source path');

  // Physical module folders must still load through Pi's extension loader.
  {
    const unpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-unpacked-modules-'));
    t.after(() => fs.rmSync(unpacked, { recursive: true, force: true }));
    const capabilities = path.join(unpacked, 'modules', 'capabilities');
    fs.cpSync(path.join(process.cwd(), 'modules', 'capabilities'), capabilities, { recursive: true });
    fs.cpSync(path.join(process.cwd(), 'dist', 'module-extensions', 'capabilities'), capabilities, { recursive: true });
    assert.equal(fs.existsSync(path.join(unpacked, 'modules', 'shared')), false, 'private build helpers are not runtime dependencies');
    fs.cpSync(path.join(process.cwd(), 'src', 'contracts'), path.join(unpacked, 'src', 'contracts'), { recursive: true });
    const entries = fs.readdirSync(capabilities, { withFileTypes: true }).filter((entry: any) => entry.isDirectory()).flatMap((entry: any) => {
      const root = path.join(capabilities, entry.name);
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
      return (manifest.entrypoints?.piExtensions || []).map((entry: string) => path.join(root, entry));
    });
    const { pathToFileURL } = require('node:url');
    const { loadExtensions } = await import(pathToFileURL(path.join(process.cwd(), 'node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')).href);
    const loaded = await loadExtensions(entries, unpacked);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, entries.length);
  }

  // Persistent logs redact credentials, retain bounded archives and tolerate unavailable storage.
  {
    const { createDiagnosticLogger } = require('../../bin/diagnostic-log.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-log-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'runtime.jsonl');
    const log = createDiagnosticLogger(file, 512);
    for (let index = 0; index < 12; index++) log('warn', 'test_event', { index, message: '日志'.repeat(20) });
    assert.deepEqual(fs.readdirSync(root).sort(), ['runtime.jsonl', 'runtime.jsonl.1', 'runtime.jsonl.2', 'runtime.jsonl.3']);
    for (const name of fs.readdirSync(root)) {
      assert.ok(fs.statSync(path.join(root, name)).size <= 512);
      for (const line of fs.readFileSync(path.join(root, name), 'utf8').trim().split('\n')) assert.ok(JSON.parse(line).at);
    }
    const safe = path.join(root, 'safe.jsonl');
    createDiagnosticLogger(safe)('error', 'provider_failed', { sessionId: 'session-1', apiKey: 'field-secret', nested: { token: 'nested-secret' }, message: 'Authorization: Bearer bearer-secret api_key=query-secret password="password-secret" {"apiKey":"json-secret"} OPENAI_API_KEY=env-secret API key=space-secret', path: '\\\\server\\share\\report.csv' });
    createDiagnosticLogger(safe)('info', 'next_start');
    const contents = fs.readFileSync(safe, 'utf8');
    assert.doesNotMatch(contents, /field-secret|nested-secret|bearer-secret|query-secret|password-secret|json-secret|env-secret|space-secret/);
    const records = contents.trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 2);
    assert.equal(records[0].sessionId, 'session-1');
    assert.equal(records[0].path, '//server/share/report.csv');
    const blocked = path.join(root, 'blocked');
    fs.writeFileSync(blocked, 'file');
    const warnings: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => { warnings.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try { const unavailable = createDiagnosticLogger(path.join(blocked, 'error.log')); unavailable('error', 'one'); unavailable('error', 'two'); }
    finally { process.stderr.write = originalWrite; }
    assert.equal(warnings.length, 1);
  }

  function digest(filePath: string) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  }

  // Website discovery reads only stable installers for the current platform on the official download host.
  {
    const { pathToFileURL } = require('node:url');
    const { PLATFORM_PROFILES } = await import(pathToFileURL(path.join(process.cwd(), 'desktop/scripts/platform-profile.mjs')).href);
    const { websiteReleaseVersion } = require('../../dist-desktop/website-release.js');
    const html = `<a href=https://download.transkgllm.com/releases/v3.9.0/TransportX-Agent-3.9.0-arm64.dmg>Old Mac</a>
      <a href="https://download.transkgllm.com/releases/v3.22.0/TransportX-Agent-3.22.0-mac-arm64.dmg">Mac</a>
      <a href='https://download.transkgllm.com/releases/v3.24.0/TransportX.Agent-3.24.0-win-x64-setup.exe'>Windows</a>
      <a href="https://other.test/releases/v9.0.0/TransportX-Agent-9.0.0-arm64.dmg">Foreign host</a>
      <a href="https://download.transkgllm.com/releases/v9.0.0/TransportX-Agent-8.0.0-arm64.dmg">Mixed versions</a>
      <a href="https://download.transkgllm.com/releases/v9.0.0/TransportX-Agent-9.0.0-arm64.dmg.sha256">Checksum</a>
      <a href="https://download.transkgllm.com/releases/v9.0.0-beta/TransportX-Agent-9.0.0-beta-arm64.dmg">Prerelease</a>`;
    assert.equal(websiteReleaseVersion(html, PLATFORM_PROFILES.darwin.update.websiteInstallerPattern), '3.22.0');
    assert.equal(websiteReleaseVersion(html, PLATFORM_PROFILES.win.update.websiteInstallerPattern), '3.24.0');
    assert.equal(websiteReleaseVersion('<a href=/guide/>Guide</a>', PLATFORM_PROFILES.darwin.update.websiteInstallerPattern), undefined);
  }

  // desktop updates require explicit download and install, deduplicate actions and recover failures
  {
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
      onInstalling: () => { },
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
  }

  // update check/download failures keep the application running and support retries
  {
    const { EventEmitter } = require('node:events');
    const { UpdateService } = require('../../dist-desktop/update-service.js');
    const updater = new EventEmitter();
    updater.checkForUpdates = async () => { throw new Error('403'); };
    updater.downloadUpdate = async () => { throw new Error('checksum failed'); };
    updater.quitAndInstall = () => { throw new Error('must not install'); };
    const service = new UpdateService(updater, '3.22.0', true, { prepare: async () => { }, recover: async () => { }, onInstalling: () => { } });
    await service.check();
    assert.equal(service.getState().errorCode, 'check_failed');
    const missingManifest = Object.assign(new Error('Cannot find channel update info: https://host/token=secret'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' });
    const checkStates: Array<{ phase: string; errorCode?: string }> = [];
    const unsubscribe = service.subscribe((state: { phase: string; errorCode?: string }) => checkStates.push(state));
    for (const emitError of [false, true]) {
      updater.emit('update-available', { version: '3.23.0', releaseNotes: 'Old notes' });
      checkStates.length = 0;
      updater.checkForUpdates = async () => { if (emitError) updater.emit('error', missingManifest); throw missingManifest; };
      const state = await service.check();
      assert.equal(state.phase, 'unavailable');
      assert.equal(state.errorCode, undefined);
      assert.equal(state.targetVersion, undefined);
      assert.equal(state.releaseNotes, undefined);
      assert.ok(checkStates.every((value) => value.phase !== 'error' && !value.errorCode));
      assert.equal(JSON.stringify(state).includes('secret'), false);
    }
    unsubscribe();
    updater.checkForUpdates = async () => updater.emit('update-not-available', { version: '3.22.0' });
    assert.equal((await service.check()).phase, 'up-to-date');
    assert.equal(service.getState().latestVersion, '3.22.0');
    for (const error of [Object.assign(new Error('network failed'), { code: 'ECONNRESET' }), Object.assign(new Error('404'), { statusCode: 404 })]) {
      updater.checkForUpdates = async () => { updater.emit('error', error); throw error; };
      const state = await service.check();
      assert.equal(state.phase, 'error');
      assert.equal(state.errorCode, 'check_failed');
    }
    updater.checkForUpdates = async () => updater.emit('update-available', { version: '3.23.0' });
    await service.check();
    await service.download();
    assert.equal(service.getState().errorCode, 'download_failed');
    await service.install();
    updater.downloadUpdate = async () => updater.emit('update-downloaded', { version: '3.23.0' });
    await service.download();
    assert.equal(service.getState().phase, 'downloaded');
    service.dispose();
    const disabled = new UpdateService(updater, '3.22.0', false, { prepare: async () => { }, recover: async () => { }, onInstalling: () => { } });
    await disabled.check();
    assert.equal(disabled.getState().phase, 'disabled');
    disabled.dispose();
  }

  // Website releases remain discoverable before the signed automatic-update feed is public.
  {
    const { EventEmitter } = require('node:events');
    const { UpdateService } = require('../../dist-desktop/update-service.js');
    const updater = new EventEmitter();
    const forbidden = Object.assign(new Error('403'), { statusCode: 403 });
    updater.checkForUpdates = async () => { updater.emit('error', forbidden); throw forbidden; };
    let downloads = 0, installs = 0, websiteVersion: string | undefined = '3.22.0';
    updater.downloadUpdate = async () => { downloads += 1; updater.emit('update-downloaded', { version: websiteVersion }); };
    updater.quitAndInstall = () => { installs += 1; };
    const service = new UpdateService(updater, '3.23.0', true, { prepare: async () => { }, recover: async () => { }, onInstalling: () => { } }, undefined, async () => websiteVersion);
    const checkStates: Array<{ phase: string }> = [];
    service.subscribe((state: { phase: string }) => checkStates.push(state));
    assert.equal((await service.check()).phase, 'up-to-date');
    assert.equal(service.getState().latestVersion, '3.22.0');
    assert.ok(checkStates.every((value) => value.phase !== 'error'));
    websiteVersion = '3.24.0';
    assert.equal((await service.check()).phase, 'manual-available');
    assert.equal(service.getState().errorCode, undefined);
    assert.equal(service.getState().latestVersion, '3.24.0');
    await service.download();
    await service.install();
    assert.equal(downloads, 0);
    assert.equal(installs, 0);
    updater.checkForUpdates = async () => updater.emit('update-available', { version: '3.23.1' });
    assert.equal((await service.check()).phase, 'manual-available', 'a stale manifest cannot install a different version from the website');
    updater.checkForUpdates = async () => updater.emit('update-available', { version: '3.24.0' });
    assert.equal((await service.check()).phase, 'available');
    await service.download();
    assert.equal(service.getState().phase, 'downloaded');
    assert.equal(downloads, 1);
    service.dispose();
    const unavailable = new UpdateService(updater, '3.23.0', true, { prepare: async () => { }, recover: async () => { }, onInstalling: () => { } }, undefined, async () => { throw new Error('Website unavailable'); });
    assert.equal((await unavailable.check()).errorCode, 'check_failed', 'a website network failure is not reported as no update');
    unavailable.dispose();
  }

  // update IPC rejects unrelated windows, subframes and foreign origins
  {
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
  }

  // cache restoration uses the pinned updater verifier and never downloads on a miss
  {
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
        this.logger = { info() { }, warn() { }, error() { } };
        this.downloadedUpdateHelper = new DownloadedUpdateHelper(root);
        this.updateInfoAndProvider = { info, provider: {} };
      }
      getOrCreateDownloadHelper() { return Promise.resolve(this.downloadedUpdateHelper); }
      doDownloadUpdate(options: any) {
        return this.executeDownload({
          fileExtension: 'zip', fileInfo: { url: new URL('https://updates.test/installer.zip'), info: info.files[0] }, downloadUpdateOptions: options,
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
  }

  // supervisor requires acknowledgement and exit, cancels timed-out preparation and can restart
  {
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
    const timedOut = make(() => { });
    await assert.rejects(timedOut.supervisor.stopForUpdate(), /timed out/);
    assert.equal(timedOut.sent.at(-1).type, 'transportx-update-cancel');
    assert.equal(timedOut.supervisor.stopping, false);
    assert.equal(timedOut.child.listenerCount('message'), 0);
    const noConfirmation = make((child, message) => { if (message.type === 'transportx-update-stop') setImmediate(() => child.emit('exit', 0)); });
    await assert.rejects(noConfirmation.supervisor.stopForUpdate(), /timed out/);
    const normal = make((child, message) => {
      assert.equal(message.type, 'transportx-agent-host-stop');
      setImmediate(() => child.emit('exit', 0));
    });
    await normal.supervisor.stop();
    assert.deepEqual(normal.sent, [{ type: 'transportx-agent-host-stop' }]);
    assert.equal(normal.supervisor.child, null);
    // ChildProcess (Windows) follows the same IPC path, even with immediate exit.
    const windowsChild = make((child, message) => {
      assert.equal(message.type, 'transportx-agent-host-stop');
      child.emit('exit', 0);
    });
    windowsChild.child.send = windowsChild.child.postMessage;
    delete windowsChild.child.postMessage;
    windowsChild.child.exitCode = null;
    windowsChild.child.signalCode = null;
    await windowsChild.supervisor.stop();
    assert.equal(windowsChild.supervisor.child, null);
    assert.deepEqual(windowsChild.sent, [{ type: 'transportx-agent-host-stop' }]);
  }

  // Host update preparation locks new work, refuses active work and unlocks on failure/cancellation
  {
    const { UpdatePreparation } = require('../../bin/update-preparation.js');
    const gate = new UpdatePreparation();
    const complete = gate.beginOperation();
    await assert.rejects(gate.prepare('one', async () => { }), (error: any) => error.code === 'host_busy');
    complete(); complete();
    await assert.rejects(gate.prepare('one', async () => { throw new Error('save failed'); }), /save failed/);
    const finish = gate.beginOperation(); finish();
    let save: () => void = () => { };
    const preparing = gate.prepare('two', () => new Promise<void>((resolve) => { save = resolve; }));
    assert.throws(() => gate.beginOperation(), (error: any) => error.status === 503);
    gate.cancel('wrong-token');
    assert.throws(() => gate.beginOperation());
    gate.cancel('two'); save();
    await assert.rejects(preparing, /cancelled/);
    await gate.prepare('three', async () => { });
    gate.assertPrepared('three');
    gate.cancel('three');
    gate.beginOperation()();
  }

  // OSS release validation checks architecture/hashes and publishes the manifest last
  {
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
      assertAbsent: async () => { },
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
  }

  // platform-profile registry exposes frozen mac/win profiles with required contract
  {
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
    if (builderPlatformFor() === 'mac') {
      const { spawnSync } = require('node:child_process');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-internal-signature-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const appId = 'com.transportx.traffic-agent';
      for (const version of [1, 2]) {
        const source = path.join(root, `${version}.c`), binary = path.join(root, `${version}.bin`);
        fs.writeFileSync(source, `int main(){return ${version};}\n`);
        const compiled = spawnSync('clang', [source, '-o', binary], { encoding: 'utf8' });
        assert.equal(compiled.status, 0, compiled.stderr);
        const signed = spawnSync('codesign', ['--force', '--sign', '-', '--identifier', appId, '--requirements', PLATFORM_PROFILES.darwin.signing.internalUpdateRequirement(appId), binary], { encoding: 'utf8' });
        assert.equal(signed.status, 0, signed.stderr);
      }
      const signature = spawnSync('codesign', ['-d', '-r-', path.join(root, '1.bin')], { encoding: 'utf8' });
      const requirement = (signature.stdout + signature.stderr).split('\n').find((line: string) => line.startsWith('designated => '));
      assert.ok(requirement);
      assert.doesNotMatch(requirement, /cdhash/);
      const verified = spawnSync('codesign', ['--verify', '--strict', '-R', '=' + requirement.slice('designated => '.length), path.join(root, '2.bin')], { encoding: 'utf8' });
      assert.equal(verified.status, 0, verified.stderr);
      const rejected = spawnSync('codesign', ['--verify', '--strict', '-R', '=identifier "com.transportx.foreign-app"', path.join(root, '2.bin')], { encoding: 'utf8' });
      assert.notEqual(rejected.status, 0);
      const fixture = path.join(root, 'Fixture.app');
      const helper = path.join(fixture, 'Contents/Frameworks/Helper.app');
      for (const [bundle, identifier, binary] of [[fixture, appId, '1.bin'], [helper, 'com.transportx.helper', '2.bin']]) {
        fs.mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true });
        fs.copyFileSync(path.join(root, binary), path.join(bundle, 'Contents/MacOS/run'));
        fs.writeFileSync(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>run</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
      }
      const previousUnsigned = process.env.TRANSPORTX_ALLOW_UNSIGNED_BUILD;
      try {
        process.env.TRANSPORTX_ALLOW_UNSIGNED_BUILD = '1';
        await require('../../desktop/scripts/after-pack.cjs')({ electronPlatformName: 'darwin', appOutDir: root, packager: { appInfo: { productFilename: 'Fixture', id: appId } } });
      } finally {
        if (previousUnsigned === undefined) delete process.env.TRANSPORTX_ALLOW_UNSIGNED_BUILD;
        else process.env.TRANSPORTX_ALLOW_UNSIGNED_BUILD = previousUnsigned;
      }
      const helperVerified = spawnSync('codesign', ['--verify', '--strict', helper], { encoding: 'utf8' });
      assert.equal(helperVerified.status, 0, helperVerified.stderr);
    } else t.diagnostic('Native ad-hoc requirement checks run on the macOS CI host.');

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
  }

  // runtime manifest validates relative paths and checksums
  {
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
  }

  // ffmpeg executables resolve from the packaged manifest, env overrides, or dev PATH
  {
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
  }

  // generated Host operations match the single profile and include process-tree and opening facts
  {
    const { pathToFileURL } = require('node:url');
    const { HOST_PLATFORM_OPERATIONS } = await import(pathToFileURL(path.resolve('desktop/scripts/platform-profile.mjs')).href);
    const generated = JSON.parse(fs.readFileSync(path.resolve('bin/host-platform.json'), 'utf8'));
    assert.deepEqual(generated, HOST_PLATFORM_OPERATIONS);
    assert.equal(generated.win32.detached, false);
    assert.equal(generated.win32.treeCommand, 'taskkill');
    assert.deepEqual(generated.win32.treeArgs, ['/pid', '/T']);
    assert.equal(generated.darwin.utilityHost, true);
    assert.equal(generated.linux.packaged, null);
    assert.equal(generated.darwin.systemPrompt, 'PI_SYSTEM_POSIX.md');
    assert.equal(generated.linux.systemPrompt, 'PI_SYSTEM_POSIX.md');
    assert.equal(generated.win32.systemPrompt, 'PI_SYSTEM_WINDOWS.md');
    const { toPosixPath } = require('../../bin/util/path.js');
    assert.equal(toPosixPath('C:\\tasks\\report'), 'C:/tasks/report');
    assert.equal(toPosixPath('\\\\server\\share\\tasks\\report'), '//server/share/tasks/report');
    const { loadSystemPrompt } = require('../../bin/session-prompt.js');
    const promptRoot = path.resolve('src/server/prompts');
    const basePrompt = fs.readFileSync(path.join(promptRoot, 'PI_SYSTEM.md'), 'utf8').trim();
    const posixPrompt = fs.readFileSync(path.join(promptRoot, 'PI_SYSTEM_POSIX.md'), 'utf8').trim();
    const windowsPrompt = fs.readFileSync(path.join(promptRoot, 'PI_SYSTEM_WINDOWS.md'), 'utf8').trim();
    assert.equal(loadSystemPrompt('darwin'), `${basePrompt}\n\n${posixPrompt}`);
    assert.equal(loadSystemPrompt('linux'), `${basePrompt}\n\n${posixPrompt}`);
    assert.equal(loadSystemPrompt('win32'), `${basePrompt}\n\n${windowsPrompt}`);
    assert.match(loadSystemPrompt('win32'), /2>nul/);
    assert.match(loadSystemPrompt('win32'), /2>\/dev\/null/);
    assert.throws(() => loadSystemPrompt('freebsd'), /Host operations missing/);
    const source = ['src/server/sessions.ts', 'src/server/process-runner.ts', 'src/server/process-tree.ts', 'src/server/file-api-handler.ts', 'src/server/server-main.ts', 'desktop/main.ts', 'desktop/agent-host-supervisor.ts'].map(file => fs.readFileSync(path.resolve(file), 'utf8')).join('\n');
    assert.doesNotMatch(source, /process\.platform\s*[!=]==\s*['"]/);
  }
});
