import type { LiveSession } from '../../../public/app-types.js';
import type { ConnectionState } from '../../../public/kernel/stores/runtime-store.js';
import { BrandMark } from '../BrandMark';
import { Icon } from '../icons';
import { modelReference, sessionTitle } from '../../lib/formatting';

type HeaderProps = {
  connection: ConnectionState;
  activeSession: LiveSession | null;
  streaming: boolean;
  sidebarOpen: boolean;
  fileOpen: boolean;
  taskOpen: boolean;
  mapOpen: boolean;
  taskAvailable: boolean;
  mapAvailable: boolean;
  onToggleSidebar(): void;
  onToggleFiles(): void;
  onToggleTasks(): void;
  onToggleMap(): void;
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
  taskAvailable,
  mapAvailable,
  onToggleSidebar,
  onToggleFiles,
  onToggleTasks,
  onToggleMap,
  onGoHome,
  onOpenModel,
  onOpenCommands,
  onOpenSettings,
}: HeaderProps) {
  const status = connection === 'connected' && streaming ? 'streaming' : connection;
  const statusLabel = status === 'streaming' ? '处理中' : status === 'connected' ? '已连接' : status === 'connecting' ? '连接中' : '已断开';
  const model = modelReference(activeSession?.model) || activeSession?.modelSpec || '选择模型';
  const thinking = activeSession?.thinkingLevel || 'off';

  return (
    <header className={`workspace-header${activeSession ? ' has-task' : ''}`}>
      <div className="workspace-header-left">
        <button className="icon-button" type="button" aria-label="展开或收起会话侧栏" aria-pressed={sidebarOpen} onClick={onToggleSidebar}>
          <Icon name="menu" />
        </button>
        <button
          className="model-trigger"
          type="button"
          disabled={!activeSession}
          onClick={onOpenModel}
          aria-label="选择模型与思考级别"
        >
          <span>{model}</span>
          {activeSession ? <small>{thinking}</small> : null}
          <Icon name="chevron" />
        </button>
      </div>

      <div className="workspace-header-center">
        {activeSession ? (
          <button className="workspace-task" type="button" aria-label="返回 TransportX 主界面" title={sessionTitle(activeSession)} onClick={onGoHome}>
            <span className="workspace-task-name">{sessionTitle(activeSession)}</span>
            <span className={`workspace-task-status${streaming ? ' is-streaming' : ''}`}>{streaming ? '处理中' : '已就绪'}</span>
          </button>
        ) : (
          <button className="workspace-brand" type="button" aria-label="返回 TransportX 主界面" onClick={onGoHome}>
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
        <button className="icon-button header-command" type="button" aria-label="打开命令面板" onClick={onOpenCommands}>
          <Icon name="command" /><kbd>⌘K</kbd>
        </button>
        <button className="icon-button" type="button" aria-label="打开或关闭文件栏" aria-pressed={fileOpen} onClick={onToggleFiles}>
          <Icon name="workspace" />
        </button>
        <button className="icon-button" type="button" aria-label="打开或关闭任务面板" aria-pressed={taskOpen} disabled={!taskAvailable} title={taskAvailable ? '打开任务面板' : '当前任务未开启任务模式'} onClick={onToggleTasks}>
          <Icon name="task" />
        </button>
        <button className="icon-button" type="button" aria-label="打开或关闭地图视图" aria-pressed={mapOpen} disabled={!mapAvailable} title={mapAvailable ? '打开地图视图' : '当前任务暂无地图结果'} onClick={onToggleMap}>
          <Icon name="map" />
        </button>
        <button className="icon-button" type="button" aria-label="打开设置" onClick={onOpenSettings}>
          <Icon name="settings" />
        </button>
      </div>
    </header>
  );
}
