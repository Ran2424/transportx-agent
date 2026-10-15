export type UpdatePhase = 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'unavailable' | 'manual-available' | 'available' | 'downloading' | 'downloaded' | 'preparing' | 'installing' | 'error';
export type UpdateErrorCode = 'check_failed' | 'download_failed' | 'host_busy' | 'prepare_failed' | 'install_failed';

export interface DesktopUpdateState {
  currentVersion: string;
  latestVersion?: string;
  phase: UpdatePhase;
  targetVersion?: string;
  releaseNotes?: string;
  percent?: number;
  errorCode?: UpdateErrorCode;
}

export interface DesktopUpdateBridge {
  getState(): Promise<DesktopUpdateState>;
  check(): Promise<DesktopUpdateState>;
  download(): Promise<DesktopUpdateState>;
  install(): Promise<DesktopUpdateState>;
  subscribe(listener: (state: DesktopUpdateState) => void): () => void;
}
