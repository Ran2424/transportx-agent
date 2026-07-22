import type { LiveSession } from '../../../public/app-types.js';
import { Button } from '../../components/ui/button';
import { ConversationWorkspace } from './ConversationWorkspace';

export function ConversationStage({ session, loading, onNewSession, showThinking }: { session: LiveSession | null; loading: boolean; onNewSession(): void; showThinking: boolean }) {
  if (loading) {
    return <main className="conversation-stage" aria-busy="true"><div className="stage-loader"><span /><strong>正在同步 Session Projection</strong><small>读取稳定快照与实时 overlay…</small></div></main>;
  }

  if (!session) {
    return (
      <main className="conversation-stage">
        <section className="workspace-welcome">
          <div className="welcome-mark">τ</div>
          <h1>从一个清晰的<br /><em>交通问题</em>开始。</h1>
          <Button onClick={onNewSession}>新建交通任务 <span aria-hidden="true">↗</span></Button>
          <div className="welcome-capabilities"><article><strong>交通问数</strong><span>路段 · 时段 · 需求</span></article><article><strong>地图分析</strong><span>空间关系 · 可视化</span></article><article><strong>报告生成</strong><span>结论 · 文件 · 交付</span></article></div>
        </section>
      </main>
    );
  }

  return <ConversationWorkspace sessionId={session.id} showThinking={showThinking} />;
}
