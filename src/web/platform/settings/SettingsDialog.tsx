import { useEffect, useState, type ReactNode } from 'react';
import type { LiveSession, ModelRecord } from '../../../public/app-types.js';
import type { PlatformModule, PlatformOverview } from '../../../public/kernel/commands.js';
import { useAppServices } from '../../app/AppProviders';
import { Button } from '../../components/ui/button';

export const themes = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'sand', label: 'Sand' },
] as const;

export type ThemeId = (typeof themes)[number]['id'];

export const settingsSections = [
  { id: 'general', label: '常规' },
  { id: 'agent', label: 'Agent' },
  { id: 'modules', label: '模块' },
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

const moduleLabels: Record<PlatformModule['type'], string> = {
  module: '模块包',
  capability: '插件',
  domain: '领域',
};

function modelDetails(model: ModelRecord | string) {
  if (typeof model === 'string') {
    const slash = model.indexOf('/');
    return { provider: slash > 0 ? model.slice(0, slash) : '未指定供应商', name: slash > 0 ? model.slice(slash + 1) : model, details: '' };
  }
  const name = model.name || model.label || model.id || model.model || '未命名模型';
  const details = [model.contextWindow || model.context || model.context_window ? '支持上下文配置' : '', model.thinking ? '推理' : '', model.images ? '图像' : ''].filter(Boolean).join(' · ');
  return { provider: model.provider || '未指定供应商', name, details };
}

export function SettingsPage({ theme, onThemeChange, showThinking, onShowThinkingChange, session, onAddModel, section, onSectionChange, onBack }: SettingsPageProps) {
  const { kernel } = useAppServices();
  const [autoCompact, setAutoCompact] = useState(true);
  const [auth, setAuth] = useState({ configured: false, enabled: false });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [models, setModels] = useState<Array<ModelRecord | string>>([]);
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
    ];
    if (session) {
      requests.push(kernel.commands.agent.getState(session.id).then((state) => {
        if (current && state.autoCompactionEnabled !== undefined) setAutoCompact(state.autoCompactionEnabled);
      }));
    }
    Promise.all(requests).catch(() => { if (current) setError('部分设置暂时无法读取。'); }).finally(() => { if (current) { setOverviewLoading(false); setModelsLoading(false); } });
    return () => { current = false; };
  }, [kernel, session]);

  async function toggleAutoCompact() {
    if (!session) return;
    const next = !autoCompact;
    setAutoCompact(next);
    setBusy('compact');
    try {
      await kernel.commands.agent.setAutoCompaction(session.id, next);
    } catch (cause) {
      setAutoCompact(!next);
      setError((cause as { message?: string })?.message || '更新自动压缩失败');
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
      setError((cause as { message?: string })?.message || '更新登录验证失败');
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
      setError((cause as { message?: string })?.message || '安装模块失败');
    } finally {
      setBusy('');
    }
  }

  async function uninstallModule(module: PlatformModule) {
    if (!module.removable || !window.confirm(`卸载“${module.name}”？模块内的 Skill、插件和资产将一并移除。`)) return;
    setBusy(`module-uninstall:${module.id}`);
    setError('');
    try {
      setOverview(await kernel.commands.platform.uninstallModule(module.id));
    } catch (cause) {
      setError((cause as { message?: string })?.message || '卸载模块失败');
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
      setError((cause as { message?: string })?.message || '更新模块状态失败');
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
      setError((cause as { message?: string })?.message || '迁移旧模块失败');
    } finally {
      setBusy('');
    }
  }

  const activeSection = section;
  const navigation = settingsSections;
  const modelsByProvider = models.map(modelDetails).reduce<Record<string, ReturnType<typeof modelDetails>[]>>((groups, model) => {
    (groups[model.provider] ||= []).push(model);
    return groups;
  }, {});
  let content: ReactNode;

  switch (activeSection) {
    case 'general':
      content = <div className="settings-page-stack">
        <section className="settings-section">
          <h2>外观主题</h2>
          <div className="theme-grid" role="radiogroup" aria-label="外观主题">
            {themes.map((option) => (
              <button className={`theme-option${theme === option.id ? ' is-active' : ''}`} type="button" role="radio" aria-checked={theme === option.id} key={option.id} onClick={() => onThemeChange(option.id)}>
                <span className="theme-colors">{(swatches?.[option.id] ?? ['#CCCCCC', '#DDDDDD', '#888888']).map((color) => <i style={{ background: color }} key={color} />)}</span>
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="settings-section">
          <h2>显示</h2>
          <div className="settings-row"><span><strong>显示思考过程</strong><small>在会话中显示模型的思考过程</small></span><button className={`switch${showThinking ? ' is-on' : ''}`} type="button" role="switch" aria-checked={showThinking} onClick={() => onShowThinkingChange(!showThinking)}><span /></button></div>
        </section>
        {auth.configured ? <section className="settings-section"><h2>访问控制</h2><div className="settings-row"><span><strong>要求登录</strong><small>启用后当前未认证连接会被关闭</small></span><button className={`switch${auth.enabled ? ' is-on' : ''}`} type="button" role="switch" aria-checked={auth.enabled} disabled={busy === 'auth'} onClick={toggleAuth}><span /></button></div></section> : null}
        <section className="settings-section">
          <h2>本地目录</h2>
          {overviewLoading && !overview ? <div className="settings-loading" aria-label="正在读取本地目录"><span /><span /></div> : overview ? (
            <div className="storage-list">
              <span><strong>应用数据</strong><code>{overview.storage.root}</code></span>
              <span><strong>任务工作区</strong><code>{overview.storage.scenario}</code></span>
              <span><strong>模型配置</strong><code>{overview.storage.models}</code></span>
              <span><strong>已装模块</strong><code>{overview.storage.modules}</code></span>
            </div>
          ) : <p className="settings-empty">暂时无法读取本地目录。</p>}
        </section>
      </div>;
      break;
    case 'agent':
      content = <div className="settings-page-stack">
        <section className="settings-section">
          <h2>会话</h2>
          <div className="settings-row"><span><strong>自动压缩上下文</strong><small>{session ? '接近上下文上限时由 Pi 自动整理' : '选择运行中的任务后可设置'}</small></span><button className={`switch${autoCompact ? ' is-on' : ''}`} type="button" role="switch" aria-checked={autoCompact} disabled={!session || busy === 'compact'} onClick={toggleAutoCompact}><span /></button></div>
        </section>
        <section className="settings-section">
          <h2>模型接入</h2>
          <div className="settings-row"><span><strong>已接入模型</strong><small>模型按供应商归组，API Key 仅保存在本机</small></span><Button type="button" variant="outline" onClick={onAddModel}>添加模型</Button></div>
          {modelsLoading ? <div className="settings-loading" aria-label="正在读取模型"><span /></div> : Object.keys(modelsByProvider).length ? <div className="model-provider-list">{Object.entries(modelsByProvider).map(([provider, providerModels]) => <section className="model-provider" key={provider}><h3>{provider}</h3>{providerModels.map((model) => <div className="model-provider-row" key={`${provider}:${model.name}`}><strong>{model.name}</strong>{model.details ? <small>{model.details}</small> : null}</div>)}</section>)}</div> : <p className="settings-empty">暂无已接入模型。</p>}
        </section>
      </div>;
      break;
    case 'modules':
      content = <div className="settings-page-stack">
        <section className="settings-section">
          <h2>能力概览</h2>
          {overviewLoading && !overview ? <div className="settings-loading" aria-label="正在读取模块"><span /><span /><span /></div> : overview ? <div className="module-summary-grid">{[
            ['Modules', overview.modules.length],
            ['Extensions', overview.modules.reduce((total, module) => total + module.extensions, 0)],
            ['Skills', overview.modules.reduce((total, module) => total + module.skills, 0)],
            ['Data', overview.modules.flatMap((module) => module.assets).filter((asset) => asset.kind === 'data').length],
            ['Knowledge', overview.modules.flatMap((module) => module.assets).filter((asset) => asset.kind === 'knowledge').length],
          ].map(([label, total]) => <div key={label}><strong>{total}</strong><span>{label}</span></div>)}</div> : <p className="settings-empty">暂时无法读取模块信息。</p>}
        </section>
        <section className="settings-section">
          <h2>模块设置</h2>
          <div className="module-installer">
            <input aria-label="模块包路径" value={moduleSource} onChange={(event) => setModuleSource(event.target.value)} placeholder="包含 manifest.json 的模块包目录" />
            <Button type="button" variant="outline" disabled={!moduleSource.trim() || busy === 'module-install'} onClick={installModule}>{busy === 'module-install' ? '安装中…' : '安装'}</Button>
            <Button type="button" variant="outline" disabled={busy === 'module-migrate'} onClick={migrateLegacyModules}>{busy === 'module-migrate' ? '迁移中…' : '迁移旧模块'}</Button>
          </div>
          <p className="module-installer-help">模块可贡献 Skill、Extension、Data 和 Knowledge。</p>
        </section>
        <section className="settings-section">
          <h2>已接入模块</h2>
          {overviewLoading && !overview ? <div className="settings-loading" aria-label="正在读取模块"><span /><span /><span /></div> : overview?.modules.length ? (
            <div className="module-list module-list-root">
              {overview.modules.map((module) => {
                const activeKinds = new Set(overview.modules.flatMap((item) => item.assets.filter((asset) => asset.active).map((asset) => asset.kind)));
                const missingAssets = module.assets.filter((asset) => !asset.configured && !activeKinds.has(asset.kind));
                const hasActiveAsset = module.assets.some((asset) => asset.active);
                const substituted = module.assets.length > 0 && module.assets.every((asset) => asset.configured || activeKinds.has(asset.kind));
                const status = !module.enabled ? '不可用' : hasActiveAsset ? '当前生效' : missingAssets.length ? '待配置资产' : substituted && module.assets.some((asset) => !asset.configured) ? '由其他模块提供' : '已启用';
                const contributions = [module.skills ? `${module.skills} Skill` : '', module.extensions ? `${module.extensions} Extension` : '', ...module.assets.map((asset) => asset.kind === 'data' ? 'Data' : asset.kind === 'knowledge' ? 'Knowledge' : 'Template')].filter(Boolean);
                return <div className="module-row" key={module.id}><span><strong>{module.name}</strong><small>{module.version} · {moduleLabels[module.type]} · {module.origin === 'installed' ? '用户安装' : module.origin === 'external' ? '外部加载' : '内置'} · {module.id}</small>{contributions.length ? <span className="module-contributions">{contributions.map((item) => <i key={item}>{item}</i>)}</span> : null}</span><span className="module-actions"><em data-state={module.enabled && !missingAssets.length ? 'ready' : 'attention'}>{status}</em>{module.removable ? <Button type="button" variant="outline" disabled={busy === `module-enable:${module.id}`} onClick={() => setModuleEnabled(module, !module.enabled)}>{module.enabled ? '停用' : '启用'}</Button> : null}{module.removable ? <Button type="button" variant="outline" disabled={busy === `module-uninstall:${module.id}`} onClick={() => uninstallModule(module)}>卸载</Button> : null}</span></div>;
              })}
            </div>
          ) : <p className="settings-empty">暂无已注册模块。</p>}
          {overview?.errors.length ? <div className="inline-error" role="alert">{overview.errors.map((item) => item.message).join('；')}</div> : null}
        </section>
      </div>;
      break;
  }

  return (
    <section className="settings-workspace" aria-label="设置" data-testid="settings-workspace">
      <aside className="settings-navigation" aria-label="设置分类">
        <button className="settings-return" type="button" onClick={onBack}>返回工作台</button>
        <nav className="settings-navigation-list" aria-label="设置分类列表">
          {navigation.map((item) => <button className={`settings-navigation-item${activeSection === item.id ? ' is-active' : ''}`} type="button" aria-current={activeSection === item.id ? 'page' : undefined} key={item.id} onClick={() => onSectionChange(item.id)}>{item.label}</button>)}
        </nav>
      </aside>
      <main className="settings-page-scroll">
        <div className="settings-page">
          <h1>{settingsSections.find((item) => item.id === activeSection)?.label}</h1>
          {content}
          {error ? <div className="inline-error" role="alert">{error}</div> : null}
        </div>
      </main>
    </section>
  );
}
