import { useEffect, useState } from 'react';
import type { LiveSession } from '../../../public/app-types.js';
import type { PlatformModule, PlatformOverview } from '../../../public/kernel/commands.js';
import { useAppServices } from '../../app/AppProviders';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';

export const themes = [
  { id: 'night', label: 'Night', colors: ['#0d1218', '#9dd7d0', '#e8ad8e'] },
  { id: 'dawn', label: 'Dawn', colors: ['#1a1720', '#e8ad8e', '#d7d68d'] },
  { id: 'midnight', label: 'Midnight', colors: ['#05070c', '#8fb8ff', '#bd9bff'] },
  { id: 'clean', label: 'Clean', colors: ['#f3f7fb', '#2463eb', '#ca6848'] },
  { id: 'terracotta', label: 'Terracotta', colors: ['#f4f0ea', '#b96d4c', '#d6a38b'] },
  { id: 'sage', label: 'Sage', colors: ['#eef1eb', '#71845d', '#aeba9f'] },
] as const;

export type ThemeId = (typeof themes)[number]['id'];

type SettingsDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  theme: ThemeId;
  onThemeChange(theme: ThemeId): void;
  showThinking: boolean;
  onShowThinkingChange(value: boolean): void;
  session: LiveSession | null;
  onAddModel(): void;
};

const moduleLabels: Record<PlatformModule['type'], string> = {
  module: '模块包',
  capability: '插件',
  domain: '领域',
  skill: 'Skill',
  knowledge: '知识',
  data: '数据',
  template: '模板',
};

