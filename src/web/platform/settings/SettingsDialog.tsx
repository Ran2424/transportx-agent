import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LiveSession, ModelRecord } from '../../../public/app-types.js';
import type { ModelProviderAccess, PlatformModule, PlatformOverview } from '../../../public/kernel/commands.js';
import { appKernel } from '../../app/composition-root';
import { Icon, type IconName } from '../../components/icons';
import { Button } from '../../components/ui/button';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog';
import { Dialog, DialogClose } from '../../components/ui/dialog';
import { useLocale } from '../../i18n/LocaleProvider';
import type { LocalePreference } from '../../i18n';
import i18n from '../../i18n';
import { formatContextWindow } from '../../lib/formatting';
import type { ModuleArchiveInspection } from '../../../contracts/module';
import { ModelEditDialog } from '../model/ModelEditDialog';

export const themes = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'sand', label: 'Sand' },
] as const;

export type ThemeId = (typeof themes)[number]['id'];

export const settingsSections = [
  { id: 'general', labelKey: 'settings.section.general', icon: 'settings' },
  { id: 'agent', labelKey: 'settings.section.agent', icon: 'tool' },
  { id: 'modules', labelKey: 'settings.section.modules', icon: 'panel' },
] as const;

export type SettingsSectionId = (typeof settingsSections)[number]['id'];

/**
 * 主题预览色直接读取 semantic token（styles/styles/tokens.css），
 * 不维护第二份手写色值，保证预览与真实主题一致。
 */
function readThemeSwatches(): Record<ThemeId, string[]> {
  const root = document.documentElement;
  const previous = root.dataset.theme;
  const result = {} as Record<ThemeId, string[]>;
  for (const id of themes.map((item) => item.id)) {
    root.dataset.theme = id;
    const style = getComputedStyle(root);
    result[id] = [
      style.getPropertyValue('--surface-canvas').trim() || '#FFFFFF',
      style.getPropertyValue('--surface-sidebar').trim() || '#F1F1F0',
      style.getPropertyValue('--interactive-primary-bg').trim() || '#888888',
    ];
  }
  root.dataset.theme = previous;
  return result;
}

type SettingsPageProps = {
  theme: ThemeId;
  onThemeChange(theme: ThemeId): void;
  showThinking: boolean;
  onShowThinkingChange(value: boolean): void;
  expandThinking: boolean;
  onExpandThinkingChange(value: boolean): void;
  session: LiveSession | null;
  onAddModel(): void;
  section: SettingsSectionId;
  onSectionChange(section: SettingsSectionId): void;
  onBack(): void;
};

function modelDetails(model: ModelRecord | string) {
  if (typeof model === 'string') {
    const slash = model.indexOf('/');
    return { raw: null, modelId: slash > 0 ? model.slice(slash + 1) : model, provider: slash > 0 ? model.slice(0, slash) : i18n.t('settings.model.unknownProvider'), name: slash > 0 ? model.slice(slash + 1) : model, context: '', reasoning: false, images: false };
  }
  const modelId = model.id || model.model || model.name || '';
  const name = model.name || model.label || model.id || model.model || i18n.t('settings.model.unnamed');
  const contextValue = model.contextWindow || model.context || model.context_window;
  const context = formatContextWindow(contextValue);
  return { raw: model, modelId, provider: model.provider || i18n.t('settings.model.unknownProvider'), name, context, reasoning: model.thinking === true || model.thinking === 'true', images: model.images === true || model.images === 'true' };
}

