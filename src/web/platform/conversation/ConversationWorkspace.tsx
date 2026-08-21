import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { AppMessage, LiveSession, MessageContentBlock, SessionAttachment, SessionAttachmentSource } from '../../../public/app-types.js';
import { messageText, messageThinking, messageThinkingDurationMs } from '../../../public/kernel/stores/conversation-store.js';
import { formatToolResultText } from '../../../public/tool-result.js';
import { exportCitationBibliography } from '../../../contracts/citation-compiler.ts';
import type { CitationEnvelope, CitationLocator, CitationResource, CitationWork } from '../../../contracts/citation.ts';
import { appKernel } from '../../app/composition-root';
import { useConversationState, useSessionState, useToolExecutionState } from '../../app/store-hooks';
import { BrandMark } from '../../components/BrandMark';
import { Icon, type IconName } from '../../components/icons';
import { projectTaskState } from '../../features/task/task-projection';
import { formatContextWindow } from '../../lib/formatting';
import { FilePreview, filePresentation } from '../workspace/FilePreview';
import i18n from '../../i18n';
import { renderConversationMarkdown } from './conversation-markdown';
import { projectTools, type ToolData } from './tool-projection';
import {
  citationCopyText,
  citationDisplayText,
  projectCitationText,
  projectMessageCitations,
  type MessageCitationProjection,
  type ResolvedCitation,
} from '../../features/citation/citation-projection';

