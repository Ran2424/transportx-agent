import type { LiveSession } from '../../../public/app-types.js';
import { useTranslation } from 'react-i18next';
import type { ConnectionState } from '../../../public/kernel/stores/runtime-store.js';
import { BrandMark } from '../BrandMark';
import { Icon } from '../icons';
import { modelReference, sessionTitle } from '../../lib/formatting';
import { WindowControls } from './WindowControls';

type HeaderProps = {
  connection: ConnectionState;
  activeSession: LiveSession | null;
  streaming: boolean;
  sidebarOpen: boolean;
  fileOpen: boolean;
  taskOpen: boolean;
  mapOpen: boolean;
  videoOpen: boolean;
  taskAvailable: boolean;
  mapAvailable: boolean;
  videoAvailable: boolean;
  onToggleSidebar(): void;
  onToggleFiles(): void;
  onToggleTasks(): void;
  onToggleMap(): void;
  onToggleVideo(): void;
  onGoHome(): void;
  onOpenModel(): void;
  onOpenCommands(): void;
  onOpenSettings(): void;
};

export function Header({
  connection,
  activeSession,
  streaming,
  sidebarOpen,
  fileOpen,
  taskOpen,
  mapOpen,
  videoOpen,
  taskAvailable,
  mapAvailable,
  videoAvailable,
  onToggleSidebar,
  onToggleFiles,
  onToggleTasks,
  onToggleMap,
  onToggleVideo,
  onGoHome,
  onOpenModel,
  onOpenCommands,
  onOpenSettings,
}: HeaderProps) {
  const { t } = useTranslation();
  const status = connection === 'connected' && streaming ? 'streaming' : connection;
  const statusLabel = status === 'streaming' ? t('header.status.streaming') : status === 'connected' ? t('header.status.connected') : status === 'connecting' ? t('header.status.connecting') : t('header.status.disconnected');
  const model = modelReference(activeSession?.model) || activeSession?.modelSpec || t('header.selectModel');
  const thinking = activeSession?.thinkingLevel || 'off';

  return (
    <header className={`workspace-header${activeSession ? ' has-task' : ''}`}>
      <div className="workspace-header-left">
        <button className="icon-button" type="button" aria-label={t('header.toggleSidebar')} aria-pressed={sidebarOpen} onClick={onToggleSidebar}>
          <Icon name="menu" />
        </button>
        <button
          className="model-trigger"
          type="button"
          disabled={!activeSession}
          onClick={onOpenModel}
          aria-label={t('header.modelAndThinking')}
        >
          <span>{model}</span>
          {activeSession ? <small>{thinking}</small> : null}
          <Icon name="chevron" />
        </button>
      </div>

      <div className="workspace-header-center">
        {activeSession ? (
          <button className="workspace-task" type="button" aria-label={t('header.goHome')} title={sessionTitle(activeSession)} onClick={onGoHome}>
            <span className="workspace-task-name">{sessionTitle(activeSession)}</span>
            <span className={`workspace-task-status${streaming ? ' is-streaming' : ''}`}>{streaming ? t('header.status.streaming') : t('header.status.ready')}</span>
          </button>
        ) : (
          <button className="workspace-brand" type="button" aria-label={t('header.goHome')} onClick={onGoHome}>
            <BrandMark className="workspace-brand-mark" />
            <span><strong>TransportX</strong><small>TRAFFIC AGENT</small></span>
          </button>
        )}
      </div>

      <div className="workspace-header-right">
        <div className="agent-status" data-testid="agent-status" data-state={status} title={`Agent ${statusLabel}`}>
          <span className="agent-status-dot" />
          <span>{statusLabel}</span>
        </div>
        <button className="icon-button header-command" type="button" aria-label={t('header.openCommands')} onClick={onOpenCommands}>
          <Icon name="command" /><kbd>⌘K</kbd>
        </button>
        <button className="icon-button" type="button" aria-label={t('header.toggleFiles')} aria-pressed={fileOpen} onClick={onToggleFiles}>
          <Icon name="workspace" />
        </button>
        <button className="icon-button" type="button" aria-label={t('header.toggleTasks')} aria-pressed={taskOpen} disabled={!taskAvailable} title={taskAvailable ? t('app.command.tasks.open') : t('app.command.tasks.unavailable')} onClick={onToggleTasks}>
          <Icon name="task" />
        </button>
        <button className="icon-button" type="button" aria-label={t('header.toggleMap')} aria-pressed={mapOpen} disabled={!mapAvailable} title={mapAvailable ? t('app.command.map.open') : t('app.command.map.unavailable')} onClick={onToggleMap}>
          <Icon name="map" />
        </button>
        <button className="icon-button" type="button" aria-label={t('header.toggleVideo')} aria-pressed={videoOpen} disabled={!videoAvailable} title={videoAvailable ? t('app.command.video.open') : t('app.command.video.unavailable')} onClick={onToggleVideo}>
          <Icon name="video" />
        </button>
        <button className="icon-button" type="button" aria-label={t('header.openSettings')} onClick={onOpenSettings}>
          <Icon name="settings" />
        </button>
        <WindowControls />
      </div>
    </header>
  );
}
