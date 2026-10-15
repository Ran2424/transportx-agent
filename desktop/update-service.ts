import type { AppUpdater } from 'electron-updater';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { DesktopUpdateState, UpdateErrorCode } from '../src/contracts/desktop-update.js';
import { compareReleaseVersions } from './website-release.js';

type UpdateInfo = { version: string; releaseNotes?: string | Array<{ version: string; note: string | null }> | null };
type UpdateEvent = 'update-available' | 'update-not-available' | 'download-progress' | 'update-downloaded' | 'error';
type Updater = Pick<AppUpdater, 'on' | 'removeListener' | 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall' | 'autoDownload' | 'autoInstallOnAppQuit' | 'allowDowngrade' | 'allowPrerelease'>;
type Installation = {
  prepare(): Promise<void>;
  recover(): Promise<void>;
  onInstalling(): void;
};

export function assertUpdateSender(event: IpcMainInvokeEvent, window: BrowserWindow | null, origin: string) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw new Error('Invalid update request');
}

// The updater owns checksum verification and its persistent download cache.
// Only updater events can move a download into the installable state.
export class UpdateService {
  private state: DesktopUpdateState;
  private operation: Promise<DesktopUpdateState> | null = null;
  private listeners = new Set<(state: DesktopUpdateState) => void>();
  private handlers: Array<[UpdateEvent, (...args: any[]) => void]> = [];
  private installTimeout: ReturnType<typeof setTimeout> | null = null;
  private recovery: Promise<void> | null = null;

  constructor(private updater: Updater, currentVersion: string, enabled: boolean, private installation: Installation, private restoreCache?: () => Promise<boolean>, private readLatestRelease?: () => Promise<string | undefined>) {
    this.state = { currentVersion, phase: enabled ? 'idle' : 'disabled' };
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    this.listen('update-available', (info: UpdateInfo) => {
      if (this.readLatestRelease && this.state.latestVersion !== info.version) this.publishWebsiteState();
      else this.publish({ ...this.info(info), phase: 'available', errorCode: undefined });
    });
    this.listen('update-not-available', (info: UpdateInfo) => this.publishWebsiteState(this.readLatestRelease ? this.state.latestVersion : info.version));
    this.listen('download-progress', (progress: { percent: number }) => {
      if (this.state.phase === 'downloading' && Number.isFinite(progress.percent)) this.publish({ percent: Math.min(100, Math.max(0, progress.percent)) });
    });
    this.listen('update-downloaded', (info: UpdateInfo) => this.publish({ ...this.info(info), phase: 'downloaded', percent: 100, errorCode: undefined }));
    this.listen('error', () => {
      // Raw updater errors can contain signed URLs. Expose fixed error codes.
      // check() handles rejected checks after website discovery, without an error flash.
      if (this.state.phase === 'downloading') this.fail('download_failed');
      else if (this.state.phase === 'installing') void this.recoverInstallation();
    });
  }

  getState(): DesktopUpdateState { return { ...this.state }; }

  subscribe(listener: (state: DesktopUpdateState) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose() {
    if (this.installTimeout) clearTimeout(this.installTimeout);
    for (const [name, handler] of this.handlers) this.updater.removeListener(name, handler);
    this.handlers = [];
    this.listeners.clear();
  }

  check(): Promise<DesktopUpdateState> {
    if (this.operation) return this.operation;
    if (!['idle', 'up-to-date', 'unavailable', 'manual-available', 'available', 'error'].includes(this.state.phase)) return Promise.resolve(this.getState());
    return this.run(async () => {
      this.publish({ phase: 'checking', latestVersion: undefined, targetVersion: undefined, releaseNotes: undefined, errorCode: undefined, percent: undefined });
      try {
        if (this.readLatestRelease) this.publish({ latestVersion: await this.readLatestRelease() });
        await this.updater.checkForUpdates();
        if (this.state.phase === 'available') await this.restoreCache?.();
      }
      catch (error) {
        const failure = error as { code?: string; statusCode?: number };
        if (failure?.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || (this.readLatestRelease && failure?.statusCode === 403)) this.publishWebsiteState();
        else this.fail('check_failed');
      }
    });
  }

  download(): Promise<DesktopUpdateState> {
    if (this.operation) return this.operation;
    if (this.state.phase !== 'available' && !(this.state.phase === 'error' && this.state.errorCode === 'download_failed')) return Promise.resolve(this.getState());
    return this.run(async () => {
      this.publish({ phase: 'downloading', percent: 0, errorCode: undefined });
      try { await this.updater.downloadUpdate(); }
      catch { this.fail('download_failed'); }
    });
  }

  install(): Promise<DesktopUpdateState> {
    if (this.operation) return this.operation;
    if (this.state.phase !== 'downloaded') return Promise.resolve(this.getState());
    return this.run(async () => {
      this.publish({ phase: 'preparing', errorCode: undefined });
      try {
        await this.installation.prepare();
        this.publish({ phase: 'installing' });
        this.installTimeout = setTimeout(() => { void this.recoverInstallation(); }, 45_000);
        this.installTimeout.unref();
        this.installation.onInstalling();
        this.updater.quitAndInstall(false, true);
      } catch (error) {
        const code = (error as { code?: string })?.code;
        await this.recoverInstallation(code === 'host_busy' ? 'host_busy' : this.state.phase === 'preparing' ? 'prepare_failed' : 'install_failed');
      }
    });
  }

  private recoverInstallation(errorCode: UpdateErrorCode = 'install_failed') {
    if (this.recovery) return this.recovery;
    if (this.installTimeout) clearTimeout(this.installTimeout);
    this.installTimeout = null;
    this.recovery = Promise.resolve().then(() => this.installation.recover()).catch(() => { errorCode = 'prepare_failed'; }).then(() => {
      this.publish({ phase: 'downloaded', errorCode });
    }).finally(() => { this.recovery = null; });
    return this.recovery;
  }

  private run(action: () => Promise<void>) {
    const operation = Promise.resolve().then(action).then(() => this.getState()).finally(() => { if (this.operation === operation) this.operation = null; });
    this.operation = operation;
    return operation;
  }

  private info(info: UpdateInfo) {
    const releaseNotes = typeof info.releaseNotes === 'string' ? info.releaseNotes : info.releaseNotes?.map((entry) => `${entry.version}\n${entry.note || ''}`).join('\n\n') || '';
    return { latestVersion: info.version, targetVersion: info.version, releaseNotes: releaseNotes.slice(0, 64 * 1024) };
  }

  private publishWebsiteState(latestVersion = this.state.latestVersion) {
    const phase = !latestVersion ? 'unavailable' : compareReleaseVersions(latestVersion, this.state.currentVersion) > 0 ? 'manual-available' : 'up-to-date';
    this.publish({ phase, latestVersion, targetVersion: undefined, releaseNotes: undefined, errorCode: undefined, percent: undefined });
  }

  private fail(errorCode: UpdateErrorCode) { this.publish({ phase: 'error', errorCode }); }
  private publish(value: Partial<DesktopUpdateState>) {
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener(this.getState());
  }
  private listen(name: UpdateEvent, handler: (...args: any[]) => void) {
    this.handlers.push([name, handler]);
    this.updater.on(name, handler);
  }
}
