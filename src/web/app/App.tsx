import { lazy, Suspense, useEffect, useState } from 'react';
import { Button } from '../components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '../components/ui/card';

const AdapterNote = lazy(() => import('../views/adapter-note'));

const themes = [
  { id: 'night', label: 'Night', swatch: '#9dd7d0' },
  { id: 'dawn', label: 'Dawn', swatch: '#e8ad8e' },
  { id: 'midnight', label: 'Midnight', swatch: '#8fb8ff' },
  { id: 'clean', label: 'Clean', swatch: '#2463eb' },
  { id: 'terracotta', label: 'Terracotta', swatch: '#b96d4c' },
  { id: 'sage', label: 'Sage', swatch: '#71845d' },
] as const;

type ThemeId = (typeof themes)[number]['id'];

function initialTheme(): ThemeId {
  if (typeof window === 'undefined') return 'night';
  const saved = window.localStorage.getItem('tau-theme');
  return themes.some((theme) => theme.id === saved) ? saved as ThemeId : 'night';
}

export function App() {
  const [theme, setTheme] = useState<ThemeId>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('tau-theme', theme);
  }, [theme]);

  return (
    <div className="react-shell" data-testid="react-shell">
      <div className="react-grain" aria-hidden="true" />
      <header className="react-topbar">
        <a className="react-brand" href="/react/" aria-label="Pi Traffic React Web Adapter">
          <span className="react-brand-mark">τ</span>
          <span>
            <strong>PI TRAFFIC</strong>
            <small>WEB ADAPTER</small>
          </span>
        </a>
        <div className="react-topbar-meta">
          <span className="react-version">PHASE 02 / FOUNDATION</span>
          <span className="react-live-dot" aria-label="React shell ready" />
        </div>
      </header>

      <div className="react-shell-grid">
        <aside className="react-rail">
          <div>
            <span className="eyebrow">CURRENT ENTRY</span>
            <div className="react-route-card">
              <span className="react-route-method">GET</span>
              <code>/react/</code>
            </div>
            <p className="react-rail-copy">
              独立的 React/Vite 入口。legacy 工作台继续保留在默认根路径。
            </p>
          </div>

          <div className="react-rail-footer">
            <span className="eyebrow">THEME TOKENS</span>
            <div className="theme-switcher" data-testid="theme-switcher" role="group" aria-label="选择主题">
              {themes.map((option) => (
                <button
                  className={`theme-chip${theme === option.id ? ' is-active' : ''}`}
                  key={option.id}
                  type="button"
                  aria-pressed={theme === option.id}
                  title={option.label}
                  onClick={() => setTheme(option.id)}
                >
                  <span className="theme-chip-swatch" style={{ backgroundColor: option.swatch }} />
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <main className="react-main">
          <section className="react-hero" aria-labelledby="react-hero-title">
            <div className="react-hero-kicker">
              <span className="eyebrow">TRAFFIC AGENT WORKSPACE</span>
              <span className="react-kicker-rule" aria-hidden="true" />
              <span className="react-kicker-status" data-testid="kernel-status">KERNEL BOUNDARY READY</span>
            </div>
            <h1 id="react-hero-title">
              把交通分析，<em>变成一条</em><br />
              可回放的工作流。
            </h1>
            <p className="react-hero-copy">
              这是 React Web Adapter 的独立基座。它连接同一套 Node Server 与协议边界，
              但不会抢占 legacy 页面，也不会在空壳阶段复制 Agent 状态。
            </p>
            <div className="react-hero-actions">
              <a className="ui-button ui-button-primary" href="/" data-testid="legacy-link">
                返回 legacy 工作台 <span aria-hidden="true">↗</span>
              </a>
              <Button variant="quiet" onClick={() => setTheme(theme === 'night' ? 'clean' : 'night')}>
                切换明暗预设
              </Button>
            </div>
          </section>

          <section className="react-signal-grid" aria-label="阶段状态">
            <Card className="signal-card signal-card-accent">
              <CardHeader>
                <span className="signal-index">01 / RUNTIME</span>
                <CardTitle>同一台服务，两个入口</CardTitle>
                <CardDescription>
                  API、WebSocket 与 Pi RPC 边界保持不变；React 通过独立静态根接入。
                </CardDescription>
              </CardHeader>
              <div className="signal-mark" aria-hidden="true">↗</div>
            </Card>
            <Card className="signal-card">
              <CardHeader>
                <span className="signal-index">02 / CONTRACT</span>
                <CardTitle>Kernel 是唯一投影</CardTitle>
                <CardDescription>
                  未来组件只读取 selector、调用 command port，不直接碰 JSONL 或原始事件。
                </CardDescription>
              </CardHeader>
              <div className="signal-pulse" aria-hidden="true"><span /><span /><span /></div>
            </Card>
          </section>

          <Suspense fallback={<div className="adapter-note adapter-note-loading">加载适配边界…</div>}>
            <AdapterNote />
          </Suspense>

          <footer className="react-footer">
            <span>PI TRAFFIC WORKSPACE</span>
            <span>LEGACY /react 共存策略已启用</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
