import { useEffect, useMemo, useState } from 'react';
import type { PlatformOverview } from '../../../public/kernel/commands.js';
import { useAppServices } from '../../app/AppProviders';
import { Icon } from '../../components/icons';
import { CAPABILITY_CATEGORIES, projectCapabilities, type CapabilityCategory } from './capability-projection';

export function CapabilityPane({ collapsed, onToggleCollapsed, onOpenSettings }: {
  collapsed: boolean;
  onToggleCollapsed(): void;
  onOpenSettings(): void;
}) {
  const { kernel } = useAppServices();
  const [category, setCategory] = useState<CapabilityCategory>('module');
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    kernel.commands.platform.getOverview()
      .then((value) => { if (current) setOverview(value); })
      .catch(() => { if (current) setError('能力信息读取失败'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [kernel, reloadKey]);

  const items = useMemo(
    () => overview ? projectCapabilities(overview).filter((item) => item.category === category) : [],
    [overview, category],
  );

  return (
    <section className={`capability-pane${collapsed ? ' is-collapsed' : ' is-open'}`} aria-label="能力扩展区">
      <header className="capability-header">
        <strong>能力</strong>
        <button
          className="capability-toggle"
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展开能力扩展区' : '收起能力扩展区'}
          onClick={onToggleCollapsed}
        >
          <Icon name="chevron" />
        </button>
      </header>
      {!collapsed ? (
        <>
          <div className="capability-tabs" role="tablist" aria-label="能力分类">
            {CAPABILITY_CATEGORIES.map((tab) => (
              <button
                className={`capability-tab${category === tab.id ? ' is-active' : ''}`}
                type="button"
                role="tab"
                aria-selected={category === tab.id}
                key={tab.id}
                onClick={() => setCategory(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="capability-list" role="tabpanel" aria-label={CAPABILITY_CATEGORIES.find((tab) => tab.id === category)?.label}>
            {loading ? <div className="capability-loading" aria-label="正在读取能力"><span /><span /><span /></div>
              : error ? <div className="capability-error" role="alert">{error}<button type="button" onClick={() => setReloadKey((value) => value + 1)}>重试</button></div>
              : items.length ? items.map((item) => (
                <button
                  className="capability-row"
                  type="button"
                  key={item.id}
                  title={`${item.name} · ${item.statusLabel}`}
                  onClick={onOpenSettings}
                >
                  <span className="capability-row-main"><strong>{item.name}</strong><small>{item.source}</small></span>
                  <span className="capability-status" data-state={item.status}><i className="status-dot" /><span>{item.statusLabel}</span></span>
                </button>
              ))
              : <div className="capability-empty">当前分类暂无内容。<button type="button" className="capability-empty-action" onClick={onOpenSettings}>进入设置</button></div>}
          </div>
        </>
      ) : null}
    </section>
  );
}
