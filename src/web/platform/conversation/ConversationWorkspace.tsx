import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { AppMessage, MessageContentBlock, SessionAttachment } from '../../../public/app-types.js';
import { messageText, messageThinking, messageThinkingDurationMs } from '../../../public/kernel/stores/conversation-store.js';
import type { CitationEnvelope } from '../../../contracts/citation.ts';
import { appKernel } from '../../app/composition-root';
import { useConversationState, useSessionState, useToolExecutionState } from '../../app/store-hooks';
import { BrandMark } from '../../components/BrandMark';
import { Icon } from '../../components/icons';
import { projectTaskState } from '../../features/task/task-projection';
import { FilePreview, filePresentation } from '../workspace/FilePreview';
import i18n from '../../i18n';
import { AttachmentCards } from './conversation-attachments';
import { copyText } from './conversation-clipboard';
import { ConversationComposer } from './conversation-composer';
import { durationSeconds, useElapsedMilliseconds } from './conversation-duration';
import { CitationManager } from './citation-manager';
import { artifactPreviewKind, citationLocatorPosition, citationResourceUrl } from './citation-resource';
import { renderConversationMarkdown } from './conversation-markdown';
import { ToolCard } from './tool-card';
import { projectTools } from './tool-projection';
import {
  citationCopyText,
  citationDisplayText,
  projectCitationText,
  projectMessageCitations,
  type MessageCitationProjection,
  type ResolvedCitation,
} from '../../features/citation/citation-projection';

function focusCitationCard(event: MouseEvent<HTMLElement>) {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-citation-id]');
  const id = button?.dataset.citationId;
  if (!id) return;
  const card = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-citation-card]')].find((candidate) => candidate.dataset.citationCard === id);
  card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  card?.focus({ preventScroll: true });
}

