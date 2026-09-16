import { memo, useEffect, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppMessage, SessionAttachment } from '../../../public/app-types.js';
import { messageText, messageThinking, messageThinkingDurationMs } from '../../../public/kernel/stores/conversation-store.js';
import { Icon } from '../../components/icons';
import { AttachmentCards } from './conversation-attachments';
import { copyText } from './conversation-clipboard';
import { durationSeconds, useElapsedMilliseconds } from './conversation-duration';
import { renderConversationMarkdown } from './conversation-markdown';
import { CitationFooter, MessageArtifacts } from './message-citations';
import { citationCopyText, type MessageCitationProjection } from '../../features/citation/citation-projection';

function focusCitationCard(event: MouseEvent<HTMLElement>) {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-citation-id]');
  const id = button?.dataset.citationId;
  if (!id) return;
  const card = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-citation-card]')].find((candidate) => candidate.dataset.citationCard === id);
  card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  card?.focus({ preventScroll: true });
}

export const UserMessage = memo(function UserMessage({ message, sessionId, attachments, projection }: { message: AppMessage; sessionId: string; attachments: Record<string, SessionAttachment>; projection?: MessageCitationProjection }) {
  const { t } = useTranslation();
  const text = messageText(message);
  const [copied, setCopied] = useState(false);
  return <div className="user-message-group"><AttachmentCards sessionId={sessionId} attachmentIds={message.attachmentIds} attachments={attachments} />{message.geoContextIds?.length ? <div className="message-geo-contexts">{message.geoContextIds.map((id) => <span key={id}>地图上下文 · {id.slice(-8)}</span>)}</div> : null}<article className="conversation-message user-message" onClick={focusCitationCard}><div className="message-content"><div dangerouslySetInnerHTML={renderConversationMarkdown(text, projection?.numbers)} /><CitationFooter projection={projection} sessionId={sessionId} /></div><button className="message-copy" type="button" aria-label={t('conversation.copyMessage')} onClick={() => void copyText(citationCopyText(text, projection)).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>{copied ? t('common.copied') : t('common.copy')}</button></article></div>;
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

export const AssistantMessage = memo(function AssistantMessage({ message, streaming, showThinking, expandThinking, thinkingStartedAt, thinkingDurationMs, projection, sessionId }: { message: AppMessage; streaming?: boolean; showThinking: boolean; expandThinking: boolean; thinkingStartedAt?: number | null; thinkingDurationMs?: number | null; projection?: MessageCitationProjection; sessionId: string }) {
  const { t } = useTranslation();
  const text = messageText(message);
  const displayText = text;
  const thinking = messageThinking(message);
  const [copied, setCopied] = useState(false);
  const messageCopyText = citationCopyText(text, projection);
  const resolvedThinkingDuration = thinkingDurationMs ?? messageThinkingDurationMs(message);
  return <article className={`conversation-message assistant-message${streaming ? ' is-streaming' : ''}`} onClick={focusCitationCard}><div className="message-content"><Thinking text={thinking} visible={showThinking} active={!!streaming && !text} startedAt={thinkingStartedAt} durationMs={resolvedThinkingDuration} defaultExpanded={expandThinking} />{text ? <div dangerouslySetInnerHTML={renderConversationMarkdown(displayText, projection?.numbers)} /> : streaming ? <span className="streaming-cursor" aria-label={t('conversation.generating')} /> : null}{streaming ? null : <MessageArtifacts projection={projection} sessionId={sessionId} />}<CitationFooter projection={streaming ? undefined : projection} sessionId={sessionId} /></div>{!streaming && text ? <button className="message-copy" type="button" aria-label={t('conversation.copyMessage')} onClick={() => void copyText(messageCopyText).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>{copied ? t('common.copied') : t('common.copy')}</button> : null}</article>;
});
