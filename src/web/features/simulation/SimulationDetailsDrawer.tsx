import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '../../components/icons';

type DrawerSize = 'collapsed' | 'default' | 'expanded' | number;

export function SimulationDetailsDrawer({ summary, children }: { summary: string; children: ReactNode }) {
  const [size, setSize] = useState<DrawerSize>('default');
  const [height, setHeight] = useState(40);
  const [limit, setLimit] = useState(40);
  const drawer = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const contentId = useId();
  const collapsed = size === 'collapsed';
  const resize = (height: number) => setSize(height <= 44 ? 'collapsed' : height);
  useEffect(() => {
    const element = drawer.current;
    if (!element) return;
    const workspace = element.parentElement;
    const observer = new ResizeObserver(() => {
      if (!element.offsetHeight) return;
      setHeight(element.offsetHeight);
      setLimit(Math.max(element.offsetHeight, Math.round((workspace?.clientHeight ?? 0) * 0.4)));
    });
    observer.observe(element);
    if (workspace) observer.observe(workspace);
    return () => observer.disconnect();
  }, []);
  return <div ref={drawer} className="simulation-drawer" data-size={typeof size === 'number' ? 'custom' : size}
    style={typeof size === 'number' ? { '--simulation-drawer-height': `${size}px` } as CSSProperties : undefined}>
    <div className="simulation-drawer-grip" role="separator" aria-orientation="horizontal" aria-label="调整详情高度" aria-controls={contentId}
      aria-valuemin={40} aria-valuemax={limit}
      aria-valuenow={height} aria-valuetext={`${height} 像素`} tabIndex={0}
      onPointerDown={event => {
        if (event.button !== 0 || !drawer.current) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { y: event.clientY, height: drawer.current.offsetHeight };
      }}
      onPointerMove={event => {
        if (drag.current && event.currentTarget.hasPointerCapture(event.pointerId)) resize(drag.current.height + drag.current.y - event.clientY);
      }}
      onLostPointerCapture={() => { drag.current = null; }}
      onDoubleClick={() => setSize('default')}
      onKeyDown={event => {
        if (!drawer.current || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'Home') setSize('default');
        else if (event.key === 'End') setSize('expanded');
        else resize(drawer.current.offsetHeight + (event.key === 'ArrowUp' ? 24 : -24));
      }}
    />
    <div className="simulation-drawer-header">
      <strong>对象与事件</strong>
      <span title={summary}>{summary}</span>
      {!collapsed ? <button type="button" onClick={() => setSize(size === 'expanded' ? 'default' : 'expanded')}>{size === 'expanded' ? '默认高度' : '展开详情'}</button> : null}
      <button type="button" aria-label={collapsed ? '恢复详情' : '收起详情'} aria-expanded={!collapsed} aria-controls={contentId}
        onClick={() => setSize(collapsed ? 'default' : 'collapsed')}>
        <Icon name="chevron" />
      </button>
    </div>
    <div id={contentId} className="simulation-details" hidden={collapsed}>{children}</div>
  </div>;
}
