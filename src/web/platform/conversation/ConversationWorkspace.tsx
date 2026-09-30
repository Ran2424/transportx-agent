import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MessageContentBlock } from '../../../public/app-types.js';
import { messageText, messageThinking } from '../../../public/kernel/stores/conversation-store.js';
import type { CitationEnvelope } from '../../../contracts/citation.ts';
import { appKernel } from '../../app/composition-root';
import { useConversationState, useSessionState, useToolExecutionState } from '../../app/store-hooks';
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
  const conversation = useConversationState();
  const sessions = useSessionState();
  const tools = useToolExecutionState();
  const viewportRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const data = conversation.bySession[sessionId];
  const entries = data?.snapshotEntries || [];
  const attachments = sessions.attachmentsBySession[sessionId] || {};
  const [citationEnvelope, setCitationEnvelope] = useState<CitationEnvelope | null>(null);
  const [citationManagerOpen, setCitationManagerOpen] = useState(false);
  useEffect(() => { void kernel.commands.session.listAttachments(sessionId).catch(() => {}); }, [kernel, sessionId]);
  useEffect(() => {
    let active = true;
    void kernel.commands.citation.list(sessionId).then((citations) => {
      if (active) setCitationEnvelope(citations);
    }).catch(() => {});
    return () => { active = false; };
  }, [data?.live.active, entries.length, kernel, sessionId]);
  const liveTools = tools.bySession[sessionId];
  const session = sessions.sessions.find((item) => item.id === sessionId);
  const compacting = !!sessions.compactingBySession[sessionId];
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
  return <main className="conversation-workspace"><div className="conversation-scroll" ref={viewportRef} onScroll={(event) => { const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}><div className="conversation-thread">{entries.length ? entries.map((entry, index) => { const message = entry.message; if (!message) return null; const key = entry.id || index; const toolsForEntry = toolProjection.byEntry.get(entry) || []; if (message.role === 'user') return <UserMessage key={key} message={message} sessionId={sessionId} attachments={attachments} projection={citationProjection.byEntry.get(entry)} />; if (message.role === 'assistant') { const showMessage = !!messageText(message) || (showThinking && !!messageThinking(message)); return <div className="assistant-turn" key={key}>{showMessage ? <AssistantMessage message={message} showThinking={showThinking} expandThinking={expandThinking} projection={citationProjection.byEntry.get(entry)} sessionId={sessionId} /> : null}{toolsForEntry.map((tool) => <ToolCard key={tool.id} tool={tool} sessionId={sessionId} />)}</div>; } return toolsForEntry.length ? <div className="assistant-turn" key={key}>{toolsForEntry.map((tool) => <ToolCard key={tool.id} tool={tool} sessionId={sessionId} />)}</div> : null; }) : <div className="conversation-empty"><BrandMark className="conversation-empty-mark" /><h1>{t('conversation.startTitle')}</h1><p>{t('conversation.startDescription')}</p></div>}{compacting ? <div className="compaction-status" role="status"><i className="streaming-beacon" />{t('conversation.compacting')}</div> : null}{data?.live.optimisticPrompt ? <UserMessage message={{ role: 'user', content: data.live.optimisticPrompt.message, attachmentIds: data.live.optimisticPrompt.attachmentIds }} sessionId={sessionId} attachments={attachments} projection={optimisticCitationProjection} /> : null}{showLiveAssistant ? <AssistantMessage streaming showThinking={showThinking} expandThinking={expandThinking} thinkingStartedAt={data?.live.thinkingStartedAt} thinkingDurationMs={data?.live.thinkingDurationMs} sessionId={sessionId} message={{ role: 'assistant', content: [{ type: 'thinking', thinking: data?.live.streamingThinking }, { type: 'text', text: data?.live.streamingText }] as MessageContentBlock[] }} /> : null}{toolProjection.liveOnly.map((tool) => <ToolCard key={tool.id} tool={tool} sessionId={sessionId} />)}</div></div><ConversationComposer sessionId={sessionId} session={session} streaming={!!data?.live.active} compacting={compacting} queued={data?.live.queued || []} attachments={attachments} onCitationEnvelope={setCitationEnvelope} onOpenCitationManager={() => setCitationManagerOpen(true)} />{citationManagerOpen ? <CitationManager sessionId={sessionId} onClose={() => setCitationManagerOpen(false)} /> : null}</main>;
}
