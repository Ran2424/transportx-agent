import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppMessage, MessageContentBlock } from '../../../public/app-types.js';
import { messageOutcome } from '../../../contracts/run-feedback.ts';
import { messageText, messageThinking, messageThinkingDurationMs } from '../../../public/kernel/stores/conversation-store.js';
import type { CitationEnvelope } from '../../../contracts/citation.ts';
import { appKernel } from '../../app/composition-root';
import { useConversation, useSession, useSessionAttachments, useSessionCompacting, useToolExecutions } from '../../app/store-hooks';
import { BrandMark } from '../../components/BrandMark';
import { ConversationComposer } from './conversation-composer';
import { CitationManager } from './citation-manager';
import { AssistantMessage, UserMessage } from './message-cards';
import { ExecutionGroup } from './execution-group';
import { groupExecutionParts, type ExecutionPart } from './execution-parts';
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
  const [attachmentError, setAttachmentError] = useState('');
  const reloadAttachments = () => {
    setAttachmentError('');
    void kernel.commands.session.listAttachments(sessionId).catch((cause) => setAttachmentError((cause as Error).message || t('conversation.attachmentsUnavailable')));
  };
  useEffect(() => { setCitationEnvelope(null); setRetryDraft(undefined); }, [sessionId]);
  useEffect(reloadAttachments, [kernel, sessionId]);
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
  const parts: ExecutionPart[] = [];
  entries.forEach((entry, index) => {
    const message = entry.message;
    if (!message) return;
    if (message.role === 'user') parts.push({ kind: 'message', entry, index });
    if (message.role === 'assistant') {
      const thinking = messageThinking(message);
      const timing = Array.isArray(message.content) ? message.content.find((block) => block.type === 'thinking') : undefined;
      if (thinking) parts.push({ kind: 'activity', activity: { id: `thinking-${entry.id || index}`, thinking: { text: thinking, active: false, startedAt: timing?.startedAt ?? null, durationMs: messageThinkingDurationMs(message) } } });
      const projection = citationProjection.byEntry.get(entry);
      if (messageOutcome(message) || messageText(message) || projection?.artifacts.length || projection?.citations.length) parts.push({ kind: 'message', entry, index });
    }
    for (const tool of toolProjection.byEntry.get(entry) || []) parts.push({ kind: 'activity', activity: { id: `tool-${tool.id}`, tool } });
  });
  if (data?.live.optimisticPrompt) parts.push({ kind: 'message', index: entries.length, entry: { type: 'message', message: { role: 'user', content: data.live.optimisticPrompt.message, attachmentIds: data.live.optimisticPrompt.attachmentIds } } });
  if (showLiveAssistant) {
    if (data?.live.streamingThinking || !data?.live.streamingText) parts.push({ kind: 'activity', activity: { id: 'live-thinking', thinking: { text: data?.live.streamingThinking || '', active: !data?.live.streamingText, startedAt: data?.live.thinkingStartedAt ?? null, durationMs: data?.live.thinkingDurationMs ?? null } } });
    if (data?.live.streamingText) parts.push({ kind: 'message', streaming: true, index: entries.length, entry: { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: data.live.streamingText }] as MessageContentBlock[] } } });
  }
  for (const tool of toolProjection.liveOnly) parts.push({ kind: 'activity', activity: { id: `tool-${tool.id}`, tool } });
  const rows = groupExecutionParts(parts);
  return <main className="conversation-workspace">
    <div className="conversation-scroll" ref={viewportRef} onScroll={(event) => { const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}>
      <div className="conversation-thread">
        {rows.map((row) => {
          if (row.kind === 'execution') return <ExecutionGroup key={row.id} activities={row.activities} sessionId={sessionId} running={!!data?.live.active} showThinking={showThinking} expandThinking={expandThinking} />;
          const message = row.entry.message as AppMessage;
          const projection = row.entry === entries[row.index] ? citationProjection.byEntry.get(row.entry) : message.role === 'user' ? optimisticCitationProjection : undefined;
          if (message.role === 'user') return <UserMessage key={row.entry.id || `user-${row.index}`} message={message} sessionId={sessionId} attachments={attachments} projection={projection} />;
          return <AssistantMessage key={row.streaming ? 'live-assistant' : row.entry.id || row.index} message={message} streaming={row.streaming} showThinking={false} expandThinking={expandThinking} projection={projection} sessionId={sessionId} onRetry={!data?.live.active ? () => { const previous = entries.slice(0, row.index).reverse().find((entry) => entry.message?.role === 'user')?.message; if (previous) setRetryDraft({ message: messageText(previous) }); } : undefined} />;
        })}
        {!entries.length && !rows.length ? <div className="conversation-empty"><BrandMark className="conversation-empty-mark" /><h1>{t('conversation.startTitle')}</h1><p>{t('conversation.startDescription')}</p></div> : null}
        {data?.live.retry ? <div className="compaction-status" role="status">{t('conversation.retrying', { attempt: data.live.retry.attempt, max: data.live.retry.maxAttempts, seconds: Math.ceil(data.live.retry.delayMs / 1000) })}</div> : data?.live.outcome ? <div className="compaction-status" role="status">{t(`conversation.${data.live.outcome.status}`)}</div> : data?.live.active && !showLiveAssistant && toolProjection.liveOnly.length === 0 ? <div className="compaction-status" role="status">{t('conversation.waiting')}</div> : null}
        {compacting ? <div className="compaction-status" role="status"><i className="streaming-beacon" />{t('conversation.compacting')}</div> : null}
      </div>
    </div>
    <ConversationComposer retryDraft={retryDraft} sessionId={sessionId} session={session} streaming={!!data?.live.active} compacting={compacting} queued={data?.live.queued || []} attachments={attachments} attachmentError={attachmentError} onReloadAttachments={reloadAttachments} onCitationEnvelope={setCitationEnvelope} onOpenCitationManager={() => setCitationManagerOpen(true)} />
    {citationManagerOpen ? <CitationManager sessionId={sessionId} onClose={() => setCitationManagerOpen(false)} /> : null}
  </main>;
}