const IMAGE_PATH_RE = /((?:~|\/)[^\n\r"'<>`]*?\.(?:png|jpe?g|gif|webp|svg|ico))(?:[?#][^\s"'<>`]*)?/gi;
function numeric(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function contextUsage(session: LiveSession | undefined) {
  const usage = session?.contextUsage;
  const used = numeric(usage?.tokens);
  const limit = numeric(usage?.contextWindow)
    ?? numeric(typeof session?.model === 'object' ? session.model?.contextWindow ?? session.model?.context : null);
  const reportedPercent = numeric(usage?.percent);
  const percent = reportedPercent ?? (used !== null && limit && limit > 0 ? used / limit * 100 : null);
  return { used, limit, percent };
}

function ContextUsageIndicator({ session }: { session: LiveSession | undefined }) {
  const { t } = useTranslation();
  const usage = contextUsage(session);
  const percent = usage.percent === null ? 0 : usage.percent;
  const ringPercent = Math.min(100, percent);
  const availability = usage.percent === null ? ' is-unavailable' : '';
  const level = percent >= 90 ? ' is-critical' : percent >= 70 ? ' is-warning' : '';
  const detail = usage.used !== null && usage.limit !== null
    ? t('conversation.contextUsage', { used: formatContextWindow(usage.used), limit: formatContextWindow(usage.limit), percent: `${percent.toFixed(1)}%` })
    : t('conversation.contextUsageUnavailable');
  return <span className={`composer-context-usage${availability}${level}`} tabIndex={0} role="img" aria-label={detail}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><circle className="context-usage-track" cx="12" cy="12" r="8" pathLength="100" /><circle className="context-usage-value" cx="12" cy="12" r="8" pathLength="100" strokeDasharray={`${ringPercent} 100`} /></svg>
    <span className="composer-context-usage-hint">{detail}</span>
  </span>;
}

function copy(text: string) {
  if (navigator.clipboard) return navigator.clipboard.writeText(text);
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.cssText = 'position:fixed;left:-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
  return Promise.resolve();
}

function attachmentPreviewUrl(sessionId: string, attachment: SessionAttachment) {
  return `/api/file/preview?${new URLSearchParams({ sessionId, path: attachment.relativePath })}`;
}

function AttachmentCards({ sessionId, attachmentIds, attachments, compact = false }: { sessionId: string; attachmentIds?: string[]; attachments: Record<string, SessionAttachment>; compact?: boolean }) {
  const items = (attachmentIds || []).map((id) => attachments[id]).filter((item): item is SessionAttachment => !!item);
  if (!items.length) return null;
  return <div className={`message-attachments${compact ? ' is-compact' : ''}`}>{items.map((attachment) => {
    const presentation = filePresentation({ name: attachment.name, path: attachment.relativePath, isDirectory: false });
    return <div className="message-attachment-card" key={attachment.id}>
      {attachment.kind === 'image' ? <img src={attachmentPreviewUrl(sessionId, attachment)} alt={attachment.name} /> : <span className="message-attachment-icon"><Icon name={presentation.icon} /></span>}
      <span><strong title={attachment.name}>{attachment.name}</strong><small>{presentation.label} · {formatBytes(attachment.size)}</small></span>
    </div>;
  })}</div>;
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

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
  return <div className="user-message-group"><AttachmentCards sessionId={sessionId} attachmentIds={message.attachmentIds} attachments={attachments} /><article className="conversation-message user-message" onClick={focusCitationCard}><div className="message-content"><div dangerouslySetInnerHTML={renderConversationMarkdown(text, projection?.numbers)} /><CitationFooter projection={projection} sessionId={sessionId} /></div><button className="message-copy" type="button" aria-label={t('conversation.copyMessage')} onClick={() => void copy(citationCopyText(text, projection)).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>{copied ? t('common.copied') : t('common.copy')}</button></article></div>;
});

function useElapsedMilliseconds(startedAt: number | null, durationMs: number | null) {
  const [elapsed, setElapsed] = useState<number | null>(() => durationMs ?? (startedAt === null ? null : Math.max(0, Date.now() - startedAt)));
  useEffect(() => {
    if (durationMs !== null || startedAt === null) {
      setElapsed(durationMs);
      return;
    }
    let frame = 0;
    let displayedTenth = -1;
    const update = () => {
      const next = Math.max(0, Date.now() - startedAt);
      const tenth = Math.floor(next / 100);
      if (tenth !== displayedTenth) {
        displayedTenth = tenth;
        setElapsed(next);
      }
      frame = window.requestAnimationFrame(update);
    };
    update();
    return () => window.cancelAnimationFrame(frame);
  }, [durationMs, startedAt]);
  return durationMs ?? elapsed;
}

function durationSeconds(durationMs: number) {
  return (durationMs / 1_000).toFixed(1);
}

function ThinkingStatus({ active, startedAt, durationMs }: { active: boolean; startedAt: number | null; durationMs: number | null }) {
  const { t } = useTranslation();
  const elapsedMs = useElapsedMilliseconds(active ? startedAt : null, durationMs);
  const duration = elapsedMs === null ? '' : t('conversation.thinkingDuration', { count: durationSeconds(elapsedMs) });
  return <span>{active
    ? duration ? t('conversation.thinkingActiveWithDuration', { duration }) : t('conversation.thinkingActive')
    : duration ? t('conversation.thinkingCompleteWithDuration', { duration }) : t('conversation.thinking')}</span>;
}

function ToolDuration({ startedAt, durationMs }: { startedAt?: number; durationMs?: number }) {
  const { t } = useTranslation();
  const elapsedMs = useElapsedMilliseconds(startedAt ?? null, durationMs ?? null);
  return elapsedMs === null ? null : <span className="tool-duration">{t('conversation.thinkingDuration', { count: durationSeconds(elapsedMs) })}</span>;
}

function Thinking({ text, visible, active, startedAt = null, durationMs = null, defaultExpanded }: { text: string; visible: boolean; active: boolean; startedAt?: number | null; durationMs?: number | null; defaultExpanded: boolean }) {
  const [open, setOpen] = useState(defaultExpanded);
  useEffect(() => setOpen(defaultExpanded), [defaultExpanded]);
  if (!visible || (!text && !active)) return null;
  return <section className={`thinking-block${active ? ' is-active' : ''}`}><button type="button" className="thinking-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}><Icon name="chevron" /><ThinkingStatus active={active} startedAt={startedAt} durationMs={durationMs} /></button>{open && text ? <pre>{text}</pre> : null}</section>;
}

function citationLocatorPosition(locator: CitationLocator) {
  if (locator.page) return i18n.language === 'en-US' ? `PDF page ${locator.page}${locator.printedPage ? ` (printed page ${locator.printedPage})` : ''}` : `PDF 第${locator.page}页${locator.printedPage ? `（正文第${locator.printedPage}页）` : ''}`;
  return locator.section || locator.sourceUnit || locator.nodeId || i18n.t('conversation.sourceLocation');
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

function citationResourceUrl(sessionId: string, resourceId: string, view: 'content' | 'preview' = 'content') {
  return `/api/live-sessions/${encodeURIComponent(sessionId)}/citation-resources/${encodeURIComponent(resourceId)}/${view}`;
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

function artifactPreviewKind(item: ResolvedCitation) {
  if (item.resource.mimeType === 'text/markdown' || /\.mdx?$/i.test(item.resource.relativePath)) return 'report';
  return item.resource.kind === 'pdf' || item.resource.kind === 'image' ? item.resource.kind : 'document';
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
        kind: artifactPreviewKind(preview),
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
  const copyText = citationCopyText(text, projection);
  const resolvedThinkingDuration = thinkingDurationMs ?? messageThinkingDurationMs(message);
  return <article className={`conversation-message assistant-message${streaming ? ' is-streaming' : ''}`} onClick={focusCitationCard}><div className="message-content"><Thinking text={thinking} visible={showThinking} active={!!streaming && !text} startedAt={thinkingStartedAt} durationMs={resolvedThinkingDuration} defaultExpanded={expandThinking} />{text ? streaming ? <div className="streaming-text">{displayText}</div> : <div dangerouslySetInnerHTML={renderConversationMarkdown(displayText, projection?.numbers)} /> : streaming ? <span className="streaming-cursor" aria-label={t('conversation.generating')} /> : null}{streaming ? null : <MessageArtifacts projection={projection} sessionId={sessionId} />}<CitationFooter projection={streaming ? undefined : projection} sessionId={sessionId} /></div>{!streaming && text ? <button className="message-copy" type="button" aria-label={t('conversation.copyMessage')} onClick={() => void copy(copyText).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>{copied ? t('common.copied') : t('common.copy')}</button> : null}</article>;
});

function preview(args: Record<string, unknown>) {
  for (const key of ['path', 'command', 'query', 'url', 'title', 'action']) if (typeof args[key] === 'string') return args[key] as string;
  return Object.values(args).find((value): value is string => typeof value === 'string') || '';
}

const TOOL_LABELS: Record<string, string> = {
  read: 'conversation.tool.read',
  bash: 'conversation.tool.command',
  shell: 'conversation.tool.command',
  command: 'conversation.tool.command',
  exec: 'conversation.tool.command',
  edit: 'conversation.tool.edit',
  write: 'conversation.tool.write',
  create: 'conversation.tool.create',
  apply_patch: 'conversation.tool.patch',
  tau_task: 'conversation.tool.taskStatus',
  tau_ask_user: 'conversation.tool.ask',
  publish_geodata: 'conversation.tool.publish',
  present_visualization: 'conversation.tool.mapDisplay',
  tau_cite: 'conversation.tool.citation',
};

function toolLabel(name: string) {
  const normalized = name.trim().toLowerCase().replaceAll('-', '_');
  if (TOOL_LABELS[normalized]) return i18n.t(TOOL_LABELS[normalized]);
  if (normalized.includes('task')) return i18n.t('conversation.tool.task');
  if (normalized.includes('geo') || normalized.includes('map')) return i18n.t('conversation.tool.map');
  if (normalized.includes('visualization')) return i18n.t('conversation.tool.visualization');
  if (normalized.startsWith('read_') || normalized.includes('fetch')) return i18n.t('conversation.tool.read');
  if (normalized.startsWith('write_') || normalized.startsWith('create_')) return i18n.t('conversation.tool.write');
  if (normalized.startsWith('edit_') || normalized.includes('patch')) return i18n.t('conversation.tool.patch');
  if (normalized.includes('search') || normalized.includes('find') || normalized.includes('query')) return i18n.t('conversation.tool.search');
  if (normalized.includes('ask') || normalized.includes('input')) return i18n.t('conversation.tool.ask');
  if (normalized.includes('browser') || normalized.startsWith('web_')) return i18n.t('conversation.tool.web');
  if (normalized.includes('image')) return i18n.t('conversation.tool.image');
  return i18n.t('conversation.tool.general');
}

function toolIconName(name: string): IconName {
  const normalized = name.trim().toLowerCase().replaceAll('-', '_');
  if (['bash', 'shell', 'command', 'exec'].some((value) => normalized === value || normalized.startsWith(`${value}_`))) return 'command';
  if (normalized.includes('task')) return 'task';
  if (normalized.includes('geo') || normalized.includes('map') || normalized.includes('visualization')) return 'map';
  if (normalized === 'read' || normalized.startsWith('read_')) return 'file';
  if (['write', 'edit', 'create', 'apply_patch'].some((value) => normalized === value || normalized.startsWith(`${value}_`))) return 'write';
  return 'tool';
}

function imagePaths(value: unknown) {
  const text = formatToolResultText(value, i18n.language);
  const paths = new Set<string>();
  for (const match of text.matchAll(IMAGE_PATH_RE)) paths.add(match[1]);
  return [...paths].slice(0, 3);
}

function toolFilePath(args: Record<string, unknown>) {
  for (const key of ['path', 'filePath', 'file_path']) {
    if (typeof args[key] === 'string' && args[key]) return args[key];
  }
  const sourceInfo = args.sourceInfo;
  if (sourceInfo && typeof sourceInfo === 'object' && !Array.isArray(sourceInfo) && typeof (sourceInfo as Record<string, unknown>).path === 'string') return (sourceInfo as Record<string, unknown>).path as string;
  return '';
}

function toolFileName(path: string) {
  return path.replaceAll('\\', '/').split('/').pop() || path;
}

function ToolFilePreview({ sessionId, path }: { sessionId: string; path: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const item = { name: toolFileName(path), path, isDirectory: false };
  const presentation = filePresentation(item);
  const previewUrl = `/api/file/preview?${new URLSearchParams({ sessionId, path })}`;
  return <div className={`tool-read-preview is-${presentation.kind}`}>
    {presentation.preview === 'image' ? <button className="tool-read-image-button" type="button" onClick={() => setOpen(true)} title={t('conversation.tool.preview', { name: item.name })}><img src={previewUrl} alt={t('conversation.tool.imageAlt', { name: item.name })} /></button> : null}
    {presentation.preview && presentation.preview !== 'image' ? <button className="tool-read-open" type="button" onClick={() => setOpen(true)}><Icon name={presentation.icon} /><span>{t('conversation.tool.previewRead', { type: presentation.label, name: item.name })}</span></button> : presentation.preview ? null : <span className="tool-read-unavailable"><Icon name={presentation.icon} />{t('conversation.tool.previewUnsupported', { name: item.name })}</span>}
    {open ? <FilePreview item={item} sessionId={sessionId} stackIndex={0} initialOffset={0} onActivate={() => {}} onClose={() => setOpen(false)} /> : null}
  </div>;
}

const TOOL_TEXT_PREVIEW_LIMIT = 4_000;
const TOOL_OUTPUT_PREVIEW_LIMIT = 12_000;

function truncateToolText(value: string, limit: number) {
  if (value.length <= limit) return value;
  const tailLength = Math.min(600, Math.floor(limit / 4));
  return `${value.slice(0, limit - tailLength)}\n\n…\n\n${value.slice(-tailLength)}\n\n${i18n.t('conversation.tool.truncated', { count: value.length.toLocaleString() })}`;
}

function compactToolArgs(args: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === 'string' ? truncateToolText(value, TOOL_TEXT_PREVIEW_LIMIT) : value]));
}

function compactCharacterCount(count: number) {
  return count < 1_000 ? String(count) : `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
}

const ToolCard = memo(function ToolCard({ tool, sessionId }: { tool: ToolData; sessionId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(tool.status === 'running');
  useEffect(() => {
    setOpen(tool.status === 'running');
  }, [tool.status]);
  const output = tool.result === undefined ? '' : formatToolResultText(tool.result, i18n.language);
  const isEdit = tool.name.toLowerCase() === 'edit' && (typeof tool.args.oldText === 'string' || typeof tool.args.old_text === 'string');
  const oldText = truncateToolText(String(tool.args.oldText ?? tool.args.old_text ?? ''), TOOL_TEXT_PREVIEW_LIMIT);
  const newText = truncateToolText(String(tool.args.newText ?? tool.args.new_text ?? ''), TOOL_TEXT_PREVIEW_LIMIT);
  const displayedArgs = compactToolArgs(tool.args);
  const displayedOutput = truncateToolText(output, TOOL_OUTPUT_PREVIEW_LIMIT);
  const normalizedToolName = tool.name.toLowerCase().replaceAll('-', '_');
  const readPath = normalizedToolName === 'read' || normalizedToolName.startsWith('read_') ? toolFilePath(tool.args) : '';
  const status = tool.status === 'preparing' ? t('conversation.tool.preparing') : tool.status === 'running' ? t('conversation.tool.running') : tool.status === 'error' || tool.isError ? t('conversation.tool.failed') : t('conversation.tool.completed');
  const iconName = toolIconName(tool.name);
  return <section className={`tool-card${open ? ' is-open' : ''}`}><header><button type="button" className="tool-card-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}><Icon className="tool-chevron" name="chevron" /><strong>{toolLabel(tool.name)}</strong>{preview(tool.args) ? <small title={preview(tool.args)}>{preview(tool.args)}</small> : null}{tool.status === 'preparing' && tool.argumentChars ? <span className="tool-argument-size">{t('conversation.tool.argumentChars', { count: compactCharacterCount(tool.argumentChars) })}</span> : null}{tool.startedAt !== undefined || tool.durationMs !== undefined ? <ToolDuration startedAt={tool.status === 'running' ? tool.startedAt : undefined} durationMs={tool.durationMs} /> : null}</button><span className={`tool-status ${tool.status}`} data-tool-kind={iconName} title={status}><Icon name={iconName} /><span className="sr-only">{status}</span></span></header>{open ? <div className="tool-card-body">{isEdit ? <div className="tool-diff"><pre className="diff-removed">{oldText}</pre><pre className="diff-added">{newText}</pre></div> : Object.keys(tool.args).length ? <pre className="tool-args">{JSON.stringify(displayedArgs, null, 2)}</pre> : null}{output ? <><div className="tool-output-actions"><span>{t('conversation.tool.output')}</span><button type="button" onClick={() => void copy(output)}>{t('common.copy')}</button></div><pre className="tool-output">{displayedOutput}</pre>{imagePaths(tool.result).map((path) => <a className="tool-image-preview" key={path} href={`/api/file/preview?${new URLSearchParams({ sessionId, path })}`} target="_blank" rel="noopener"><img loading="lazy" src={`/api/file/preview?${new URLSearchParams({ sessionId, path })}`} alt={t('conversation.tool.imagePreview', { name: path.split('/').pop() })} /></a>)}{readPath ? <ToolFilePreview sessionId={sessionId} path={readPath} /> : null}</> : readPath ? <ToolFilePreview sessionId={sessionId} path={readPath} /> : tool.status === 'running' ? <span className="tool-pending">{t('conversation.tool.waiting')}</span> : null}</div> : null}</section>;
});

type PendingAttachment = { localId: string; file: File; attachment?: SessionAttachment; status: 'uploading' | 'ready' | 'error'; error?: string };
type CiteCandidate = { locatorId: string; title: string; position: string; quote?: string };

function downloadCitationExport(envelope: CitationEnvelope, format: 'bibtex' | 'csl-json' | 'ris') {
  const extensions = { bibtex: 'bib', 'csl-json': 'json', ris: 'ris' } as const;
  const mimeTypes = { bibtex: 'application/x-bibtex', 'csl-json': 'application/json', ris: 'application/x-research-info-systems' } as const;
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([exportCitationBibliography(envelope, format)], { type: mimeTypes[format] }));
  anchor.download = `citations.${extensions[format]}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
}

function CitationManager({ sessionId, onClose }: { sessionId: string; onClose(): void }) {
  const { t } = useTranslation();
  const kernel = appKernel;
  const [envelope, setEnvelope] = useState<CitationEnvelope | null>(null);
  const [scope, setScope] = useState<'all' | CitationResource['scope']>('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ResolvedCitation | null>(null);
  const [selectedLocators, setSelectedLocators] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    void kernel.commands.citation.list(sessionId).then((citations) => {
      if (active) setEnvelope(citations);
    }).catch((cause) => { if (active) setError((cause as Error).message || t('conversation.citationUnavailable')); });
    return () => { active = false; };
  }, [kernel, sessionId, t]);
  const rows = useMemo(() => {
    if (!envelope) return [];
    const works = new Map(envelope.works.map((work) => [work.workId, work]));
    const locators = new Map<string, CitationLocator[]>();
    for (const locator of envelope.locators) locators.set(locator.resourceId, [...(locators.get(locator.resourceId) || []), locator]);
    const uses = new Map<string, number>();
    for (const occurrence of envelope.occurrences) {
      const locator = envelope.locators.find((item) => item.locatorId === occurrence.locatorId);
      if (locator) uses.set(locator.resourceId, (uses.get(locator.resourceId) || 0) + 1);
    }
    const normalized = query.trim().toLowerCase();
    return envelope.resources.flatMap((resource) => {
      const work = works.get(resource.workId);
      if (!work || (scope !== 'all' && resource.scope !== scope) || (normalized && !`${work.title} ${work.citekey || ''} ${resource.scope}`.toLowerCase().includes(normalized))) return [];
      return [{ resource, work, locators: locators.get(resource.resourceId) || [], uses: uses.get(resource.resourceId) || 0 }];
    });
  }, [envelope, query, scope]);
  const previewCitation = (resource: CitationResource, work: CitationWork, locator?: CitationLocator) => {
    if (!locator) return;
    setPreview({ occurrence: { occurrenceId: `manager:${locator.locatorId}`, locatorId: locator.locatorId, containerType: 'document', containerId: 'citation-manager' }, resource, work, locator, number: 0 });
  };
  return createPortal(<div className="citation-manager-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="citation-manager" role="dialog" aria-modal="true" aria-label={t('conversation.citationManager')} onMouseDown={(event) => event.stopPropagation()}>
      <header><div><strong>{t('conversation.citationManager')}</strong><span>{envelope ? t('common.resourceCount', { resources: envelope.resources.length, uses: envelope.occurrences.length }) : t('conversation.loadingEvidenceGraph')}</span></div><button type="button" aria-label={t('conversation.closeCitationManager')} onClick={onClose}><Icon name="close" /></button></header>
      <div className="citation-manager-toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('conversation.filterCitation')} aria-label={t('conversation.filterCitationLabel')} /><select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)} aria-label={t('conversation.citationScope')}><option value="all">{t('conversation.scope.all')}</option><option value="knowledge">{t('conversation.scope.knowledge')}</option><option value="attachment">{t('conversation.scope.attachment')}</option><option value="artifact">{t('conversation.scope.artifact')}</option><option value="web">{t('conversation.scope.web')}</option><option value="dataset">{t('conversation.scope.dataset')}</option></select><div>{(['bibtex', 'csl-json', 'ris'] as const).map((format) => <button key={format} type="button" disabled={!envelope} onClick={() => envelope && downloadCitationExport(envelope, format)}>{format === 'csl-json' ? 'CSL-JSON' : format.toUpperCase()}</button>)}</div></div>
      <div className="citation-manager-body">{error ? <p className="citation-manager-status is-error">{error}</p> : !envelope ? <p className="citation-manager-status">{t('conversation.loadingEvidence')}</p> : rows.length ? rows.map(({ resource, work, locators, uses }) => {
        const locator = locators.find((item) => item.locatorId === selectedLocators[resource.resourceId]) || locators[0];
        return <article key={resource.resourceId}><div><span className="citation-manager-scope">{resource.scope}</span><strong>{work.title}</strong><small>{work.citekey || resource.resourceId} · {t('common.locationCount', { uses, locations: locators.length })}</small></div><div className="citation-manager-locator"><select value={locator?.locatorId || ''} disabled={!locators.length} aria-label={t('conversation.sourceLocation')} onChange={(event) => setSelectedLocators((current) => ({ ...current, [resource.resourceId]: event.target.value }))}>{locators.map((item) => <option key={item.locatorId} value={item.locatorId}>{citationLocatorPosition(item)}</option>)}</select><button type="button" disabled={!locator} onClick={() => previewCitation(resource, work, locator)}>{t('conversation.viewEvidence')}</button></div>{envelope.provenance.filter((edge) => edge.fromResourceId === resource.resourceId || edge.toResourceId === resource.resourceId).length ? <p>{t('conversation.provenance', { relations: envelope.provenance.filter((edge) => edge.fromResourceId === resource.resourceId || edge.toResourceId === resource.resourceId).map((edge) => edge.relation).join(', ') })}</p> : null}</article>;
      }) : <p className="citation-manager-status">{t('conversation.noCitations')}</p>}</div>
    </section>
    {preview ? <FilePreview item={{ name: preview.work.title, path: preview.resource.relativePath, isDirectory: false }} sessionId={sessionId} stackIndex={0} initialOffset={0} externalSource={{ url: citationResourceUrl(sessionId, preview.resource.resourceId), kind: artifactPreviewKind(preview), mimeType: preview.resource.mimeType, page: preview.locator.page }} onActivate={() => {}} onClose={() => setPreview(null)} /> : null}
  </div>, document.body);
}

function clipboardFileName(index: number) {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `clipboard-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${index + 1}.png`;
}

function Composer({ sessionId, session, streaming, compacting, queued, taskModeEnabled, attachments, onCitationEnvelope, onOpenCitationManager }: { sessionId: string; session: LiveSession | undefined; streaming: boolean; compacting: boolean; queued: Array<{ message: string; attachmentIds?: string[] }>; taskModeEnabled: boolean; attachments: Record<string, SessionAttachment>; onCitationEnvelope(citations: CitationEnvelope): void; onOpenCitationManager(): void; }) {
  const { t } = useTranslation();
  const kernel = appKernel;
  const [value, setValue] = useState('');
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [error, setError] = useState('');
  const [taskModeBusy, setTaskModeBusy] = useState(false);
  const [citeOpen, setCiteOpen] = useState(false);
  const [citeLoading, setCiteLoading] = useState(false);
  const [citeCandidates, setCiteCandidates] = useState<CiteCandidate[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resize = () => { const input = inputRef.current; if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; } };
  useEffect(resize, [value]);
  async function openCitePicker() {
    setCiteOpen(true); setCiteLoading(true); setError('');
    try {
      const citations = await kernel.commands.citation.list(sessionId);
      const works = new Map(citations.works.map((item) => [item.workId, item]));
      const resources = new Map(citations.resources.map((item) => [item.resourceId, item]));
      setCiteCandidates(citations.locators.flatMap((locator) => {
        const resource = resources.get(locator.resourceId);
        const work = resource ? works.get(resource.workId) : null;
        if (!resource || !work) return [];
        const position = locator.page ? (i18n.language === 'en-US' ? `Page ${locator.page}` : `第 ${locator.page} 页`) : locator.clause || locator.section || locator.sourceUnit || locator.nodeId || t('conversation.sourceLocation');
        return [{ locatorId: locator.locatorId, title: work.title, position, quote: locator.quote }];
      }));
    } catch (cause) { setError((cause as Error).message || t('conversation.citationUnavailable')); setCiteCandidates([]); }
    finally { setCiteLoading(false); }
  }
  async function insertCitation(locatorId: string) {
    try {
      const { marker, citations } = await kernel.commands.citation.createOccurrence(sessionId, locatorId, 'support');
      onCitationEnvelope(citations);
      setValue((current) => current.replace('/cite', marker));
      setCiteOpen(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (cause) { setError((cause as Error).message || t('conversation.createCitationFailed')); }
  }
  async function addAttachments(files: FileList | File[], source: SessionAttachmentSource) {
    const unique = Array.from(files).filter((file, index, all) => all.findIndex((candidate) => `${candidate.name}:${candidate.size}:${candidate.lastModified}:${candidate.type}` === `${file.name}:${file.size}:${file.lastModified}:${file.type}`) === index);
    for (const [index, original] of unique.entries()) {
      const file = source === 'clipboard' && (!original.name || original.name === 'image.png' || original.name === 'blob')
        ? new File([original], clipboardFileName(index), { type: original.type || 'image/png' })
        : original;
      const localId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      setPending((current) => [...current, { localId, file, status: 'uploading' }]);
      try {
        const attachment = await kernel.commands.session.uploadAttachment({ sessionId, file, source });
        setPending((current) => current.map((item) => item.localId === localId ? { ...item, attachment, status: 'ready' } : item));
      } catch (cause) {
        setPending((current) => current.map((item) => item.localId === localId ? { ...item, status: 'error', error: (cause as Error).message || t('conversation.uploadFailed') } : item));
      }
    }
    if (unique.length) setError('');
  }
  async function removeAttachment(item: PendingAttachment) {
    setPending((current) => current.filter((candidate) => candidate.localId !== item.localId));
    if (item.attachment) {
      try { await kernel.commands.session.deleteAttachment(sessionId, item.attachment.id); } catch { /* the input item is removed even when cleanup is unavailable */ }
    }
  }
  async function submit(mode: 'prompt' | 'steer' = streaming ? 'steer' : 'prompt') {
    const attachmentIds = pending.filter((item) => item.status === 'ready' && item.attachment).map((item) => item.attachment!.id);
    if (pending.some((item) => item.status === 'uploading')) { setError(t('conversation.uploadingWait')); return; }
    const message = value.trim() || (attachmentIds.length ? t('conversation.attachmentOnly') : '');
    if (!message) return;
    try { if (mode === 'steer') await kernel.commands.agent.steer({ sessionId, message, attachmentIds }); else await kernel.commands.agent.sendPrompt({ sessionId, message, attachmentIds }); setValue(''); setPending([]); } catch (cause) { setError((cause as Error).message || t('conversation.sendFailed')); }
  }
  async function toggleTaskMode() {
    if (streaming || compacting || taskModeBusy) return;
    setTaskModeBusy(true);
    setError('');
    try {
      await kernel.commands.agent.setTaskMode({ sessionId, enabled: !taskModeEnabled });
    } catch (cause) {
      setError((cause as Error).message || t('conversation.toggleTaskFailed'));
    } finally {
      setTaskModeBusy(false);
    }
  }
  return <footer className="conversation-composer">
    <div className="queued-prompts">{queued.map((item, index) => <div key={`${item.message}-${index}`}><span>{t('conversation.queued')}</span><p>{item.message}</p><AttachmentCards sessionId={sessionId} attachmentIds={item.attachmentIds} attachments={attachments} compact /><button type="button" aria-label={t('conversation.cancelQueued')} onClick={() => kernel.dispatch({ type: 'conversation/queueItemRemoved', sessionId, index })}>×</button></div>)}</div>
    {pending.length ? <div className="attachment-list attachment-list--cards">{pending.map((item) => { const attachment = item.attachment; const presentation = attachment ? filePresentation({ name: attachment.name, path: attachment.relativePath, isDirectory: false }) : null; const name = attachment?.name || item.file.name; return <div className={`pending-attachment is-${item.status}`} key={item.localId}>{attachment?.kind === 'image' ? <img src={attachmentPreviewUrl(sessionId, attachment)} alt={attachment.name} /> : <span className="pending-attachment-icon"><Icon name={presentation?.icon || 'file'} /></span>}<span className="pending-attachment-copy"><strong title={name}>{name}</strong><small>{item.status === 'uploading' ? t('conversation.uploading') : item.status === 'error' ? item.error : attachment ? `${presentation?.label} · ${formatBytes(attachment.size)}` : t('conversation.ready')}</small></span><button type="button" aria-label={t('conversation.removeAttachment', { name })} onClick={() => void removeAttachment(item)}>×</button></div>; })}</div> : null}
    <div className="composer-row">
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <textarea
          ref={inputRef}
          value={value}
          onChange={(event) => { const next = event.target.value; setValue(next); if (next.includes('/cite') && !citeOpen) void openCitePicker(); if (!next.includes('/cite')) setCiteOpen(false); }}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            const images = [...event.clipboardData.items].filter((item) => item.type.startsWith('image/')).map((item) => item.getAsFile()).filter((file): file is File => !!file);
            const attachments = files.length ? files : images;
            if (attachments.length) { event.preventDefault(); void addAttachments(attachments, 'clipboard'); }
          }}
          onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void addAttachments(event.dataTransfer.files, 'drop'); } }}
          onDragOver={(event) => event.preventDefault()}
          onKeyDown={(event) => { if (event.key === 'Escape' && citeOpen) { event.preventDefault(); setCiteOpen(false); return; } if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }}
          placeholder={streaming ? t('conversation.steerPlaceholder') : t('conversation.promptPlaceholder')}
          aria-label={t('conversation.messageInput')}
          disabled={compacting}
        />
        {citeOpen ? <section className="composer-cite-picker" role="listbox" aria-label={t('conversation.chooseCitation')}>
          <header><strong>{t('conversation.insertCitation')}</strong><button type="button" onClick={() => setCiteOpen(false)} aria-label={t('conversation.closeCitationPicker')}>×</button></header>
          {citeLoading ? <p>{t('conversation.loadingCitations')}</p> : citeCandidates.length ? <div>{citeCandidates.map((candidate) => <button key={candidate.locatorId} type="button" role="option" onClick={() => void insertCitation(candidate.locatorId)}><strong>{candidate.title}</strong><span>{candidate.position}</span>{candidate.quote ? <small>{candidate.quote}</small> : null}</button>)}</div> : <p>{t('conversation.noInsertableCitation')}</p>}
        </section> : null}
        <div className="composer-toolbar">
          <div className="composer-action-rail">
            <label className="composer-attach">
              <Icon name="plus" />
              <span className="composer-action-hint" aria-hidden="true">{t('conversation.addAttachment')}</span>
              <span className="sr-only">{t('conversation.addAttachment')}</span>
              <input type="file" accept="*/*" multiple onChange={(event) => { if (event.currentTarget.files) void addAttachments(event.currentTarget.files, 'picker'); event.currentTarget.value = ''; }} />
            </label>
            <button className={`composer-task-toggle${taskModeEnabled ? ' is-on' : ''}`} type="button" role="switch" aria-checked={taskModeEnabled} aria-label={taskModeEnabled ? t('task.mode.disable') : t('task.mode.enable')} disabled={streaming || compacting || taskModeBusy} onClick={() => void toggleTaskMode()}>
              <Icon name="task" />
              <span className="composer-action-hint" aria-hidden="true">{taskModeEnabled ? t('task.mode.disable') : t('task.mode.enable')}</span>
            </button>
            <button className="composer-task-toggle" type="button" aria-label={t('conversation.openCitationManager')} onClick={onOpenCitationManager}><Icon name="citation" /><span className="composer-action-hint" aria-hidden="true">{t('conversation.citationManager')}</span></button>
            <ContextUsageIndicator session={session} />
          </div>
          {compacting
            ? <span className="composer-compacting" role="status">{t('conversation.compacting')}</span>
            : streaming
            ? <div className="composer-stream-actions"><button className="composer-send" type="button" aria-label={t('conversation.sendSteer')} onClick={() => void submit('steer')}>{t('conversation.sendSteer')}</button><button className="composer-abort" type="button" aria-label={t('conversation.abort')} onClick={() => void kernel.commands.agent.abort(sessionId)}>{t('conversation.abortShort')}</button></div>
            : <button className="composer-send" type="submit" aria-label={t('conversation.send')} disabled={!value.trim() && pending.length === 0}>↑</button>}
        </div>
      </form>
    </div>
    {error ? <p className="composer-error" role="alert">{error}</p> : null}
  </footer>;
}

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
  return <main className="conversation-workspace"><div className="conversation-scroll" ref={viewportRef} onScroll={(event) => { const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}><div className="conversation-thread">{entries.length ? entries.map((entry, index) => { const message = entry.message; if (!message) return null; const key = entry.id || index; const toolsForEntry = toolProjection.byEntry.get(entry) || []; if (message.role === 'user') return <UserMessage key={key} message={message} sessionId={sessionId} attachments={attachments} projection={citationProjection.byEntry.get(entry)} />; if (message.role === 'assistant') { const showMessage = !!messageText(message) || (showThinking && !!messageThinking(message)); return <div className="assistant-turn" key={key}>{showMessage ? <AssistantMessage message={message} showThinking={showThinking} expandThinking={expandThinking} projection={citationProjection.byEntry.get(entry)} sessionId={sessionId} /> : null}{toolsForEntry.map((tool) => <ToolCard key={tool.id} tool={tool} sessionId={sessionId} />)}</div>; } return toolsForEntry.length ? <div className="assistant-turn" key={key}>{toolsForEntry.map((tool) => <ToolCard key={tool.id} tool={tool} sessionId={sessionId} />)}</div> : null; }) : <div className="conversation-empty"><BrandMark className="conversation-empty-mark" /><h1>{t('conversation.startTitle')}</h1><p>{t('conversation.startDescription')}</p></div>}{compacting ? <div className="compaction-status" role="status"><i className="streaming-beacon" />{t('conversation.compacting')}</div> : null}{data?.live.optimisticPrompt ? <UserMessage message={{ role: 'user', content: data.live.optimisticPrompt.message, attachmentIds: data.live.optimisticPrompt.attachmentIds }} sessionId={sessionId} attachments={attachments} projection={optimisticCitationProjection} /> : null}{showLiveAssistant ? <AssistantMessage streaming showThinking={showThinking} expandThinking={expandThinking} thinkingStartedAt={data?.live.thinkingStartedAt} thinkingDurationMs={data?.live.thinkingDurationMs} sessionId={sessionId} message={{ role: 'assistant', content: [{ type: 'thinking', thinking: data?.live.streamingThinking }, { type: 'text', text: data?.live.streamingText }] as MessageContentBlock[] }} /> : null}{toolProjection.liveOnly.map((tool) => <ToolCard key={tool.id} tool={tool} sessionId={sessionId} />)}</div></div><Composer sessionId={sessionId} session={session} streaming={!!data?.live.active} compacting={compacting} queued={data?.live.queued || []} taskModeEnabled={taskState.enabled} attachments={attachments} onCitationEnvelope={setCitationEnvelope} onOpenCitationManager={() => setCitationManagerOpen(true)} />{citationManagerOpen ? <CitationManager sessionId={sessionId} onClose={() => setCitationManagerOpen(false)} /> : null}</main>;
}
