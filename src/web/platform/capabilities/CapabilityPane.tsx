import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlatformOverview } from '../../../public/kernel/commands.js';
import { appKernel } from '../../app/composition-root';
import { projectUi } from '../../app/project-ui';
import { Icon, type IconName } from '../../components/icons';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { CAPABILITY_CATEGORIES, projectCapabilities, type CapabilityCategory, type CapabilityItem } from './capability-projection';

const categoryIcons: Record<CapabilityCategory, IconName> = { skill: 'task', data: 'table', knowledge: 'citation', tool: 'tool', template: 'report' };

export function CapabilityPane({ collapsed, onToggleCollapsed, onManageModules }: {
  collapsed: boolean;
  onToggleCollapsed(): void;
  onManageModules(): void;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;
  const kernel = appKernel;
  const [centerOpen, setCenterOpen] = useState(false);
  const [category, setCategory] = useState<CapabilityCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [openingDirectory, setOpeningDirectory] = useState(false);
  const inspectorRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    kernel.commands.platform.getOverview()
      .then((value) => { if (current) setOverview(value); })
      .catch(() => { if (current) setError(t('capability.loadFailed')); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [kernel, reloadKey, t]);

  const categories = CAPABILITY_CATEGORIES.map((item) => ({ ...item, label: t(item.labelKey), icon: categoryIcons[item.id] }));
  const allItems = useMemo(() => overview ? projectCapabilities(overview, t, language) : [], [overview, t, language]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const items = useMemo(() => allItems.filter((item) => (category === 'all' || item.category === category)
    && (!normalizedQuery || [item.name, item.description, item.searchText, item.moduleName, item.moduleId, item.assetId].join(' ').toLocaleLowerCase().includes(normalizedQuery))), [allItems, category, normalizedQuery]);
  const selectedItem = items.find((item) => item.id === selectedItemId) ?? items[0] ?? null;
  const selectedAsset = selectedItem?.moduleAssets.find((asset) => asset.id === selectedItem.assetId);
  const attentionCount = allItems.filter((item) => item.status === 'attention').length;

  function openCenter(nextCategory: CapabilityCategory | 'all' = 'all') {
    setCategory(nextCategory);
    setQuery('');
    setSelectedItemId(null);
    setActionError('');
    setReloadKey((value) => value + 1);
    setCenterOpen(true);
  }

  function leaveCenter(action: () => void) {
    setCenterOpen(false);
    action();
  }

  async function setCapabilityEnabled(item: CapabilityItem, enabled: boolean) {
    setBusy(true);
    setActionError('');
    try {
      setOverview(await kernel.commands.platform.setModuleEnabled(item.moduleId, enabled));
    } catch (cause) {
      setActionError((cause as { message?: string })?.message || t('capability.updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function openModuleDirectory(item: CapabilityItem) {
    setOpeningDirectory(true); setActionError('');
    try { await kernel.commands.platform.openModuleDirectory(item.moduleId); }
    catch (cause) { setActionError((cause as Error).message || t('capability.openDirectoryFailed')); }
    finally { setOpeningDirectory(false); }
  }

  const status = (item: CapabilityItem) => <span className="capability-status" data-state={item.status}>{item.statusLabel}</span>;
  const loadState = loading ? <div className="capability-loading" role="status" aria-label={t('capability.loading')}><span /><span /><span /></div>
    : error ? <div className="capability-error" role="alert">{error}<button type="button" onClick={() => setReloadKey((value) => value + 1)}>{t('common.retry')}</button></div> : null;

  return <>
    <section className={`capability-pane${collapsed ? ' is-collapsed' : ' is-open'}`} aria-label={t('capability.region')}>
      <header className="capability-header">
        <button type="button" className="capability-center-link" onClick={() => openCenter()}><Icon name="panel" />{t('capability.center')}</button>
        <button className="capability-toggle" type="button" aria-expanded={!collapsed} aria-label={collapsed ? t('capability.expand') : t('capability.collapse')} onClick={onToggleCollapsed}><Icon name="chevron" /></button>
      </header>
      {!collapsed ? <div className="capability-overview">
        {loadState || <>
          <p>{t('capability.sidebarHint')}</p>
          <div className="capability-shortcuts">{categories.map((tab) => {
            const count = allItems.filter((item) => item.category === tab.id).length;
            return count ? <button type="button" key={tab.id} onClick={() => openCenter(tab.id)}><Icon name={tab.icon} /><span>{tab.label}</span><small>{count}</small></button> : null;
          })}</div>
          <button type="button" className="capability-browse" onClick={() => openCenter()}>{attentionCount ? t('capability.needsAttention', { count: attentionCount }) : t('capability.browse')}<Icon name="open" /></button>
        </>}
      </div> : null}
    </section>
    <Dialog open={centerOpen} onOpenChange={setCenterOpen} title={t('capability.center')} className="capability-center-dialog">
      <div className="capability-center-intro"><p>{t('capability.centerHint')}</p><Button type="button" variant="outline" onClick={() => leaveCenter(onManageModules)}><Icon name="settings" />{t('capability.manage')}</Button></div>
      <div className="capability-center-toolbar">
        <label className="capability-search"><Icon name="search" /><input aria-label={t('capability.search')} placeholder={t('capability.searchPlaceholder')} value={query} onChange={(event) => setQuery(event.target.value)} />{query ? <button type="button" aria-label={t('capability.clearSearch')} onClick={() => setQuery('')}><Icon name="close" /></button> : null}</label>
        <button type="button" className="icon-button" aria-label={t('capability.refresh')} disabled={loading || busy} onClick={() => setReloadKey((value) => value + 1)}><Icon name="refresh" /></button>
      </div>
      <div className="capability-filters" role="group" aria-label={t('capability.categories')}>
        {[{ id: 'all' as const, label: t('capability.all') }, ...categories].map((tab) => <button type="button" key={tab.id} aria-pressed={category === tab.id} onClick={() => { setCategory(tab.id); setActionError(''); }}>{tab.label}<small>{tab.id === 'all' ? allItems.length : allItems.filter((item) => item.category === tab.id).length}</small></button>)}
      </div>
      {loadState || <div className="capability-center-layout">
        <section className="capability-catalog" aria-label={t('capability.catalog')}>
          <p className="capability-result-count" role="status">{t('capability.resultCount', { count: items.length })}</p>
          <div className="capability-grid">{items.map((item) => <button className={`capability-card${selectedItem?.id === item.id ? ' is-selected' : ''}`} type="button" key={item.id} aria-pressed={selectedItem?.id === item.id} onClick={() => {
            setSelectedItemId(item.id); setActionError('');
            if (window.matchMedia('(max-width: 700px)').matches) window.requestAnimationFrame(() => inspectorRef.current?.scrollIntoView({ block: 'start' }));
          }}>
            <span className="capability-card-top"><Icon name={categoryIcons[item.category]} />{status(item)}</span>
            <strong>{item.name}</strong><span className="capability-card-description">{item.description}</span>
            <small>{t(`capability.category.${item.category}`)} · {item.moduleName}</small>
          </button>)}</div>
          {!items.length ? <div className="capability-catalog-empty"><Icon name="search" /><strong>{t('capability.noResults')}</strong><p>{t('capability.noResultsHint')}</p><Button type="button" variant="quiet" onClick={() => { setQuery(''); setCategory('all'); }}>{t('capability.resetFilters')}</Button></div> : null}
        </section>
        {selectedItem ? <article ref={inspectorRef} className="capability-inspector" aria-label={t('capability.detail')} key={selectedItem.id}>
          <div className="capability-detail-heading"><span className="capability-kind">{t(`capability.category.${selectedItem.category}`)}</span>{status(selectedItem)}</div>
          <h2>{selectedItem.name}</h2>
          <section className="capability-detail-section"><h3>{t('capability.functionOverview')}</h3><p className="capability-description">{selectedItem.description}</p>{selectedItem.features.length ? <ul className="capability-feature-list">{selectedItem.features.map((feature) => <li key={feature}>{feature}</li>)}</ul> : null}</section>
          {projectUi.nativeActions ? <button type="button" className="capability-files-link" disabled={openingDirectory} onClick={() => void openModuleDirectory(selectedItem)}><Icon name="workspace" />{t('capability.openDirectory')}<Icon name="open" /></button> : null}
          {selectedItem.moduleAssets.length ? <section className="capability-detail-section"><h3>{t('capability.resources')}</h3><ul className="capability-resource-list">{selectedItem.moduleAssets.map((asset) => <li key={asset.id}><strong title={asset.id}>{asset.name}</strong><span data-state={!asset.configured || asset.error ? 'attention' : 'ready'}>{asset.error ? t('capability.resourceError') : asset.configured ? t('capability.configured') : t('capability.pendingConfig')}</span>{asset.error ? <p>{asset.error}</p> : null}</li>)}</ul></section> : null}
          {overview?.errors.filter((item) => item.moduleId === selectedItem.moduleId).map((item, index) => <p className="inline-error" role="alert" key={index}>{item.message}</p>)}
          <details className="capability-technical"><summary>{t('capability.technical')}</summary><div className="capability-technical-body">
            <p>{t('capability.providedBy', { name: selectedItem.moduleName, version: selectedItem.moduleVersion })}</p>
            <dl className="capability-detail-meta">
              <div><dt>{t('capability.moduleId')}</dt><dd><code>{selectedItem.moduleId}</code></dd></div>
              <div><dt>{t('capability.moduleType')}</dt><dd>{selectedItem.moduleType === 'module' ? t('settings.module.package') : selectedItem.moduleType === 'capability' ? t('settings.module.plugin') : t('settings.module.domain')}</dd></div>
              <div><dt>{t('capability.origin')}</dt><dd>{selectedItem.moduleOrigin === 'installed' ? t('settings.module.origin.installed') : selectedItem.moduleOrigin === 'external' ? t('settings.module.origin.external') : t('settings.module.origin.builtin')}</dd></div>
              {selectedAsset ? <div><dt>{t('capability.assetStatus')}</dt><dd>{selectedAsset.configured ? t('capability.configured') : t('capability.pendingConfig')}</dd></div> : null}
            </dl>
            {selectedItem.skillFiles.length ? <section className="capability-detail-section"><h3>{t('capability.skillFiles')}</h3><div className="skill-document-list">{selectedItem.skillFiles.map((file) => <details className="skill-document" key={file.entryPath}><summary><span>{file.name}</span><small>{file.entryPath}</small></summary>{file.error ? <p className="skill-document-error">{file.error}</p> : <><pre>{file.content || t('capability.emptyFile')}</pre>{file.truncated ? <p className="skill-document-note">{t('capability.previewLimit')}</p> : null}</>}</details>)}</div></section> : null}
          </div></details>
          <div className="capability-module-controls"><p>{selectedItem.moduleRemovable ? t('capability.toggleNote') : selectedItem.moduleOrigin === 'builtin' ? t('capability.builtinNote') : t('capability.externalNote')}</p>{selectedItem.moduleRemovable ? <Button type="button" variant="outline" disabled={busy} onClick={() => void setCapabilityEnabled(selectedItem, selectedItem.status === 'disabled')}>{busy ? t('capability.updating') : selectedItem.status === 'disabled' ? t('capability.enable') : t('capability.disable')}</Button> : null}</div>
          {actionError ? <div className="inline-error" role="alert">{actionError}</div> : null}
        </article> : null}
      </div>}
      {overview?.errors.filter((item) => !item.moduleId || !overview.modules.some((module) => module.id === item.moduleId)).map((item, index) => <p className="inline-error" role="alert" key={index}>{item.message}</p>)}
    </Dialog>
  </>;
}
