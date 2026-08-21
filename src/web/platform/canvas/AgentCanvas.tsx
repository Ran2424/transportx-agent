import { useTranslation } from 'react-i18next';
import type { LiveSession } from '../../../public/app-types.js';
import { Icon } from '../../components/icons';
import { canvasRenderers } from './canvas-registry';
import type { CanvasItem } from './canvas-state';

export function AgentCanvas({ session, items, activeItemId, open, onActivate, onClose }: {
  session: LiveSession | null;
  items: CanvasItem[];
  activeItemId: string | null;
  open: boolean;
  onActivate(itemId: string): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const activeItem = items.find((item) => item.id === activeItemId) ?? items[0] ?? null;
  const Renderer = activeItem ? canvasRenderers[activeItem.kind] : null;
  const label = t(activeItem?.kind === 'video' ? 'workspace.videoView' : 'workspace.mapView');
  const closeLabel = t(activeItem?.kind === 'video' ? 'workspace.closeVideo' : 'workspace.closeMap');
  return <aside className={`workspace-float workspace-float--canvas${open ? ' is-open' : ''}`} aria-label={label} data-testid="agent-canvas">
    <header className="workspace-float-header">
      <div className="agent-canvas-tabs" role="tablist" aria-label={label}>
        {items.map((item) => <button key={item.id} type="button" role="tab" aria-selected={item.id === activeItem?.id} className={item.id === activeItem?.id ? 'is-active' : ''} onClick={() => onActivate(item.id)} title={item.title}>
          <Icon name={item.kind === 'geo' ? 'map' : 'video'} />
          <span>{item.title || item.resourceId}</span>
        </button>)}
      </div>
      <button className="icon-button" type="button" aria-label={closeLabel} onClick={onClose}><Icon name="close" /></button>
    </header>
    <div className="workspace-float-body">{Renderer ? <Renderer session={session} active={open} /> : null}</div>
  </aside>;
}
