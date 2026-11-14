import type { TestContext } from 'node:test';

async function assertDesktopUpdates(t: TestContext) {
  const assert = require('node:assert/strict');
  const crypto = require('node:crypto');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

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
}

module.exports = { assertDesktopUpdates };
