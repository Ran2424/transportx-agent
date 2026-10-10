import type { AppUpdater, DownloadExecutorTask } from 'electron-updater/out/AppUpdater';

// electron-updater 6.8.3 has no public cache-only restore method. Keep this
// version-specific adapter isolated: its normal cache verifier and platform
// completion path run, but a cache miss cannot start a remote download.
export async function restoreCachedUpdate(updater: AppUpdater): Promise<boolean> {
  const internal = updater as unknown as {
    executeDownload(task: DownloadExecutorTask): Promise<string[]>;
  };
  const execute = internal.executeDownload;
  const cacheMiss = new Error('No verified cached update');
  internal.executeDownload = (task) => execute.call(updater, {
    ...task,
    task: async () => { throw cacheMiss; },
  });
  try {
    await updater.downloadUpdate();
    return true;
  } catch {
    return false;
  } finally {
    internal.executeDownload = execute;
  }
}
