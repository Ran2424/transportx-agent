import { useEffect, useMemo, useState } from 'react';
import type { PlatformOverview } from '../../../public/kernel/commands.js';
import { useAppServices } from '../../app/AppProviders';
import { Icon } from '../../components/icons';
import { Button } from '../../components/ui/button';
import { Dialog, DialogClose } from '../../components/ui/dialog';
import { CAPABILITY_CATEGORIES, projectCapabilities, type CapabilityCategory } from './capability-projection';

const moduleTypeLabels = { module: '模块包', capability: '平台能力', domain: '领域模块' } as const;
const originLabels = { builtin: '内置', installed: '用户安装', external: '外部加载' } as const;

export function CapabilityPane({ collapsed, onToggleCollapsed }: {
  collapsed: boolean;
  onToggleCollapsed(): void;
}) {
  const { kernel } = useAppServices();
  const [category, setCategory] = useState<CapabilityCategory>('skill');
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

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

  const allItems = useMemo(() => overview ? projectCapabilities(overview) : [], [overview]);
  const items = useMemo(() => allItems.filter((item) => item.category === category), [allItems, category]);
  const selectedItem = useMemo(() => allItems.find((item) => item.id === selectedItemId) ?? null, [allItems, selectedItemId]);
  const selectedAsset = selectedItem?.assetId ? selectedItem.moduleAssets.find((asset) => asset.id === selectedItem.assetId) : null;
  const contributions = selectedItem ? [
    selectedItem.moduleSkills ? `${selectedItem.moduleSkills} 个 Skill` : '',
    selectedItem.moduleExtensions ? `${selectedItem.moduleExtensions} 个 Extension` : '',
    ...selectedItem.moduleAssets.map((asset) => asset.kind === 'data' ? 'Data' : asset.kind === 'knowledge' ? 'Knowledge' : 'Template'),
  ].filter(Boolean) : [];

  async function setCapabilityEnabled(enabled: boolean) {
    if (!selectedItem || !selectedItem.moduleRemovable) return;
    setBusy(true);
    setActionError('');
    try {
      setOverview(await kernel.commands.platform.setModuleEnabled(selectedItem.moduleId, enabled));
    } catch (cause) {
      setActionError((cause as { message?: string })?.message || '更新能力状态失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
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
                onClick={() => { setCategory(tab.id); setSelectedItemId(null); setActionError(''); }}
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
                  onClick={() => { setSelectedItemId(item.id); setActionError(''); }}
                >
                  <span className="capability-row-main"><strong>{item.name}</strong><small>{item.source}</small></span>
                  <span className="capability-status" data-state={item.status}><i className="status-dot" /><span>{item.statusLabel}</span></span>
                </button>
              ))
              : <div className="capability-empty">当前分类暂无内容。</div>}
          </div>
        </>
      ) : null}
    </section>
    <Dialog
      open={!!selectedItem}
      onOpenChange={(open) => { if (!open) { setSelectedItemId(null); setActionError(''); } }}
      title={selectedItem ? `${selectedItem.name} · 详情` : '能力详情'}
      className="capability-detail-dialog"
      footer={selectedItem ? <>
        {selectedItem.moduleRemovable ? <Button type="button" variant={selectedItem.status === 'disabled' ? 'primary' : 'outline'} disabled={busy} onClick={() => setCapabilityEnabled(selectedItem.status === 'disabled')}>
          {busy ? '更新中…' : selectedItem.status === 'disabled' ? '开启功能' : '关闭功能'}
        </Button> : null}
        <DialogClose asChild><Button type="button" variant="quiet">关闭</Button></DialogClose>
      </> : null}
    >
      {selectedItem ? <article className="capability-detail-card">
        <div className="capability-detail-heading">
          <span className="capability-kind">{CAPABILITY_CATEGORIES.find((tab) => tab.id === selectedItem.category)?.label}</span>
          <span className="capability-status" data-state={selectedItem.status}><i className="status-dot" /><span>{selectedItem.statusLabel}</span></span>
        </div>
        <p className="capability-detail-summary">由“{selectedItem.moduleName}”提供，版本 {selectedItem.moduleVersion}。</p>
        <dl className="capability-detail-meta">
          <div><dt>模块 ID</dt><dd><code>{selectedItem.moduleId}</code></dd></div>
          <div><dt>模块类型</dt><dd>{moduleTypeLabels[selectedItem.moduleType]}</dd></div>
          <div><dt>来源</dt><dd>{originLabels[selectedItem.moduleOrigin]}</dd></div>
          <div><dt>状态</dt><dd>{selectedItem.statusLabel}</dd></div>
          {selectedAsset ? <div><dt>资产状态</dt><dd>{selectedAsset.configured ? '已配置' : '待配置'}{selectedAsset.active ? ' · 当前生效' : ''}</dd></div> : null}
        </dl>
        {contributions.length ? <section className="capability-detail-section"><h4>模块贡献</h4><div className="capability-detail-tags">{contributions.map((contribution, index) => <span key={`${contribution}:${index}`}>{contribution}</span>)}</div></section> : null}
        {selectedItem.category === 'skill' ? <section className="capability-detail-section"><h4>技能文件</h4><div className="skill-document-list">{selectedItem.skillFiles.map((file, index) => <details className="skill-document" open={index === 0} key={file.entryPath}><summary><span>{file.name}</span><small>{file.entryPath}</small></summary>{file.error ? <p className="skill-document-error">{file.error}</p> : <><pre>{file.content || '（文件为空）'}</pre>{file.truncated ? <p className="skill-document-note">仅预览前 48 KB。</p> : null}</>}</details>)}</div></section> : null}
        {selectedItem.moduleRemovable ? <p className="capability-detail-note">开关会同步启用或停用该模块提供的能力。</p> : <p className="capability-detail-note">{selectedItem.moduleOrigin === 'builtin' ? '这是内置能力，始终随工作台提供。' : '此能力由外部加载模块提供，当前无法在工作台中启停。'}</p>}
        {actionError ? <div className="inline-error" role="alert">{actionError}</div> : null}
      </article> : null}
    </Dialog>
    </>
  );
}