const UserMessage = memo(function UserMessage({ message, sessionId, attachments, projection }: { message: AppMessage; sessionId: string; attachments: Record<string, SessionAttachment>; projection?: MessageCitationProjection }) {
  const { t } = useTranslation();
  const text = messageText(message);
  const [copied, setCopied] = useState(false);
  return <div className="user-message-group"><AttachmentCards sessionId={sessionId} attachmentIds={message.attachmentIds} attachments={attachments} /><article className="conversation-message user-message" onClick={focusCitationCard}><div className="message-content"><div dangerouslySetInnerHTML={renderConversationMarkdown(text, projection?.numbers)} /><CitationFooter projection={projection} sessionId={sessionId} /></div><button className="message-copy" type="button" aria-label={t('conversation.copyMessage')} onClick={() => void copyText(citationCopyText(text, projection)).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>{copied ? t('common.copied') : t('common.copy')}</button></article></div>;
});

function ThinkingStatus({ active, startedAt, durationMs }: { active: boolean; startedAt: number | null; durationMs: number | null }) {
  const { t } = useTranslation();
  const elapsedMs = useElapsedMilliseconds(active ? startedAt : null, durationMs);
  const duration = elapsedMs === null ? '' : t('conversation.thinkingDuration', { count: durationSeconds(elapsedMs) });
  return <span>{active
    ? duration ? t('conversation.thinkingActiveWithDuration', { duration }) : t('conversation.thinkingActive')
    : duration ? t('conversation.thinkingCompleteWithDuration', { duration }) : t('conversation.thinking')}</span>;
}

function Thinking({ text, visible, active, startedAt = null, durationMs = null, defaultExpanded }: { text: string; visible: boolean; active: boolean; startedAt?: number | null; durationMs?: number | null; defaultExpanded: boolean }) {
  const [open, setOpen] = useState(defaultExpanded);
  useEffect(() => setOpen(defaultExpanded), [defaultExpanded]);
  if (!visible || (!text && !active)) return null;
  return <section className={`thinking-block${active ? ' is-active' : ''}`}><button type="button" className="thinking-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}><Icon name="chevron" /><ThinkingStatus active={active} startedAt={startedAt} durationMs={durationMs} /></button>{open && text ? <pre>{text}</pre> : null}</section>;
}

function citationPosition(item: ResolvedCitation) { return citationLocatorPosition(item.locator); }

const CITATION_CATEGORY_LABELS: Record<string, string> = {
  LEGAL_GOVERNANCE: 'conversation.category.legal',
  STANDARD_SPEC: 'conversation.category.standard',
  PLAN_PROCEDURE: 'conversation.category.plan',
  CASE_PRACTICE: 'conversation.category.case',
  METHOD_RESEARCH: 'conversation.category.research',
  PROJECT_DATA: 'conversation.category.project',
};

function citationCategory(item: ResolvedCitation) {
  if (item.resource.scope === 'artifact') return i18n.t('conversation.category.artifact');
  return i18n.t(CITATION_CATEGORY_LABELS[item.work.type] || 'conversation.category.reference');
}

type CitationPeek = { item: ResolvedCitation; anchor: DOMRect };

function CitationEvidencePeek({ peek, sessionId }: { peek: CitationPeek; sessionId: string }) {
  const { t } = useTranslation();
  const { item, anchor } = peek;
  const width = Math.min(720, window.innerWidth - 24);
  const height = item.resource.kind === 'pdf' || item.resource.kind === 'image' ? Math.min(680, window.innerHeight - 24) : 260;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, anchor.left + Math.min(22, anchor.width / 4)));
  const top = anchor.top > height + 24 ? anchor.top - height - 10 : Math.min(window.innerHeight - height - 12, anchor.bottom + 10);
  const visualUrl = item.resource.kind === 'pdf' && item.locator.page
    ? `${citationResourceUrl(sessionId, item.resource.resourceId, 'preview')}?page=${item.locator.page}`
    : item.resource.kind === 'image'
      ? citationResourceUrl(sessionId, item.resource.resourceId, 'preview')
      : '';
  return createPortal(
    <aside className="citation-evidence-peek" role="tooltip" style={{ width, height, left, top }}>
      <header><strong>{item.work.title}</strong><span>{citationPosition(item)}</span></header>
      {visualUrl
        ? <img src={visualUrl} alt={`${item.work.title}，${citationPosition(item)}`} />
        : <div className="citation-evidence-text"><span>{t('conversation.originalLocation')}</span><p>{item.locator.quote || t('conversation.noQuote')}</p></div>}
    </aside>,
    document.body,
  );
}

function MessageArtifacts({ projection, sessionId }: { projection?: MessageCitationProjection; sessionId: string }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<ResolvedCitation | null>(null);
  if (!projection?.artifacts.length) return null;
  return <section className="message-artifacts">
    <header><strong>{t('conversation.artifacts')}</strong><span>{t('common.itemCount', { count: projection.artifacts.length })}</span></header>
    <div>{projection.artifacts.map((item) => {
      const name = item.resource.relativePath.replaceAll('\\', '/').split('/').pop() || item.work.title;
      const presentation = filePresentation({ name, path: item.resource.relativePath, isDirectory: false });
      return <button key={item.occurrence.occurrenceId} type="button" onClick={() => setPreview(item)}>
        <span className="message-artifact-icon"><Icon name={presentation.icon} /></span>
        <span><strong>{item.work.title}</strong><small>{presentation.label}</small></span>
        <Icon name="chevron" />
      </button>;
    })}</div>
    {preview ? <FilePreview
      item={{ name: preview.work.title, path: preview.resource.relativePath, isDirectory: false }}
      sessionId={sessionId}
      stackIndex={0}
      initialOffset={0}
      citationProjection={projection}
      onActivate={() => {}}
      onClose={() => setPreview(null)}
    /> : null}
  </section>;
}

