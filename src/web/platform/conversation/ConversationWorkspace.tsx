import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MessageContentBlock } from '../../../public/app-types.js';
import { messageOutcome } from '../../../contracts/run-feedback.ts';
import { messageText, messageThinking } from '../../../public/kernel/stores/conversation-store.js';
import type { CitationEnvelope } from '../../../contracts/citation.ts';
import { appKernel } from '../../app/composition-root';
import { useConversation, useSession, useSessionAttachments, useSessionCompacting, useToolExecutions } from '../../app/store-hooks';
import { BrandMark } from '../../components/BrandMark';
import { ConversationComposer } from './conversation-composer';
import { CitationManager } from './citation-manager';
import { AssistantMessage, UserMessage } from './message-cards';
import { ToolCard } from './tool-card';
import { projectTools } from './tool-projection';
import { projectCitationText, projectMessageCitations } from '../../features/citation/citation-projection';

export function ConversationWorkspace({ sessionId, showThinking, expandThinking }: { sessionId: string; showThinking: boolean; expandThinking: boolean }) {
  const { t } = useTranslation();
  const kernel = appKernel;
  const data = useConversation(sessionId);
  const session = useSession(sessionId);
  const compacting = useSessionCompacting(sessionId);
  const storedAttachments = useSessionAttachments(sessionId);
  const liveTools = useToolExecutions(sessionId);
  const viewportRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const entries = data?.snapshotEntries || [];
  const attachments = storedAttachments || {};
  const [citationEnvelope, setCitationEnvelope] = useState<CitationEnvelope | null>(null);
  const [retryDraft, setRetryDraft] = useState<{ message: string }>();
  const [citationManagerOpen, setCitationManagerOpen] = useState(false);
  useEffect(() => { setCitationEnvelope(null); setRetryDraft(undefined); }, [sessionId]);
  useEffect(() => { void kernel.commands.session.listAttachments(sessionId).catch(() => {}); }, [kernel, sessionId]);
  useEffect(() => {
    let active = true;
    void kernel.commands.citation.list(sessionId).then((citations) => {
      if (active) setCitationEnvelope(citations);
    }).catch(() => {});
    return () => { active = false; };
  }, [data?.live.active, entries.length, kernel, sessionId]);
  const toolProjection = useMemo(() => projectTools(entries, liveTools || {}), [entries, liveTools]);
  const citationProjection = useMemo(() => projectMessageCitations(entries, citationEnvelope), [citationEnvelope, entries]);
  useEffect(() => {
    if (!nearBottom.current) return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (viewport && nearBottom.current) viewport.scrollTop = viewport.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [compacting, entries, data?.live.streamingText, data?.live.streamingThinking, toolProjection]);
  const showLiveAssistant = !!data?.live.active && (data.live.thinkingStartedAt !== null || !!data.live.streamingThinking || !!data.live.streamingText);
  const optimisticCitationProjection = data?.live.optimisticPrompt ? projectCitationText(data.live.optimisticPrompt.message, citationProjection.available) : undefined;
  return <main className="conversation-workspace"><div className="conversation-scroll" ref={viewportRef} onScroll={(event) => { const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}><div className="conversation-thread">{entries.length ? entries.map((entry, index) => { const message = entry.message; if (!message) return null; const key = entry.id || index; const toolsForEntry = toolProjection.byEntry.get(entry) || []; if (message.role === 'user') return <UserMessage key={key} message={message} sessionId={sessionId} attachments={attachments} projection={citationProjection.byEntry.get(entry)} />; if (message.role === 'assistant') { const showMessage = !!messageOutcome(message) || !!messageText(message) || (showThinking && !!messageThinking(message)); return <div className="assistant-turn" key={key}>{showMessage ? <AssistantMessage message={message} showThinking={showThinking} expandThinking={expandThinking} projection={citationProjection.byEntry.get(entry)} sessionId={sessionId} onRetry={!data?.live.active ? () => { const previous = entries.slice(0, index).reverse().find((row) => row.message?.role === 'user')?.message; if (previous) setRetryDraft({ message: messageText(previous) }); } : undefined} /> : null}{toolsForEntry.map((tool) => <ToolCard key={tool.id} tool={tool} sessionId={sessionId} />)}</div>; } return toolsForEntry.length ? <div className="assistant-turn" key={key}>{toolsForEntry.map((tool) => <ToolCard key={tool.id} tool={tool} sessionId={sessionId} />)}</div> : null; }) : <div className="conversation-empty"><BrandMark className="conversation-empty-mark" /><h1>{t('conversation.startTitle')}</h1><p>{t('conversation.startDescription')}</p></div>}{data?.live.retry ? <div className="compaction-status" role="status">{t('conversation.retrying', { attempt: data.live.retry.attempt, max: data.live.retry.maxAttempts, seconds: Math.ceil(data.live.retry.delayMs / 1000) })}</div> : data?.live.outcome ? <div className="compaction-status" role="status">{t(`conversation.${data.live.outcome.status}`)}</div> : data?.live.active && !showLiveAssistant && toolProjection.liveOnly.length === 0 ? <div className="compaction-status" role="status">{t('conversation.waiting')}</div> : null}{compacting ? <div className="compaction-status" role="status"><i className="streaming-beacon" />{t('conversation.compacting')}</div> : null}{data?.live.optimisticPrompt ? <UserMessage message={{ role: 'user', content: data.live.optimisticPrompt.message, attachmentIds: data.live.optimisticPrompt.attachmentIds }} sessionId={sessionId} attachments={attachments} projection={optimisticCitationProjection} /> : null}{showLiveAssistant ? <AssistantMessage streaming showThinking={showThinking} expandThinking={expandThinking} thinkingStartedAt={data?.live.thinkingStartedAt} thinkingDurationMs={data?.live.thinkingDurationMs} sessionId={sessionId} message={{ role: 'assistant', content: [{ type: 'thinking', thinking: data?.live.streamingThinking }, { type: 'text', text: data?.live.streamingText }] as MessageContentBlock[] }} /> : null}{toolProjection.liveOnly.map((tool) => <ToolCard key={tool.id} tool={tool} sessionId={sessionId} />)}</div></div><ConversationComposer retryDraft={retryDraft} sessionId={sessionId} session={session} streaming={!!data?.live.active} compacting={compacting} queued={data?.live.queued || []} attachments={attachments} onCitationEnvelope={setCitationEnvelope} onOpenCitationManager={() => setCitationManagerOpen(true)} />{citationManagerOpen ? <CitationManager sessionId={sessionId} onClose={() => setCitationManagerOpen(false)} /> : null}</main>;
}
