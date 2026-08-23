import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../icons';

/**
 * Frameless chrome window controls. Mounts only on Win/Linux hosts because
 * macOS keeps its native traffic-lights via titleBarStyle=hiddenInset. The
 * header stays a single drag region elsewhere; this component opts back into
 * event consumption (`-webkit-app-region: no-drag` via CSS) so the buttons
 * click normally even though their parents are drag-only.
 *
 * The maximise glyph flips between expand and contract based on the cached
 * isMaximized() answer returned by the main process; the renderer also
 * listens for size changes on the host window so external resize (dragging
 * to a screen edge, Snap) keeps the icon aligned with reality.
 */
export function WindowControls() {
  const { t } = useTranslation();
  const platform = typeof document !== 'undefined' ? document.documentElement.dataset.desktopPlatform : undefined;
  const supported = platform === 'win32' || platform === 'linux';
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!supported) return;
    const api = (window as unknown as { transportxDesktop?: { window: { isMaximized(): Promise<boolean> } } }).transportxDesktop;
    if (!api) return;
    let cancelled = false;
    const refresh = () => { void api.window.isMaximized().then((value) => { if (!cancelled) setMaximized(value); }); };
    refresh();
    window.addEventListener('resize', refresh);
    return () => { cancelled = true; window.removeEventListener('resize', refresh); };
  }, [supported]);

  if (!supported) return null;
  const api = (window as unknown as {
    transportxDesktop?: { window: { minimize(): Promise<void>; toggleMaximize(): Promise<void>; close(): Promise<void> } };
  }).transportxDesktop;
  if (!api) return null;

  return (
    <div className="window-controls" role="group" aria-label={t('window.controls')}>
      <button className="window-control window-control-minimize" type="button" aria-label={t('window.minimize')} title={t('window.minimize')} onClick={() => void api.window.minimize()}>
        <Icon name="minimize" />
      </button>
      <button className={`window-control window-control-maximize${maximized ? ' is-maximized' : ''}`} type="button" aria-label={t('window.maximize')} title={maximized ? t('window.restore') : t('window.maximize')} onClick={() => void api.window.toggleMaximize()}>
        <Icon name={maximized ? 'restore' : 'maximize'} />
      </button>
      <button className="window-control window-control-close" type="button" aria-label={t('window.close')} title={t('window.close')} onClick={() => void api.window.close()}>
        <Icon name="close" />
      </button>
    </div>
  );
}