export function SettingsPage({ theme, onThemeChange, showThinking, onShowThinkingChange, expandThinking, onExpandThinkingChange, session, onAddModel, section, onSectionChange, onBack }: SettingsPageProps) {
  const { t } = useTranslation();
  const { preference, setPreference } = useLocale();
  const kernel = appKernel;
  const [autoCompact, setAutoCompact] = useState(true);
  const [auth, setAuth] = useState({ configured: false, enabled: false });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [models, setModels] = useState<Array<ModelRecord | string>>([]);
  const [modelProviders, setModelProviders] = useState<ModelProviderAccess[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [moduleSource, setModuleSource] = useState('');
  const [archiveInspection, setArchiveInspection] = useState<ModuleArchiveInspection | null>(null);
  const [selectedArchiveModules, setSelectedArchiveModules] = useState<string[]>([]);
  const archiveInput = useRef<HTMLInputElement>(null);
  const [swatches, setSwatches] = useState<Record<ThemeId, string[]> | null>(null);
  const [modelQuery, setModelQuery] = useState('');
  const [modelCapability, setModelCapability] = useState<'all' | 'reasoning' | 'images'>('all');
  const [providerMenu, setProviderMenu] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteProviderTarget, setDeleteProviderTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteModelTarget, setDeleteModelTarget] = useState<{ provider: string; modelId: string; name: string } | null>(null);
  const [editModelTarget, setEditModelTarget] = useState<{ provider: string; model: ModelRecord } | null>(null);

  useEffect(() => {
    setSwatches(readThemeSwatches());
    let current = true;
    setError('');
    setOverviewLoading(true);
    setModelsLoading(true);
    const requests: Promise<void>[] = [
      kernel.commands.platform.getAuth().then((value) => { if (current) setAuth(value); }),
      kernel.commands.platform.getOverview().then((value) => { if (current) setOverview(value); }),
      kernel.commands.platform.getAvailableModels(session?.id).then((value) => { if (current) setModels(value); }),
      kernel.commands.platform.getModelProviders().then((value) => { if (current) setModelProviders(value); }),
    ];
    if (session) {
      requests.push(kernel.commands.agent.getState(session.id).then((state) => {
        if (current && state.autoCompactionEnabled !== undefined) setAutoCompact(state.autoCompactionEnabled);
      }));
    }
    Promise.all(requests).catch(() => { if (current) setError(t('settings.error.partial')); }).finally(() => { if (current) { setOverviewLoading(false); setModelsLoading(false); } });
    return () => { current = false; };
  }, [kernel, session, t]);

  async function toggleAutoCompact() {
    if (!session) return;
    const next = !autoCompact;
    setAutoCompact(next);
    setBusy('compact');
    try {
      await kernel.commands.agent.setAutoCompaction(session.id, next);
    } catch (cause) {
      setAutoCompact(!next);
      setError((cause as { message?: string })?.message || t('settings.error.autoCompact'));
    } finally {
      setBusy('');
    }
  }

  async function toggleAuth() {
    const next = !auth.enabled;
    setBusy('auth');
    try {
      const value = await kernel.commands.platform.setAuth(next);
      setAuth((current) => ({ ...current, enabled: value.enabled }));
    } catch (cause) {
      setError((cause as { message?: string })?.message || t('settings.error.auth'));
    } finally {
      setBusy('');
    }
  }

  async function installModule() {
    if (!moduleSource.trim()) return;
    setBusy('module-install');
    setError('');
    try {
      setOverview(await kernel.commands.platform.installModule(moduleSource.trim()));
      setModuleSource('');
    } catch (cause) {
      setError((cause as { message?: string })?.message || t('settings.error.installModule'));
    } finally {
      setBusy('');
    }
  }

  async function inspectModuleArchive(file: File) {
    const desktop = window as Window & { transportxDesktop?: { filePath(file: File): string } };
    const sourcePath = desktop.transportxDesktop?.filePath(file);
    if (!sourcePath) {
      setError(t('settings.error.moduleArchiveDesktop'));
      return;
    }
    setBusy('module-archive-inspect');
    setError('');
    try {
      const inspection = await kernel.commands.platform.inspectModuleArchive(sourcePath);
      setArchiveInspection(inspection);
      setSelectedArchiveModules(inspection.modules.filter((module) => module.status === 'ready').map((module) => `${module.id}@${module.version}`));
    } catch (cause) {
      setError((cause as { message?: string })?.message || t('settings.error.inspectModuleArchive'));
    } finally {
      setBusy('');
    }
  }

  async function installModuleArchive() {
    if (!archiveInspection || !selectedArchiveModules.length) return;
    setBusy('module-archive-install');
    setError('');
    try {
      const selections = selectedArchiveModules.map((key) => {
        const separator = key.lastIndexOf('@');
        return { id: key.slice(0, separator), version: key.slice(separator + 1) };
      });
      setOverview(await kernel.commands.platform.installModuleArchive(archiveInspection.importId, selections));
      setArchiveInspection(null);
      setSelectedArchiveModules([]);
    } catch (cause) {
      setError((cause as { message?: string })?.message || t('settings.error.installModuleArchive'));
      setArchiveInspection(null);
      setSelectedArchiveModules([]);
    } finally {
      setBusy('');
    }
  }

  function toggleArchiveModule(key: string) {
    setSelectedArchiveModules((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }

  function dismissModuleArchive() {
    if (archiveInspection) void kernel.commands.platform.discardModuleArchive(archiveInspection.importId);
    setArchiveInspection(null);
    setSelectedArchiveModules([]);
  }

  async function uninstallModule(module: PlatformModule) {
    if (!module.removable || !window.confirm(t('settings.confirm.uninstall', { name: module.name }))) return;
    setBusy(`module-uninstall:${module.id}`);
    setError('');
    try {
      setOverview(await kernel.commands.platform.uninstallModule(module.id));
    } catch (cause) {
      setError((cause as { message?: string })?.message || t('settings.error.uninstallModule'));
    } finally {
      setBusy('');
    }
  }

  async function setModuleEnabled(module: PlatformModule, enabled: boolean) {
    setBusy(`module-enable:${module.id}`);
    setError('');
    try {
      setOverview(await kernel.commands.platform.setModuleEnabled(module.id, enabled));
    } catch (cause) {
      setError((cause as { message?: string })?.message || t('settings.error.moduleStatus'));
    } finally {
      setBusy('');
    }
  }

  async function migrateLegacyModules() {
    setBusy('module-migrate');
    setError('');
    try {
      setOverview(await kernel.commands.platform.migrateLegacyModules());
    } catch (cause) {
      setError((cause as { message?: string })?.message || t('settings.error.migrateModules'));
    } finally {
      setBusy('');
    }
  }

  async function disconnectModelProvider() {
    const target = disconnectTarget;
    setDisconnectTarget(null);
    if (!target) return;
    setBusy(`model-disconnect:${target.id}`);
    setError('');
    try {
      await kernel.commands.platform.disconnectModelProvider(target.id);
      const [nextModels, nextProviders] = await Promise.all([
        kernel.commands.platform.getAvailableModels(),
        kernel.commands.platform.getModelProviders(),
      ]);
      setModels(nextModels);
      setModelProviders(nextProviders);
    } catch (cause) {
      setError((cause as { message?: string })?.message || t('settings.error.disconnectProvider'));
    } finally {
      setBusy('');
    }
  }

  async function deleteModelProvider() {
    const target = deleteProviderTarget;
    setDeleteProviderTarget(null);
    if (!target) return;
    setBusy(`model-delete-provider:${target.id}`);
    setError('');
    try {
      await kernel.commands.platform.deleteModelProvider(target.id);
      const [nextModels, nextProviders] = await Promise.all([kernel.commands.platform.getAvailableModels(), kernel.commands.platform.getModelProviders()]);
      setModels(nextModels);
      setModelProviders(nextProviders);
    } catch (cause) {
      setError((cause as { message?: string })?.message || t('settings.error.deleteProvider'));
    } finally {
      setBusy('');
    }
  }

  async function deleteModel() {
    const target = deleteModelTarget;
    setDeleteModelTarget(null);
    if (!target) return;
    setBusy(`model-delete:${target.provider}/${target.modelId}`);
    setError('');
    try {
      await kernel.commands.platform.deleteModel(target.provider, target.modelId);
      setModels(await kernel.commands.platform.getAvailableModels());
    } catch (cause) {
      setError((cause as { message?: string })?.message || t('settings.error.deleteModel'));
    } finally {
      setBusy('');
    }
  }

  const activeSection = section;
  const navigation = settingsSections.map((item) => ({ ...item, label: t(item.labelKey), icon: item.icon as IconName }));
  const moduleLabels: Record<PlatformModule['type'], string> = { module: t('settings.module.package'), capability: t('settings.module.plugin'), domain: t('settings.module.domain') };
  const localeOptions = [
    { value: 'system', label: t('settings.language.system') },
    { value: 'zh-CN', label: t('settings.language.zhCN') },
    { value: 'en-US', label: t('settings.language.enUS') },
  ];
  const modelDetailsList = useMemo(() => models.map(modelDetails), [models]);
  const providerMetadata = new Map(modelProviders.map((provider) => [provider.id, provider]));
  const connectedProviders = Object.entries(modelDetailsList.reduce<Record<string, ReturnType<typeof modelDetails>[]>>((groups, model) => {
    (groups[model.provider] ||= []).push(model);
    return groups;
  }, {})).map(([id, providerModels]) => ({
    id,
    models: providerModels,
    metadata: providerMetadata.get(id),
    name: providerMetadata.get(id)?.name || id,
  })).sort((left, right) => left.name.localeCompare(right.name));
  const filteredProviders = connectedProviders.map((provider) => ({
    ...provider,
    models: provider.models.filter((model) => {
      const query = modelQuery.trim().toLocaleLowerCase();
      const matchesQuery = !query || `${provider.name} ${provider.id} ${model.name}`.toLocaleLowerCase().includes(query);
      const matchesCapability = modelCapability === 'all' || model[modelCapability];
      return matchesQuery && matchesCapability;
    }),
  })).filter((provider) => provider.models.length);
  let content: ReactNode;

  switch (activeSection) {
    case 'general':
      content = <div className="settings-page-stack">
        <section className="settings-section">
          <h2>{t('settings.appearance')}</h2>
          <div className="theme-grid" role="radiogroup" aria-label={t('settings.appearance')}>
            {themes.map((option) => (
              <button className={`theme-option${theme === option.id ? ' is-active' : ''}`} type="button" role="radio" aria-checked={theme === option.id} key={option.id} onClick={() => onThemeChange(option.id)}>
                <span className="theme-colors">{(swatches?.[option.id] ?? ['#CCCCCC', '#DDDDDD', '#888888']).map((color) => <i style={{ background: color }} key={color} />)}</span>
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="settings-section">
          <h2>{t('settings.language')}</h2>
          <div className="settings-language-control">
            <div className="settings-language-options" role="radiogroup" aria-label={t('settings.language')} aria-describedby="settings-language-help">
              {localeOptions.map((option) => (
                <label className={`settings-language-option${preference === option.value ? ' is-active' : ''}`} key={option.value}>
                  <input type="radio" name="interface-language" value={option.value} checked={preference === option.value} onChange={() => setPreference(option.value as LocalePreference)} />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
            <p className="settings-language-help" id="settings-language-help">{t('settings.languageHelp')}</p>
          </div>
        </section>
        <section className="settings-section">
          <h2>{t('settings.display')}</h2>
          <div className="settings-row"><span><strong>{t('settings.showThinking')}</strong><small>{t('settings.showThinkingHelp')}</small></span><button className={`switch${showThinking ? ' is-on' : ''}`} type="button" role="switch" aria-label={t('settings.showThinking')} aria-checked={showThinking} onClick={() => onShowThinkingChange(!showThinking)}><span /></button></div>
          <div className="settings-row"><span><strong>{t('settings.expandThinking')}</strong><small>{t('settings.expandThinkingHelp')}</small></span><button className={`switch${expandThinking ? ' is-on' : ''}`} type="button" role="switch" aria-label={t('settings.expandThinking')} aria-checked={expandThinking} disabled={!showThinking} onClick={() => onExpandThinkingChange(!expandThinking)}><span /></button></div>
        </section>
        {auth.configured ? <section className="settings-section"><h2>{t('settings.accessControl')}</h2><div className="settings-row"><span><strong>{t('settings.requireLogin')}</strong><small>{t('settings.requireLoginHelp')}</small></span><button className={`switch${auth.enabled ? ' is-on' : ''}`} type="button" role="switch" aria-checked={auth.enabled} disabled={busy === 'auth'} onClick={toggleAuth}><span /></button></div></section> : null}
        <section className="settings-section">
          <h2>{t('settings.localDirectories')}</h2>
          {overviewLoading && !overview ? <div className="settings-loading" aria-label={t('settings.loadingDirectories')}><span /><span /></div> : overview ? (
            <div className="storage-list">
              <span><strong>{t('settings.appData')}</strong><code>{overview.storage.root}</code></span>
              <span><strong>{t('settings.taskWorkspace')}</strong><code>{overview.storage.scenario}</code></span>
              <span><strong>{t('settings.modelConfig')}</strong><code>{overview.storage.models}</code></span>
              <span><strong>{t('settings.installedModules')}</strong><code>{overview.storage.modules}</code></span>
            </div>
          ) : <p className="settings-empty">{t('settings.directoriesUnavailable')}</p>}
        </section>
      </div>;
      break;
    case 'agent':
      content = <div className="settings-page-stack">
        <section className="settings-section">
          <h2>{t('settings.session')}</h2>
          <div className="settings-row"><span><strong>{t('settings.autoCompact')}</strong><small>{session ? t('settings.autoCompactHelp') : t('settings.autoCompactNoSession')}</small></span><button className={`switch${autoCompact ? ' is-on' : ''}`} type="button" role="switch" aria-checked={autoCompact} disabled={!session || busy === 'compact'} onClick={toggleAutoCompact}><span /></button></div>
        </section>
        <section className="settings-section">
          <div className="model-access-panel">
          <header className="model-access-heading"><div><h2>{t('settings.modelAccess')}</h2><p>{t('settings.connectedModelsHelp')}</p><small>{t('settings.modelSummary', { providers: connectedProviders.length, models: modelDetailsList.length })}</small></div><Button type="button" onClick={onAddModel}>{t('sessions.addModel')}</Button></header>
          {modelsLoading ? <div className="settings-loading" aria-label={t('settings.loadingModels')}><span /></div> : connectedProviders.length ? <>
            <div className="model-access-toolbar"><label><Icon name="search" /><input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder={t('settings.searchModelsPlaceholder')} aria-label={t('settings.searchModels')} /></label><select value={modelCapability} onChange={(event) => setModelCapability(event.target.value as typeof modelCapability)} aria-label={t('settings.filterModels')}><option value="all">{t('settings.filter.all')}</option><option value="reasoning">{t('settings.model.reasoning')}</option><option value="images">{t('settings.model.images')}</option></select></div>
            {filteredProviders.length ? <div className="model-provider-list">{filteredProviders.map((provider) => <article className="model-provider" key={provider.id}>
              <header className="model-provider-heading"><span className="model-provider-identity"><strong>{provider.name}</strong><code>{provider.id}</code></span><span className="model-provider-meta"><i><b />{t('settings.providerConnected')}</i><small>{t('settings.modelCount', { count: provider.models.length })}</small>{provider.metadata?.custom || provider.metadata?.credentialStored ? <button className="model-provider-more" type="button" aria-label={t('settings.providerActions')} aria-expanded={providerMenu === provider.id} onClick={() => setProviderMenu((current) => current === provider.id ? null : provider.id)}>•••</button> : null}{providerMenu === provider.id ? <span className="model-provider-menu">{provider.metadata?.custom ? <button type="button" disabled={busy === `model-delete-provider:${provider.id}`} onClick={() => { setProviderMenu(null); setDeleteProviderTarget({ id: provider.id, name: provider.name }); }}>{t('settings.deleteProvider')}</button> : <button type="button" disabled={busy === `model-disconnect:${provider.id}`} onClick={() => { setProviderMenu(null); setDisconnectTarget({ id: provider.id, name: provider.name }); }}>{t('settings.disconnectProvider')}</button>}</span> : null}</span></header>
              <div className="model-provider-content">{provider.models.map((model) => <div className="model-provider-row" key={`${provider.id}:${model.modelId}`}><span className="model-provider-model-identity"><strong>{model.name}</strong><code>{model.modelId}</code></span><span className="model-badges">{model.context ? <i>{model.context}</i> : null}{model.reasoning ? <i>{t('settings.model.reasoning')}</i> : null}{model.images ? <i>{t('settings.model.images')}</i> : null}<span className="model-row-actions">{model.raw ? <Button type="button" variant="quiet" onClick={() => setEditModelTarget({ provider: provider.id, model: model.raw! })}>{t('settings.editModelShort')}</Button> : null}{provider.metadata?.custom && model.raw ? <Button type="button" variant="quiet" disabled={busy === `model-delete:${provider.id}/${model.modelId}`} onClick={() => setDeleteModelTarget({ provider: provider.id, modelId: model.modelId, name: model.name })}>{t('settings.deleteModelShort')}</Button> : null}</span></span></div>)}</div>
            </article>)}</div> : <p className="settings-empty">{t('settings.noMatchingModels')}</p>}
          </> : <p className="settings-empty">{t('settings.noConnectedModels')}</p>}
          <p className="settings-model-restart-note">{t('settings.modelRestartNote')}</p>
          </div>
        </section>
      </div>;
      break;
    case 'modules':
      content = <div className="settings-page-stack">
        <section className="settings-section">
          <h2>{t('settings.capabilityOverview')}</h2>
          {overviewLoading && !overview ? <div className="settings-loading" aria-label={t('settings.loadingModules')}><span /><span /><span /></div> : overview ? <div className="module-summary-grid">{[
            ['Modules', overview.modules.length],
            ['Extensions', overview.modules.reduce((total, module) => total + module.extensions, 0)],
            ['Skills', overview.modules.reduce((total, module) => total + module.skills, 0)],
            ['Data', overview.modules.flatMap((module) => module.assets).filter((asset) => asset.kind === 'data').length],
            ['Knowledge', overview.modules.flatMap((module) => module.assets).filter((asset) => asset.kind === 'knowledge').length],
          ].map(([label, total]) => <div key={label}><strong>{total}</strong><span>{label}</span></div>)}</div> : <p className="settings-empty">{t('settings.modulesUnavailable')}</p>}
        </section>
        <section className="settings-section">
          <h2>{t('settings.moduleSettings')}</h2>
          <input ref={archiveInput} className="sr-only" type="file" accept=".zip,application/zip" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void inspectModuleArchive(file); }} />
          <div className="module-archive-dropzone" role="button" tabIndex={0} onClick={() => archiveInput.current?.click()} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); archiveInput.current?.click(); } }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files.item(0); if (file) void inspectModuleArchive(file); }}>
            <strong>{busy === 'module-archive-inspect' ? t('settings.moduleArchive.inspecting') : t('settings.moduleArchive.drop')}</strong>
            <span>{t('settings.moduleArchive.browse')}</span>
          </div>
          <div className="module-installer">
            <input aria-label={t('settings.modulePath')} value={moduleSource} onChange={(event) => setModuleSource(event.target.value)} placeholder={t('settings.modulePathPlaceholder')} />
            <Button type="button" variant="outline" disabled={!moduleSource.trim() || busy === 'module-install'} onClick={installModule}>{busy === 'module-install' ? t('settings.installing') : t('settings.install')}</Button>
            <Button type="button" variant="outline" disabled={busy === 'module-migrate'} onClick={migrateLegacyModules}>{busy === 'module-migrate' ? t('settings.migrating') : t('settings.migrateLegacy')}</Button>
          </div>
          <p className="module-installer-help">{t('settings.moduleHelp')}</p>
        </section>
        <section className="settings-section">
          <h2>{t('settings.connectedModules')}</h2>
          {overviewLoading && !overview ? <div className="settings-loading" aria-label={t('settings.loadingModules')}><span /><span /><span /></div> : overview?.modules.length ? (
            <div className="module-list module-list-root">
              {overview.modules.map((module) => {
                const activeKinds = new Set(overview.modules.flatMap((item) => item.assets.filter((asset) => asset.active).map((asset) => asset.kind)));
                const missingAssets = module.assets.filter((asset) => !asset.configured && !activeKinds.has(asset.kind));
                const hasActiveAsset = module.assets.some((asset) => asset.active);
                const substituted = module.assets.length > 0 && module.assets.every((asset) => asset.configured || activeKinds.has(asset.kind));
                const status = !module.enabled ? t('settings.module.status.disabled') : hasActiveAsset ? t('settings.module.status.active') : missingAssets.length ? t('settings.module.status.missing') : substituted && module.assets.some((asset) => !asset.configured) ? t('settings.module.status.substituted') : t('settings.module.status.enabled');
                const contributions = [module.skills ? `${module.skills} Skill` : '', module.extensions ? `${module.extensions} Extension` : '', ...module.assets.map((asset) => asset.kind === 'data' ? 'Data' : asset.kind === 'knowledge' ? 'Knowledge' : 'Template')].filter(Boolean);
                const origin = module.origin === 'installed' ? t('settings.module.origin.installed') : module.origin === 'external' ? t('settings.module.origin.external') : t('settings.module.origin.builtin');
                return <div className="module-row" key={module.id}><span><strong>{module.name}</strong><small>{module.version} · {moduleLabels[module.type]} · {origin} · {module.id}</small>{contributions.length ? <span className="module-contributions">{contributions.map((item) => <i key={item}>{item}</i>)}</span> : null}</span><span className="module-actions"><em data-state={module.enabled && !missingAssets.length ? 'ready' : 'attention'}>{status}</em>{module.removable ? <Button type="button" variant="outline" disabled={busy === `module-enable:${module.id}`} onClick={() => setModuleEnabled(module, !module.enabled)}>{module.enabled ? t('common.disable') : t('common.enable')}</Button> : null}{module.removable ? <Button type="button" variant="outline" disabled={busy === `module-uninstall:${module.id}`} onClick={() => uninstallModule(module)}>{t('settings.module.uninstall')}</Button> : null}</span></div>;
              })}
            </div>
          ) : <p className="settings-empty">{t('settings.noModules')}</p>}
          {overview?.errors.length ? <div className="inline-error" role="alert">{overview.errors.map((item) => item.message).join('；')}</div> : null}
        </section>
      </div>;
      break;
  }

  return (
    <section className="settings-workspace" aria-label={t('settings.title')} data-testid="settings-workspace">
      <aside className="settings-navigation" aria-label={t('settings.categories')}>
        <button className="settings-return" type="button" onClick={onBack}>{t('settings.back')}</button>
        <nav className="settings-navigation-list" aria-label={t('settings.categoryList')}>
          {navigation.map((item) => <button className={`settings-navigation-item${activeSection === item.id ? ' is-active' : ''}`} type="button" aria-current={activeSection === item.id ? 'page' : undefined} key={item.id} onClick={() => onSectionChange(item.id)}><Icon name={item.icon} />{item.label}</button>)}
        </nav>
      </aside>
      <main className="settings-page-scroll">
        <div className="settings-page">
          <h1>{navigation.find((item) => item.id === activeSection)?.label}</h1>
          {content}
          {error ? <div className="inline-error" role="alert">{error}</div> : null}
        </div>
      </main>
      <ConfirmationDialog open={!!disconnectTarget} onOpenChange={(open) => { if (!open) setDisconnectTarget(null); }} title={t('settings.disconnectProvider')} description={disconnectTarget ? t('settings.confirm.disconnectProvider', { name: disconnectTarget.name }) : ''} confirmLabel={t('settings.disconnectProvider')} onConfirm={() => void disconnectModelProvider()} />
      <ConfirmationDialog open={!!deleteProviderTarget} onOpenChange={(open) => { if (!open) setDeleteProviderTarget(null); }} title={t('settings.deleteProvider')} description={deleteProviderTarget ? t('settings.confirm.deleteProvider', { name: deleteProviderTarget.name }) : ''} confirmLabel={t('settings.deleteProvider')} onConfirm={() => void deleteModelProvider()} />
      <ConfirmationDialog open={!!deleteModelTarget} onOpenChange={(open) => { if (!open) setDeleteModelTarget(null); }} title={t('settings.deleteModel')} description={deleteModelTarget ? t('settings.confirm.deleteModel', { name: deleteModelTarget.name }) : ''} confirmLabel={t('settings.deleteModel')} onConfirm={() => void deleteModel()} />
      <ModelEditDialog open={!!editModelTarget} onOpenChange={(open) => { if (!open) setEditModelTarget(null); }} provider={editModelTarget?.provider || ''} model={editModelTarget?.model || null} onSaved={() => { void kernel.commands.platform.getAvailableModels().then(setModels); }} />
      <Dialog open={!!archiveInspection} onOpenChange={(open) => { if (!open && busy !== 'module-archive-install') dismissModuleArchive(); }} title={t('settings.moduleArchive.previewTitle')} className="module-archive-dialog" footer={<><DialogClose asChild><Button type="button" variant="quiet" disabled={busy === 'module-archive-install'}>{t('common.cancel')}</Button></DialogClose><Button type="button" variant="primary" disabled={!selectedArchiveModules.length || busy === 'module-archive-install'} onClick={() => void installModuleArchive()}>{busy === 'module-archive-install' ? t('settings.installing') : t('settings.moduleArchive.installSelected', { count: selectedArchiveModules.length })}</Button></>}>
        {archiveInspection ? <>
          <p className="module-archive-summary">{t('settings.moduleArchive.previewSummary', { name: archiveInspection.sourceName, count: archiveInspection.modules.length, size: `${Math.ceil(archiveInspection.uncompressedBytes / 1024 / 1024)} MB` })}</p>
          <div className="module-archive-list">
            {archiveInspection.modules.map((module) => {
              const key = `${module.id}@${module.version}`;
              const selectable = module.status === 'ready';
              return <label key={key} className="module-archive-row" data-state={module.status}>
                <input type="checkbox" checked={selectedArchiveModules.includes(key)} disabled={!selectable || busy === 'module-archive-install'} onChange={() => toggleArchiveModule(key)} />
                <span><strong>{module.name}</strong><small>{module.version} · {module.id}</small>{module.message ? <small>{module.message}</small> : <small>{module.skills ? `${module.skills} Skill` : ''}{module.skills && module.extensions ? ' · ' : ''}{module.extensions ? `${module.extensions} Extension` : ''}{module.assets ? `${module.skills || module.extensions ? ' · ' : ''}${module.assets} Asset` : ''}</small>}</span>
                <em>{t(`settings.moduleArchive.status.${module.status}`)}</em>
              </label>;
            })}
          </div>
          <p className="module-archive-trust">{t('settings.moduleArchive.trust')}</p>
        </> : null}
      </Dialog>
    </section>
  );
}
