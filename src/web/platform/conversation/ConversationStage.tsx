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
          <div className="welcome-index">00 / READY</div>
          <div className="welcome-mark">τ</div>
          <span className="section-eyebrow">TRAFFIC AGENT WORKSPACE</span>
          <h1>从一个清晰的<br /><em>交通问题</em>开始。</h1>
          <p>创建独立任务，或从左侧恢复已有会话。实时消息与 Composer 将在迁移阶段 5 接入同一 Kernel。</p>
          <Button onClick={onNewSession}>新建交通任务 <span aria-hidden="true">↗</span></Button>
          <div className="welcome-boundaries"><span><i>01</i>独立 Pi RPC</span><span><i>02</i>可回放 JSONL</span><span><i>03</i>会话级工作区</span></div>
        </section>
      </main>
    );
  }

  return <ConversationWorkspace sessionId={session.id} showThinking={showThinking} />;
}