export function SettingsDialog({ open, onOpenChange, theme, onThemeChange, showThinking, onShowThinkingChange, session, onAddModel }: SettingsDialogProps) {
  const { kernel } = useAppServices();
  const [autoCompact, setAutoCompact] = useState(true);
  const [auth, setAuth] = useState({ configured: false, enabled: false });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [installKind, setInstallKind] = useState<'module' | 'skill' | 'extension' | 'data' | 'knowledge'>('module');
  const [moduleSource, setModuleSource] = useState('');

  useEffect(() => {
    if (!open) return;
    let current = true;
    setError('');
    setOverviewLoading(true);
    const requests: Promise<void>[] = [
      kernel.commands.platform.getAuth().then((value) => { if (current) setAuth(value); }),
      kernel.commands.platform.getOverview().then((value) => { if (current) setOverview(value); }),
    ];
    if (session) {
      requests.push(kernel.commands.agent.getState(session.id).then((state) => {
        if (current && state.autoCompactionEnabled !== undefined) setAutoCompact(state.autoCompactionEnabled);
      }));
    }
    Promise.all(requests).catch(() => { if (current) setError('部分设置暂时无法读取。'); }).finally(() => { if (current) setOverviewLoading(false); });
    return () => { current = false; };
  }, [kernel, open, session]);

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

  function toggleThinking() {
    onShowThinkingChange(!showThinking);
  }

  async function installModule() {
    if (!moduleSource.trim()) return;
    setBusy('module-install');
    setError('');
    try {
      setOverview(await kernel.commands.platform.installModule(moduleSource.trim(), installKind));
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="设置" className="settings-dialog">
      <section className="settings-section">
        <h3>外观主题</h3>
        <div className="theme-grid" role="radiogroup" aria-label="外观主题">
          {themes.map((option) => (
            <button className={`theme-option${theme === option.id ? ' is-active' : ''}`} type="button" role="radio" aria-checked={theme === option.id} key={option.id} onClick={() => onThemeChange(option.id)}>
              <span className="theme-colors">{option.colors.map((color) => <i style={{ background: color }} key={color} />)}</span>
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <h3>Agent</h3>
        <div className="settings-row"><span><strong>自动压缩上下文</strong><small>{session ? '接近上下文上限时由 Pi 自动整理' : '选择运行中的任务后可设置'}</small></span><button className={`switch${autoCompact ? ' is-on' : ''}`} type="button" role="switch" aria-checked={autoCompact} disabled={!session || busy === 'compact'} onClick={toggleAutoCompact}><span /></button></div>
      </section>
      <section className="settings-section">
        <h3>模型接入</h3>
        <div className="settings-row"><span><strong>Pi 模型</strong><small>默认不预选模型，API Key 仅保存在本机</small></span><Button type="button" variant="outline" onClick={onAddModel}>添加模型</Button></div>
      </section>
      <section className="settings-section">
        <h3>显示</h3>
        <div className="settings-row"><span><strong>显示思考过程</strong><small>阶段 5 的 Conversation UI 将读取此偏好</small></span><button className={`switch${showThinking ? ' is-on' : ''}`} type="button" role="switch" aria-checked={showThinking} onClick={toggleThinking}><span /></button></div>
      </section>
      {auth.configured ? <section className="settings-section"><h3>访问控制</h3><div className="settings-row"><span><strong>要求登录</strong><small>启用后当前未认证连接会被关闭</small></span><button className={`switch${auth.enabled ? ' is-on' : ''}`} type="button" role="switch" aria-checked={auth.enabled} disabled={busy === 'auth'} onClick={toggleAuth}><span /></button></div></section> : null}
      <section className="settings-section">
        <h3>本地目录</h3>
        {overviewLoading && !overview ? <div className="settings-loading" aria-label="正在读取本地目录"><span /><span /></div> : overview ? (
          <div className="storage-list">
            <span><strong>应用数据</strong><code>{overview.storage.root}</code></span>
            <span><strong>任务工作区</strong><code>{overview.storage.scenario}</code></span>
            <span><strong>模型配置</strong><code>{overview.storage.models}</code></span>
            <span><strong>已装模块</strong><code>{overview.storage.modules}</code></span>
          </div>
        ) : <p className="settings-empty">暂时无法读取本地目录。</p>}
      </section>
      <section className="settings-section">
        <h3>模块</h3>
        <div className="module-installer">
          <select aria-label="添加类型" value={installKind} onChange={(event) => setInstallKind(event.target.value as typeof installKind)}>
            <option value="module">模块包</option>
            <option value="skill">单独 Skill</option>
            <option value="extension">单独 Extension</option>
            <option value="data">单独 Data</option>
            <option value="knowledge">单独 Knowledge</option>
          </select>
          <input aria-label="本地资源路径" value={moduleSource} onChange={(event) => setModuleSource(event.target.value)} placeholder="本地目录或 manifest.json 的绝对路径" />
          <Button type="button" variant="outline" disabled={!moduleSource.trim() || busy === 'module-install'} onClick={installModule}>{busy === 'module-install' ? '安装中…' : '安装'}</Button>
        </div>
        <p className="module-installer-help">模块包可同时包含 Skill、Extension、Data 和 Knowledge；单独资源安装后也会成为一个受管模块。</p>
        {overviewLoading && !overview ? <div className="settings-loading" aria-label="正在读取模块"><span /><span /><span /></div> : overview?.modules.length ? (
          <div className="module-list module-list-root">
            {overview.modules.map((module) => {
              const missingAssets = module.assets.filter((asset) => !asset.configured);
              const status = !module.enabled ? '不可用' : missingAssets.length ? '待配置资产' : '已启用';
              const contributions = [module.skills ? `${module.skills} Skill` : '', module.extensions ? `${module.extensions} Extension` : '', ...module.assets.map((asset) => asset.kind === 'data' ? 'Data' : asset.kind === 'knowledge' ? 'Knowledge' : 'Template')].filter(Boolean);
              return <div className="module-row" key={module.id}><span><strong>{module.name}</strong><small>{module.version} · {moduleLabels[module.type]} · {module.origin === 'installed' ? '用户安装' : module.origin === 'external' ? '外部加载' : '内置'} · {module.id}</small>{contributions.length ? <span className="module-contributions">{contributions.map((item) => <i key={item}>{item}</i>)}</span> : null}</span><span className="module-actions"><em data-state={module.enabled && !missingAssets.length ? 'ready' : 'attention'}>{status}</em>{module.removable ? <Button type="button" variant="outline" disabled={busy === `module-uninstall:${module.id}`} onClick={() => uninstallModule(module)}>卸载</Button> : null}</span></div>;
            })}
          </div>
        ) : <p className="settings-empty">暂无已注册模块。</p>}
        {overview?.errors.length ? <div className="inline-error" role="alert">{overview.errors.map((item) => item.message).join('；')}</div> : null}
      </section>
      {error ? <div className="inline-error" role="alert">{error}</div> : null}
    </Dialog>
  );
}