function CitationFooter({ projection, sessionId }: { projection?: MessageCitationProjection; sessionId: string }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<ResolvedCitation | null>(null);
  const [peek, setPeek] = useState<CitationPeek | null>(null);
  if (!projection || (!projection.citations.length && !projection.unavailableIds.length)) return null;
  const groups = [...projection.citations.reduce((map, item) => {
    map.set(item.resource.resourceId, [...(map.get(item.resource.resourceId) || []), item]);
    return map;
  }, new Map<string, ResolvedCitation[]>()).values()];
  return <section className="citation-footer"><header><strong>{t('conversation.citations')}</strong><span>{t('common.referenceCount', { count: projection.citations.length })}</span></header><ol>{groups.map((items) => {
    const first = items[0];
    return <li key={first.resource.resourceId}>
      <header className="citation-source-heading">
        <div><strong>{citationCategory(first)}</strong><button type="button" onClick={() => setPreview(first)} title={t('conversation.viewSource')}><Icon name="file" />{first.work.title}</button></div>
        <span>{t('common.referenceCount', { count: items.length })}</span>
      </header>
      <div className="citation-locator-list">{items.map((item) => <button
        className="citation-locator"
        type="button"
        key={item.occurrence.occurrenceId}
        data-citation-card={item.occurrence.occurrenceId}
        onMouseEnter={(event) => setPeek({ item, anchor: event.currentTarget.getBoundingClientRect() })}
        onMouseLeave={() => setPeek(null)}
        onFocus={(event) => setPeek({ item, anchor: event.currentTarget.getBoundingClientRect() })}
        onBlur={() => setPeek(null)}
      >
        <span className="citation-number">{item.number}</span>
        <span className="citation-locator-copy"><strong>{citationPosition(item)}</strong>{item.locator.quote ? <span>{item.locator.quote}</span> : null}</span>
        <span className="citation-locator-hint">{t('conversation.hover')}</span>
      </button>)}</div>
    </li>;
  })}</ol>
    {projection.unavailableIds.length ? <p className="citation-warning">{t('conversation.unavailable', { ids: projection.unavailableIds.join(', ') })}</p> : null}
    {peek ? <CitationEvidencePeek peek={peek} sessionId={sessionId} /> : null}
    {preview ? <FilePreview
      item={{ name: preview.work.title, path: preview.resource.relativePath, isDirectory: false }}
      sessionId={sessionId}
      stackIndex={0}
      initialOffset={0}
      externalSource={{
        url: citationResourceUrl(sessionId, preview.resource.resourceId),
        kind: artifactPreviewKind(preview.resource),
        mimeType: preview.resource.mimeType,
        page: preview.locator.page,
      }}
      onActivate={() => {}}
      onClose={() => setPreview(null)}
    /> : null}
  </section>;
}

