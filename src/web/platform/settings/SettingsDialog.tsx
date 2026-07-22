import { useEffect, useState } from 'react';
import type { LiveSession } from '../../../public/app-types.js';
import { useAppServices } from '../../app/AppProviders';
import { Dialog } from '../../components/ui/dialog';

export const themes = [
  { id: 'night', label: 'Night', colors: ['#0d1218', '#9dd7d0', '#e8ad8e'] },
  { id: 'dawn', label: 'Dawn', colors: ['#1a1720', '#e8ad8e', '#d7d68d'] },
  { id: 'midnight', label: 'Midnight', colors: ['#05070c', '#8fb8ff', '#bd9bff'] },
  { id: 'clean', label: 'Clean', colors: ['#f3f7fb', '#2463eb', '#ca6848'] },
  { id: 'terracotta', label: 'Terracotta', colors: ['#f4f0ea', '#b96d4c', '#62508c'] },
  { id: 'sage', label: 'Sage', colors: ['#eef1eb', '#71845d', '#775a9b'] },
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
};

export function SettingsDialog({ open, onOpenChange, theme, onThemeChange, showThinking, onShowThinkingChange, session }: SettingsDialogProps) {
  const { kernel } = useAppServices();
  const [autoCompact, setAutoCompact] = useState(true);
  const [auth, setAuth] = useState({ configured: false, enabled: false });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let current = true;
    setError('');
    const requests: Promise<void>[] = [
      kernel.commands.platform.getAuth().then((value) => { if (current) setAuth(value); }),
    ];
    if (session) {
      requests.push(kernel.commands.agent.getState(session.id).then((state) => {
        if (current && state.autoCompactionEnabled !== undefined) setAutoCompact(state.autoCompactionEnabled);
      }));
    }
    Promise.all(requests).catch(() => { if (current) setError('部分设置暂时无法读取。'); });
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="设置" eyebrow="WORKSPACE PREFERENCES" description="外观偏好保存在当前浏览器；Agent 设置按会话隔离。" className="settings-dialog">
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
        <h3>显示</h3>
        <div className="settings-row"><span><strong>显示思考过程</strong><small>阶段 5 的 Conversation UI 将读取此偏好</small></span><button className={`switch${showThinking ? ' is-on' : ''}`} type="button" role="switch" aria-checked={showThinking} onClick={toggleThinking}><span /></button></div>
      </section>
      {auth.configured ? <section className="settings-section"><h3>访问控制</h3><div className="settings-row"><span><strong>要求登录</strong><small>启用后当前未认证连接会被关闭</small></span><button className={`switch${auth.enabled ? ' is-on' : ''}`} type="button" role="switch" aria-checked={auth.enabled} disabled={busy === 'auth'} onClick={toggleAuth}><span /></button></div></section> : null}
      {error ? <div className="inline-error" role="alert">{error}</div> : null}
    </Dialog>
  );
}
