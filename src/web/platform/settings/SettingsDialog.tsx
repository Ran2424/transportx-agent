import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LiveSession, ModelRecord } from '../../../public/app-types.js';
import type { ModelProviderAccess, PlatformModule, PlatformOverview } from '../../../public/kernel/commands.js';
import { useAppServices } from '../../app/AppProviders';
import { Button } from '../../components/ui/button';
import { useLocale } from '../../i18n/LocaleProvider';
import type { LocalePreference } from '../../i18n';
import i18n from '../../i18n';

export const themes = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'sand', label: 'Sand' },
] as const;

export type ThemeId = (typeof themes)[number]['id'];

export const settingsSections = [
  { id: 'general', labelKey: 'settings.section.general' },
  { id: 'agent', labelKey: 'settings.section.agent' },
  { id: 'modules', labelKey: 'settings.section.modules' },
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
  session: LiveSession | null;
  onAddModel(): void;
  section: SettingsSectionId;
  onSectionChange(section: SettingsSectionId): void;
  onBack(): void;
};

function modelDetails(model: ModelRecord | string) {
  if (typeof model === 'string') {
    const slash = model.indexOf('/');
    return { provider: slash > 0 ? model.slice(0, slash) : i18n.t('settings.model.unknownProvider'), name: slash > 0 ? model.slice(slash + 1) : model, details: '' };
  }
  const name = model.name || model.label || model.id || model.model || i18n.t('settings.model.unnamed');
  const details = [model.contextWindow || model.context || model.context_window ? i18n.t('settings.model.context') : '', model.thinking ? i18n.t('settings.model.reasoning') : '', model.images ? i18n.t('settings.model.images') : ''].filter(Boolean).join(' · ');
  return { provider: model.provider || i18n.t('settings.model.unknownProvider'), name, details };
}

export function SettingsPage({ theme, onThemeChange, showThinking, onShowThinkingChange, session, onAddModel, section, onSectionChange, onBack }: SettingsPageProps) {
  const { t } = useTranslation();
  const { preference, setPreference } = useLocale();
  const { kernel } = useAppServices();
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
  const [swatches, setSwatches] = useState<Record<ThemeId, string[]> | null>(null);

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

  async function disconnectModelProvider(providerId: string, providerName: string) {
    if (!window.confirm(t('settings.confirm.disconnectProvider', { name: providerName }))) return;
    setBusy(`model-disconnect:${providerId}`);
    setError('');
    try {
      await kernel.commands.platform.disconnectModelProvider(providerId);
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

  const activeSection = section;
  const navigation = settingsSections.map((item) => ({ ...item, label: t(item.labelKey) }));
  const moduleLabels: Record<PlatformModule['type'], string> = { module: t('settings.module.package'), capability: t('settings.module.plugin'), domain: t('settings.module.domain') };
  const localeOptions = [
    { value: 'system', label: t('settings.language.system') },
    { value: 'zh-CN', label: t('settings.language.zhCN') },
    { value: 'en-US', label: t('settings.language.enUS') },
  ];
  const modelsByProvider = models.map(modelDetails).reduce<Record<string, ReturnType<typeof modelDetails>[]>>((groups, model) => {
    (groups[model.provider] ||= []).push(model);
    return groups;
  }, {});
  const providerMetadata = new Map(modelProviders.map((provider) => [provider.id, provider]));
  const connectedProviders = Object.entries(modelsByProvider).map(([id, providerModels]) => ({
    id,
    models: providerModels,
    metadata: providerMetadata.get(id),
    name: providerMetadata.get(id)?.name || id,
  })).sort((left, right) => left.name.localeCompare(right.name));
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
          <div className="settings-row"><span><strong>{t('settings.showThinking')}</strong><small>{t('settings.showThinkingHelp')}</small></span><button className={`switch${showThinking ? ' is-on' : ''}`} type="button" role="switch" aria-checked={showThinking} onClick={() => onShowThinkingChange(!showThinking)}><span /></button></div>
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
          <h2>{t('settings.modelAccess')}</h2>
          <div className="settings-row"><span><strong>{t('settings.connectedModels')}</strong><small>{t('settings.connectedModelsHelp')}</small></span><Button type="button" variant="outline" onClick={onAddModel}>{t('sessions.addModel')}</Button></div>
          {modelsLoading ? <div className="settings-loading" aria-label={t('settings.loadingModels')}><span /></div> : connectedProviders.length ? <div className="model-provider-list">{connectedProviders.map((provider) => <details className="model-provider" key={provider.id}>
            <summary>
              <span className="model-provider-identity"><strong>{provider.name}</strong><code>{provider.id}</code></span>
              <span className="model-provider-meta"><small>{t('settings.modelCount', { count: provider.models.length })}</small><i>{t('settings.providerConnected')}</i></span>
            </summary>
            <div className="model-provider-content">
              {provider.models.map((model, index) => <div className="model-provider-row" key={`${provider.id}:${model.name}:${index}`}><strong>{model.name}</strong>{model.details ? <small>{model.details}</small> : null}</div>)}
              {provider.metadata?.credentialStored ? <div className="model-provider-actions"><Button type="button" variant="quiet" disabled={busy === `model-disconnect:${provider.id}`} onClick={() => disconnectModelProvider(provider.id, provider.name)}>{t('settings.disconnectProvider')}</Button></div> : null}
            </div>
          </details>)}</div> : <p className="settings-empty">{t('settings.noConnectedModels')}</p>}
          <p className="settings-model-restart-note">{t('settings.modelRestartNote')}</p>
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
          {navigation.map((item) => <button className={`settings-navigation-item${activeSection === item.id ? ' is-active' : ''}`} type="button" aria-current={activeSection === item.id ? 'page' : undefined} key={item.id} onClick={() => onSectionChange(item.id)}>{item.label}</button>)}
        </nav>
      </aside>
      <main className="settings-page-scroll">
        <div className="settings-page">
          <h1>{navigation.find((item) => item.id === activeSection)?.label}</h1>
          {content}
          {error ? <div className="inline-error" role="alert">{error}</div> : null}
        </div>
      </main>
    </section>
  );
}
