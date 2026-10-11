import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DesktopUpdateBridge, DesktopUpdateState } from '../../../contracts/desktop-update.js';
import { Button } from '../../components/ui/button';

function bridge() {
  return (window as Window & { transportxDesktop?: { update?: DesktopUpdateBridge } }).transportxDesktop?.update;
}

export function useDesktopUpdate() {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  useEffect(() => {
    const update = bridge();
    if (!update) return;
    let current = true;
    let receivedEvent = false;
    const unsubscribe = update.subscribe((value) => { receivedEvent = true; if (current) setState(value); });
    void update.getState().then((value) => { if (current && !receivedEvent) setState(value); }).catch(() => {});
    return () => { current = false; unsubscribe(); };
  }, []);
  return state;
}

export function SoftwareUpdate() {
  const { t } = useTranslation();
  const state = useDesktopUpdate();
  const [requestFailed, setRequestFailed] = useState(false);
  if (!state) return null;
  async function act(action: 'check' | 'download' | 'install') {
    setRequestFailed(false);
    try { await bridge()![action](); } catch { setRequestFailed(true); }
  }
  const busy = ['checking', 'downloading', 'preparing', 'installing'].includes(state.phase);
  return <section className="settings-section software-update" data-testid="software-update">
    <h2>{t('update.title')}</h2>
    <div className="settings-row"><span><strong>{t('update.currentVersion', { version: state.currentVersion })}</strong><small role="status">{t(`update.phase.${state.phase}`, { version: state.targetVersion })}</small></span>
      <Button type="button" variant="outline" disabled={busy || ['disabled', 'downloaded'].includes(state.phase)} onClick={() => void act('check')}>{t('update.check')}</Button>
    </div>
    {state.targetVersion ? <p>{t('update.targetVersion', { version: state.targetVersion })}</p> : null}
    {state.releaseNotes ? <pre className="software-update-notes">{state.releaseNotes}</pre> : null}
    {state.phase === 'downloading' ? <div className="software-update-progress"><progress aria-label={t('update.progress')} value={state.percent || 0} max={100} /><span>{Math.floor(state.percent || 0)}%</span></div> : null}
    {state.errorCode || requestFailed ? <p className="inline-error" role="alert">{t(`update.error.${requestFailed ? 'request_failed' : state.errorCode}`)}</p> : null}
    <div className="software-update-actions">
      {state.phase === 'available' || state.errorCode === 'download_failed' ? <Button type="button" variant="primary" disabled={busy} onClick={() => void act('download')}>{t('update.download')}</Button> : null}
      {state.phase === 'downloaded' ? <Button type="button" variant="primary" onClick={() => void act('install')}>{t('update.install')}</Button> : null}
      <a href="https://transkgllm.com" target="_blank" rel="noopener noreferrer">{t('update.manualDownload')}</a>
    </div>
    <p className="settings-empty">{t('update.consent')}</p>
  </section>;
}

export function SoftwareUpdateNotice({ onOpen }: { onOpen(): void }) {
  const { t } = useTranslation();
  const state = useDesktopUpdate();
  const [dismissed, setDismissed] = useState('');
  if (!state?.targetVersion || !['available', 'downloaded'].includes(state.phase)) return null;
  const key = `${state.targetVersion}:${state.phase}`;
  if (dismissed === key) return null;
  return <div className="software-update-notice" role="status"><span>{t(state.phase === 'available' ? 'update.noticeAvailable' : 'update.noticeReady', { version: state.targetVersion })}</span><button type="button" onClick={onOpen}>{t('update.view')}</button><button type="button" aria-label={t('update.later')} onClick={() => setDismissed(key)}>×</button></div>;
}