const AssistantMessage = memo(function AssistantMessage({ message, streaming, showThinking, expandThinking, thinkingStartedAt, thinkingDurationMs, projection, sessionId }: { message: AppMessage; streaming?: boolean; showThinking: boolean; expandThinking: boolean; thinkingStartedAt?: number | null; thinkingDurationMs?: number | null; projection?: MessageCitationProjection; sessionId: string }) {
  const { t } = useTranslation();
  const text = messageText(message);
  const displayText = streaming ? text : citationDisplayText(text, projection);
  const thinking = messageThinking(message);
  const [copied, setCopied] = useState(false);
  const messageCopyText = citationCopyText(text, projection);
  const resolvedThinkingDuration = thinkingDurationMs ?? messageThinkingDurationMs(message);
  return <article className={`conversation-message assistant-message${streaming ? ' is-streaming' : ''}`} onClick={focusCitationCard}><div className="message-content"><Thinking text={thinking} visible={showThinking} active={!!streaming && !text} startedAt={thinkingStartedAt} durationMs={resolvedThinkingDuration} defaultExpanded={expandThinking} />{text ? streaming ? <div className="streaming-text">{displayText}</div> : <div dangerouslySetInnerHTML={renderConversationMarkdown(displayText, projection?.numbers)} /> : streaming ? <span className="streaming-cursor" aria-label={t('conversation.generating')} /> : null}{streaming ? null : <MessageArtifacts projection={projection} sessionId={sessionId} />}<CitationFooter projection={streaming ? undefined : projection} sessionId={sessionId} /></div>{!streaming && text ? <button className="message-copy" type="button" aria-label={t('conversation.copyMessage')} onClick={() => void copyText(messageCopyText).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>{copied ? t('common.copied') : t('common.copy')}</button> : null}</article>;
});

export function ConversationWorkspace({ sessionId, showThinking, expandThinking }: { sessionId: string; showThinking: boolean; expandThinking: boolean }) {
  const { t } = useTranslation();
  const kernel = appKernel;
  const conversation = useConversationState();
  const sessions = useSessionState();
  const tools = useToolExecutionState();
  const viewportRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const data = conversation.bySession[sessionId];
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
  }, [kernel, sessionId]);
  const entries = data?.snapshotEntries || [];
  const liveTools = tools.bySession[sessionId];
  const session = sessions.sessions.find((item) => item.id === sessionId);
  const compacting = !!sessions.compactingBySession[sessionId];
  const taskState = useMemo(() => projectTaskState(entries, Object.values(liveTools || {})), [entries, liveTools]);
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
  return <main className="conversation-workspace"><div className="conversation-scroll" ref={viewportRef} onScroll={(event) => { const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}><div className="conversation-thread">{entries.length ? entries.map((entry, index) => { const message = entry.message; if (!message) return null; const key = entry.id || index; const toolsForEntry = toolProjection.byEntry.get(entry) || []; if (message.role === 'user') return <UserMessage key={key} message={message} sessionId={sessionId} attachments={attachments} projection={citationProjection.byEntry.get(entry)} />; if (message.role === 'assistant') { const showMessage = !!messageText(message) || (showThinking && !!messageThinking(message)); return <div className="assistant-turn" key={key}>{showMessage ? <AssistantMessage message={message} showThinking={showThinking} expandThinking={expandThinking} projection={citationProjection.byEntry.get(entry)} sessionId={sessionId} /> : null}{toolsForEntry.map((tool) => <ToolCard key={tool.id} tool={tool} sessionId={sessionId} />)}</div>; } return toolsForEntry.length ? <div className="assistant-turn" key={key}>{toolsForEntry.map((tool) => <ToolCard key={tool.id} tool={tool} sessionId={sessionId} />)}</div> : null; }) : <div className="conversation-empty"><BrandMark className="conversation-empty-mark" /><h1>{t('conversation.startTitle')}</h1><p>{t('conversation.startDescription')}</p></div>}{compacting ? <div className="compaction-status" role="status"><i className="streaming-beacon" />{t('conversation.compacting')}</div> : null}{data?.live.optimisticPrompt ? <UserMessage message={{ role: 'user', content: data.live.optimisticPrompt.message, attachmentIds: data.live.optimisticPrompt.attachmentIds }} sessionId={sessionId} attachments={attachments} projection={optimisticCitationProjection} /> : null}{showLiveAssistant ? <AssistantMessage streaming showThinking={showThinking} expandThinking={expandThinking} thinkingStartedAt={data?.live.thinkingStartedAt} thinkingDurationMs={data?.live.thinkingDurationMs} sessionId={sessionId} message={{ role: 'assistant', content: [{ type: 'thinking', thinking: data?.live.streamingThinking }, { type: 'text', text: data?.live.streamingText }] as MessageContentBlock[] }} /> : null}{toolProjection.liveOnly.map((tool) => <ToolCard key={tool.id} tool={tool} sessionId={sessionId} />)}</div></div><ConversationComposer sessionId={sessionId} session={session} streaming={!!data?.live.active} compacting={compacting} queued={data?.live.queued || []} taskModeEnabled={taskState.enabled} attachments={attachments} onCitationEnvelope={setCitationEnvelope} onOpenCitationManager={() => setCitationManagerOpen(true)} />{citationManagerOpen ? <CitationManager sessionId={sessionId} onClose={() => setCitationManagerOpen(false)} /> : null}</main>;
}
