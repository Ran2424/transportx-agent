import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlatformOverview } from '../../../public/kernel/commands.js';
import { useAppServices } from '../../app/AppProviders';
import { Icon } from '../../components/icons';
import { Button } from '../../components/ui/button';
import { Dialog, DialogClose } from '../../components/ui/dialog';
import { CAPABILITY_CATEGORIES, projectCapabilities, type CapabilityCategory } from './capability-projection';

export function CapabilityPane({ collapsed, onToggleCollapsed }: {
  collapsed: boolean;
  onToggleCollapsed(): void;
}) {
  const { t } = useTranslation();
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
      .catch(() => { if (current) setError(t('capability.loadFailed')); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [kernel, reloadKey, t]);

  const categories = CAPABILITY_CATEGORIES.map((item) => ({ ...item, label: t(item.labelKey) }));
  const allItems = useMemo(() => overview ? projectCapabilities(overview, t) : [], [overview, t]);
  const items = useMemo(() => allItems.filter((item) => item.category === category), [allItems, category]);
  const selectedItem = useMemo(() => allItems.find((item) => item.id === selectedItemId) ?? null, [allItems, selectedItemId]);
  const selectedAsset = selectedItem?.assetId ? selectedItem.moduleAssets.find((asset) => asset.id === selectedItem.assetId) : null;
  const contributions = selectedItem ? [
    selectedItem.moduleSkills ? t('common.skillCount', { count: selectedItem.moduleSkills }) : '',
    selectedItem.moduleExtensions ? t('common.extensionCount', { count: selectedItem.moduleExtensions }) : '',
    ...selectedItem.moduleAssets.map((asset) => asset.kind === 'data' ? 'Data' : asset.kind === 'knowledge' ? 'Knowledge' : 'Template'),
  ].filter(Boolean) : [];

  async function setCapabilityEnabled(enabled: boolean) {
    if (!selectedItem || !selectedItem.moduleRemovable) return;
    setBusy(true);
    setActionError('');
    try {
      setOverview(await kernel.commands.platform.setModuleEnabled(selectedItem.moduleId, enabled));
    } catch (cause) {
      setActionError((cause as { message?: string })?.message || t('capability.updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    <section className={`capability-pane${collapsed ? ' is-collapsed' : ' is-open'}`} aria-label={t('capability.region')}>
      <header className="capability-header">
        <strong>{t('capability.title')}</strong>
        <button
          className="capability-toggle"
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('capability.expand') : t('capability.collapse')}
          onClick={onToggleCollapsed}
        >
          <Icon name="chevron" />
        </button>
      </header>
      {!collapsed ? (
        <>
          <div className="capability-tabs" role="tablist" aria-label={t('capability.categories')}>
            {categories.map((tab) => (
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
          <div className="capability-list" role="tabpanel" aria-label={categories.find((tab) => tab.id === category)?.label}>
            {loading ? <div className="capability-loading" aria-label={t('capability.loading')}><span /><span /><span /></div>
              : error ? <div className="capability-error" role="alert">{error}<button type="button" onClick={() => setReloadKey((value) => value + 1)}>{t('common.retry')}</button></div>
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
              : <div className="capability-empty">{t('capability.empty')}</div>}
          </div>
        </>
      ) : null}
    </section>
    <Dialog
      open={!!selectedItem}
      onOpenChange={(open) => { if (!open) { setSelectedItemId(null); setActionError(''); } }}
      title={selectedItem ? t('capability.namedDetail', { name: selectedItem.name }) : t('capability.detail')}
      className="capability-detail-dialog"
      footer={selectedItem ? <>
        {selectedItem.moduleRemovable ? <Button type="button" variant={selectedItem.status === 'disabled' ? 'primary' : 'outline'} disabled={busy} onClick={() => setCapabilityEnabled(selectedItem.status === 'disabled')}>
          {busy ? t('capability.updating') : selectedItem.status === 'disabled' ? t('capability.enable') : t('capability.disable')}
        </Button> : null}
        <DialogClose asChild><Button type="button" variant="quiet">{t('common.close')}</Button></DialogClose>
      </> : null}
    >
      {selectedItem ? <article className="capability-detail-card">
        <div className="capability-detail-heading">
          <span className="capability-kind">{categories.find((tab) => tab.id === selectedItem.category)?.label}</span>
          <span className="capability-status" data-state={selectedItem.status}><i className="status-dot" /><span>{selectedItem.statusLabel}</span></span>
        </div>
        <p className="capability-detail-summary">{t('capability.providedBy', { name: selectedItem.moduleName, version: selectedItem.moduleVersion })}</p>
        <dl className="capability-detail-meta">
          <div><dt>{t('capability.moduleId')}</dt><dd><code>{selectedItem.moduleId}</code></dd></div>
          <div><dt>{t('capability.moduleType')}</dt><dd>{selectedItem.moduleType === 'module' ? t('settings.module.package') : selectedItem.moduleType === 'capability' ? t('settings.module.plugin') : t('settings.module.domain')}</dd></div>
          <div><dt>{t('capability.origin')}</dt><dd>{selectedItem.moduleOrigin === 'installed' ? t('settings.module.origin.installed') : selectedItem.moduleOrigin === 'external' ? t('settings.module.origin.external') : t('settings.module.origin.builtin')}</dd></div>
          <div><dt>{t('capability.status')}</dt><dd>{selectedItem.statusLabel}</dd></div>
          {selectedAsset ? <div><dt>{t('capability.assetStatus')}</dt><dd>{selectedAsset.configured ? t('capability.configured') : t('capability.pendingConfig')}{selectedAsset.active ? ` · ${t('capability.active')}` : ''}</dd></div> : null}
        </dl>
        {contributions.length ? <section className="capability-detail-section"><h4>{t('capability.contributions')}</h4><div className="capability-detail-tags">{contributions.map((contribution, index) => <span key={`${contribution}:${index}`}>{contribution}</span>)}</div></section> : null}
        {selectedItem.category === 'skill' ? <section className="capability-detail-section"><h4>{t('capability.skillFiles')}</h4><div className="skill-document-list">{selectedItem.skillFiles.map((file, index) => <details className="skill-document" open={index === 0} key={file.entryPath}><summary><span>{file.name}</span><small>{file.entryPath}</small></summary>{file.error ? <p className="skill-document-error">{file.error}</p> : <><pre>{file.content || t('capability.emptyFile')}</pre>{file.truncated ? <p className="skill-document-note">{t('capability.previewLimit')}</p> : null}</>}</details>)}</div></section> : null}
        {selectedItem.moduleRemovable ? <p className="capability-detail-note">{t('capability.toggleNote')}</p> : <p className="capability-detail-note">{selectedItem.moduleOrigin === 'builtin' ? t('capability.builtinNote') : t('capability.externalNote')}</p>}
        {actionError ? <div className="inline-error" role="alert">{actionError}</div> : null}
      </article> : null}
    </Dialog>
    </>
  );
}
