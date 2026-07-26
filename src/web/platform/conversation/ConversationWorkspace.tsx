import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { AppMessage, MessageContentBlock, PendingImage, SessionEntry } from '../../../public/app-types.js';
import { messageText, messageThinking } from '../../../public/kernel/stores/conversation-store.js';
import { formatToolResultText } from '../../../public/tool-result.js';
import { renderMarkdown, renderUserMarkdown } from '../../../public/markdown.js';
import { useAppServices } from '../../app/AppProviders';
import { useConversationState, useToolExecutionState } from '../../app/store-hooks';
import { Icon, type IconName } from '../../components/icons';
import { projectTaskState } from '../../features/task/task-projection';
import { FilePreview, filePresentation } from '../workspace/FilePreview';
import {
  citationCopyText,
  citationDisplayText,
  projectCitationText,
  projectMessageCitations,
  type MessageCitationProjection,
  type ResolvedCitation,
} from '../../features/citation/citation-projection';

const IMAGE_PATH_RE = /((?:~|\/)[^\n\r"'<>`]*?\.(?:png|jpe?g|gif|webp|svg|ico))(?:[?#][^\s"'<>`]*)?/gi;
const MAX_IMAGE_DIM = 2048;

type ToolData = { id: string; name: string; args: Record<string, unknown>; result?: unknown; isError?: boolean; status: 'running' | 'completed' | 'error' };

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

function html(markdown: string, user = false, citationNumbers: Record<string, number> = {}) {
  const template = document.createElement('template');
  template.innerHTML = user ? renderUserMarkdown(markdown) : renderMarkdown(markdown, citationNumbers);
  const allowed = new Set(['A', 'BLOCKQUOTE', 'BR', 'BUTTON', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'IMG', 'INPUT', 'LI', 'OL', 'P', 'PRE', 'SPAN', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL']);
  template.content.querySelectorAll('*').forEach((node) => {
    if (!allowed.has(node.tagName)) { node.replaceWith(document.createTextNode(node.textContent || '')); return; }
    [...node.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      const safeUrl = name === 'href' ? /^(https?:|mailto:)/i.test(value) : name === 'src' ? /^(https?:|data:image\/)/i.test(value) : true;
      const allowedName = ['aria-label', 'class', 'checked', 'data-citation-id', 'disabled', 'href', 'rel', 'src', 'style', 'target', 'type'].includes(name);
      const validCitationId = name !== 'data-citation-id' || /^[A-Za-z0-9_.:-]{1,180}$/.test(value);
      if (name.startsWith('on') || !allowedName || !safeUrl || !validCitationId) node.removeAttribute(attribute.name);
    });
  });
  return { __html: template.innerHTML };
}

function ImageList({ images }: { images?: PendingImage[] }) {
  if (!images?.length) return null;
  return <div className="message-images">{images.map((image, index) => <img key={`${image.data.slice(0, 16)}-${index}`} src={`data:${image.mimeType};base64,${image.data}`} alt="附加图片" />)}</div>;
}

const UserMessage = memo(function UserMessage({ message }: { message: AppMessage }) {
  const text = messageText(message);
  const [copied, setCopied] = useState(false);
  return <article className="conversation-message user-message"><div className="message-content"><ImageList images={message.images} /><div dangerouslySetInnerHTML={html(text, true)} /></div><button className="message-copy" type="button" aria-label="复制消息" onClick={() => void copy(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>{copied ? '已复制' : '复制'}</button></article>;
});

function Thinking({ text, visible }: { text: string; visible: boolean }) {
  const [open, setOpen] = useState(true);
  if (!text || !visible) return null;
  return <section className="thinking-block"><button type="button" className="thinking-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}><Icon name="chevron" /> 思考过程</button>{open ? <pre>{text}</pre> : null}</section>;
}

function citationPosition(item: ResolvedCitation) {
  const { locator } = item;
  if (locator.page) return `PDF 第${locator.page}页${locator.printedPage ? `（正文第${locator.printedPage}页）` : ''}`;
  return locator.section || locator.sourceUnit || locator.nodeId || '来源位置';
}

const CITATION_CATEGORY_LABELS: Record<string, string> = {
  LEGAL_GOVERNANCE: '法律法规与制度',
  STANDARD_SPEC: '标准规范',
  PLAN_PROCEDURE: '预案与作业规程',
  CASE_PRACTICE: '案例与实践',
  METHOD_RESEARCH: '方法指南与研究',
  PROJECT_DATA: '项目资料',
};

function citationCategory(item: ResolvedCitation) {
  if (item.source.scope === 'session') return '任务产物';
  return CITATION_CATEGORY_LABELS[item.citation.documentClass || ''] || '参考资料';
}

function citationSourceUrl(sessionId: string, sourceId: string, view: 'content' | 'preview' = 'content') {
  return `/api/live-sessions/${encodeURIComponent(sessionId)}/citation-sources/${encodeURIComponent(sourceId)}/${view}`;
}

type CitationPeek = { item: ResolvedCitation; anchor: DOMRect };

function CitationEvidencePeek({ peek, sessionId }: { peek: CitationPeek; sessionId: string }) {
  const { item, anchor } = peek;
  const width = Math.min(720, window.innerWidth - 24);
  const height = item.source.kind === 'pdf' || item.source.kind === 'image' ? Math.min(680, window.innerHeight - 24) : 260;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, anchor.left + Math.min(22, anchor.width / 4)));
  const top = anchor.top > height + 24 ? anchor.top - height - 10 : Math.min(window.innerHeight - height - 12, anchor.bottom + 10);
  const visualUrl = item.source.kind === 'pdf' && item.locator.page
    ? `${citationSourceUrl(sessionId, item.source.sourceId, 'preview')}?page=${item.locator.page}`
    : item.source.kind === 'image'
      ? citationSourceUrl(sessionId, item.source.sourceId, 'preview')
      : '';
  return createPortal(
    <aside className="citation-evidence-peek" role="tooltip" style={{ width, height, left, top }}>
      <header><strong>{item.source.title}</strong><span>{citationPosition(item)}</span></header>
      {visualUrl
        ? <img src={visualUrl} alt={`${item.source.title}，${citationPosition(item)}`} />
        : <div className="citation-evidence-text"><span>原文定位</span><p>{item.locator.quote || '当前来源没有可显示的原文片段。'}</p></div>}
    </aside>,
    document.body,
  );
}

function artifactPreviewKind(item: ResolvedCitation) {
  return item.source.mimeType === 'text/markdown' || /\.mdx?$/i.test(item.source.relativePath) ? 'report' : item.source.kind;
}

function MessageArtifacts({ projection, sessionId }: { projection?: MessageCitationProjection; sessionId: string }) {
  const [preview, setPreview] = useState<ResolvedCitation | null>(null);
  if (!projection?.artifacts.length) return null;
  return <section className="message-artifacts">
    <header><strong>本次产出</strong><span>{projection.artifacts.length} 项</span></header>
    <div>{projection.artifacts.map((item) => {
      const name = item.source.relativePath.replaceAll('\\', '/').split('/').pop() || item.source.title;
      const presentation = filePresentation({ name, path: item.source.relativePath, isDirectory: false });
      return <button key={item.citation.citationId} type="button" onClick={() => setPreview(item)}>
        <span className="message-artifact-icon"><Icon name={presentation.icon} /></span>
        <span><strong>{item.source.title}</strong><small>{presentation.label}</small></span>
        <Icon name="chevron" />
      </button>;
    })}</div>
    {preview ? <FilePreview
      item={{ name: preview.source.title, path: preview.source.relativePath, isDirectory: false }}
      sessionId={sessionId}
      stackIndex={0}
      initialOffset={0}
      citationProjection={projection}
      externalSource={{
        url: citationSourceUrl(sessionId, preview.source.sourceId),
        kind: artifactPreviewKind(preview),
        mimeType: preview.source.mimeType,
        page: preview.locator.page,
      }}
      onActivate={() => {}}
      onClose={() => setPreview(null)}
    /> : null}
  </section>;
}

function CitationFooter({ projection, sessionId }: { projection?: MessageCitationProjection; sessionId: string }) {
  const [preview, setPreview] = useState<ResolvedCitation | null>(null);
  const [peek, setPeek] = useState<CitationPeek | null>(null);
  if (!projection || (!projection.citations.length && !projection.unavailableIds.length)) return null;
  const groups = [...projection.citations.reduce((map, item) => {
    map.set(item.source.sourceId, [...(map.get(item.source.sourceId) || []), item]);
    return map;
  }, new Map<string, ResolvedCitation[]>()).values()];
  return <section className="citation-footer"><header><strong>引用依据</strong><span>{projection.citations.length} 条</span></header><ol>{groups.map((items) => {
    const first = items[0];
    return <li key={first.source.sourceId}>
      <header className="citation-source-heading">
        <div><strong>{citationCategory(first)}</strong><button type="button" onClick={() => setPreview(first)} title="在工作台中查看原始资料"><Icon name="file" />{first.source.title}</button></div>
        <span>{items.length} 条引用</span>
      </header>
      <div className="citation-locator-list">{items.map((item) => <button
        className="citation-locator"
        type="button"
        key={item.citation.citationId}
        data-citation-card={item.citation.citationId}
        onMouseEnter={(event) => setPeek({ item, anchor: event.currentTarget.getBoundingClientRect() })}
        onMouseLeave={() => setPeek(null)}
        onFocus={(event) => setPeek({ item, anchor: event.currentTarget.getBoundingClientRect() })}
        onBlur={() => setPeek(null)}
      >
        <span className="citation-number">{item.number}</span>
        <span className="citation-locator-copy"><strong>{citationPosition(item)}</strong>{item.locator.quote ? <span>{item.locator.quote}</span> : null}</span>
        <span className="citation-locator-hint">悬浮查看</span>
      </button>)}</div>
    </li>;
  })}</ol>
    {projection.unavailableIds.length ? <p className="citation-warning">引用不可用：{projection.unavailableIds.join('、')}</p> : null}
    {peek ? <CitationEvidencePeek peek={peek} sessionId={sessionId} /> : null}
    {preview ? <FilePreview
      item={{ name: preview.source.title, path: preview.source.relativePath, isDirectory: false }}
      sessionId={sessionId}
      stackIndex={0}
      initialOffset={0}
      externalSource={{
        url: citationSourceUrl(sessionId, preview.source.sourceId),
        kind: preview.source.kind,
        mimeType: preview.source.mimeType,
        page: preview.locator.page,
      }}
      onActivate={() => {}}
      onClose={() => setPreview(null)}
    /> : null}
  </section>;
}

const AssistantMessage = memo(function AssistantMessage({ message, streaming, showThinking, projection, sessionId }: { message: AppMessage; streaming?: boolean; showThinking: boolean; projection?: MessageCitationProjection; sessionId: string }) {
  const text = messageText(message);
  const displayText = citationDisplayText(text, projection);
  const thinking = messageThinking(message);
  const [copied, setCopied] = useState(false);
  function citationClick(event: MouseEvent<HTMLElement>) {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-citation-id]');
    const id = button?.dataset.citationId;
    if (!id) return;
    const card = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-citation-card]')].find((candidate) => candidate.dataset.citationCard === id);
    card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    card?.focus({ preventScroll: true });
  }
  const copyText = citationCopyText(text, projection);
  return <article className={`conversation-message assistant-message${streaming ? ' is-streaming' : ''}`} onClick={citationClick}><div className="message-content"><Thinking text={thinking} visible={showThinking} />{text ? <div dangerouslySetInnerHTML={html(displayText, false, projection?.numbers)} /> : streaming ? <span className="streaming-cursor" aria-label="正在生成" /> : null}{streaming ? null : <MessageArtifacts projection={projection} sessionId={sessionId} />}<CitationFooter projection={streaming ? undefined : projection} sessionId={sessionId} /></div>{!streaming && text ? <button className="message-copy" type="button" aria-label="复制消息" onClick={() => void copy(copyText).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>{copied ? '已复制' : '复制'}</button> : null}</article>;
});

function preview(args: Record<string, unknown>) {
  for (const key of ['path', 'command', 'query', 'url', 'title', 'action']) if (typeof args[key] === 'string') return args[key] as string;
  return Object.values(args).find((value): value is string => typeof value === 'string') || '';
}

const TOOL_LABELS: Record<string, string> = {
  read: '文件读取',
  bash: '命令执行',
  shell: '命令执行',
  command: '命令执行',
  exec: '命令执行',
  edit: '文件编辑',
  write: '文件写入',
  create: '文件创建',
  apply_patch: '文件修改',
  tau_task: '任务状态',
  tau_ask_user: '用户询问',
  publish_geodata: '数据发布',
  present_visualization: '地图展示',
  tau_cite: '引用注册',
};

function toolLabel(name: string) {
  const normalized = name.trim().toLowerCase().replaceAll('-', '_');
  if (TOOL_LABELS[normalized]) return TOOL_LABELS[normalized];
  if (normalized.includes('task')) return '任务执行';
  if (normalized.includes('geo') || normalized.includes('map')) return '地图工具';
  if (normalized.includes('visualization')) return '图形展示';
  if (normalized.startsWith('read_') || normalized.includes('fetch')) return '文件读取';
  if (normalized.startsWith('write_') || normalized.startsWith('create_')) return '文件写入';
  if (normalized.startsWith('edit_') || normalized.includes('patch')) return '文件修改';
  if (normalized.includes('search') || normalized.includes('find') || normalized.includes('query')) return '内容搜索';
  if (normalized.includes('ask') || normalized.includes('input')) return '用户询问';
  if (normalized.includes('browser') || normalized.startsWith('web_')) return '网页工具';
  if (normalized.includes('image')) return '图像工具';
  return '通用工具';
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
  const text = formatToolResultText(value);
  const paths = new Set<string>();
  for (const match of text.matchAll(IMAGE_PATH_RE)) paths.add(match[1]);
  return [...paths].slice(0, 3);
}

const ToolCard = memo(function ToolCard({ tool, sessionId }: { tool: ToolData; sessionId: string }) {
  const [open, setOpen] = useState(tool.status === 'running');
  useEffect(() => {
    if (tool.status !== 'running') setOpen(false);
  }, [tool.status]);
  const output = tool.result === undefined ? '' : formatToolResultText(tool.result);
  const isEdit = tool.name.toLowerCase() === 'edit' && (typeof tool.args.oldText === 'string' || typeof tool.args.old_text === 'string');
  const oldText = String(tool.args.oldText ?? tool.args.old_text ?? '');
  const newText = String(tool.args.newText ?? tool.args.new_text ?? '');
  const status = tool.status === 'running' ? '执行中' : tool.status === 'error' || tool.isError ? '出错' : '已完成';
  const iconName = toolIconName(tool.name);
  return <section className={`tool-card${open ? ' is-open' : ''}`}><header><button type="button" className="tool-card-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}><Icon className="tool-chevron" name="chevron" /><strong>{toolLabel(tool.name)}</strong>{preview(tool.args) ? <small title={preview(tool.args)}>{preview(tool.args)}</small> : null}</button><span className={`tool-status ${tool.status}`} data-tool-kind={iconName} title={status}><Icon name={iconName} /><span className="sr-only">{status}</span></span></header>{open ? <div className="tool-card-body">{isEdit ? <div className="tool-diff"><pre className="diff-removed">{oldText}</pre><pre className="diff-added">{newText}</pre></div> : Object.keys(tool.args).length ? <pre className="tool-args">{JSON.stringify(tool.args, null, 2)}</pre> : null}{output ? <><div className="tool-output-actions"><span>输出</span><button type="button" onClick={() => void copy(output)}>复制</button></div><pre className="tool-output">{output}</pre>{imagePaths(tool.result).map((path) => <a className="tool-image-preview" key={path} href={`/api/file/preview?${new URLSearchParams({ sessionId, path })}`} target="_blank" rel="noopener"><img loading="lazy" src={`/api/file/preview?${new URLSearchParams({ sessionId, path })}`} alt={`工具图片预览：${path.split('/').pop()}`} /></a>)}</> : tool.status === 'running' ? <span className="tool-pending">等待工具输出…</span> : null}</div> : null}</section>;
});

function projectTools(entries: SessionEntry[], liveTools: Record<string, { toolCallId: string; toolName?: string; args?: Record<string, unknown>; result?: unknown; partialResult?: unknown; isError?: boolean; status: 'running' | 'completed' | 'error' }>) {
  const results = new Map<string, AppMessage>();
  const resultEntries = new Map<string, SessionEntry>();
  entries.forEach((entry) => {
    if (entry.message?.role !== 'toolResult' || !entry.message.toolCallId) return;
    results.set(entry.message.toolCallId, entry.message);
    resultEntries.set(entry.message.toolCallId, entry);
  });
  const byEntry = new Map<SessionEntry, ToolData[]>();
  const known = new Set<string>();
  entries.forEach((entry) => {
    const message = entry.message;
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return;
    message.content.filter((block) => block.type === 'toolCall' && block.id).forEach((block) => {
      const id = block.id!;
      known.add(id);
      const live = liveTools[id];
      const result = results.get(id);
      const tool = { id, name: live?.toolName || block.name || '', args: live?.args || block.arguments || {}, result: live?.result ?? live?.partialResult ?? (result ? { content: result.content, details: result.details } : undefined), isError: live?.isError ?? result?.isError, status: live?.status || (result?.isError ? 'error' : result ? 'completed' : 'running') } satisfies ToolData;
      byEntry.set(entry, [...(byEntry.get(entry) || []), tool]);
    });
  });
  const liveOnly: ToolData[] = [];
  Object.values(liveTools).filter((tool) => !known.has(tool.toolCallId)).forEach((tool) => {
    const projected = { id: tool.toolCallId, name: tool.toolName || '', args: tool.args || {}, result: tool.result ?? tool.partialResult, isError: tool.isError, status: tool.status } satisfies ToolData;
    const resultEntry = resultEntries.get(tool.toolCallId);
    if (resultEntry) byEntry.set(resultEntry, [projected]);
    else liveOnly.push(projected);
    known.add(tool.toolCallId);
  });
  results.forEach((result, id) => {
    if (known.has(id)) return;
    const resultEntry = resultEntries.get(id);
    if (!resultEntry) return;
    byEntry.set(resultEntry, [{ id, name: result.toolName || '', args: {}, result: { content: result.content, details: result.details }, isError: result.isError, status: result.isError ? 'error' : 'completed' }]);
  });
  return { byEntry, liveOnly };
}

function processImage(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('仅支持图片附件')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => { const image = new Image(); image.onerror = () => reject(new Error('解析图片失败')); image.onload = () => { const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(image.width, image.height)); const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale); canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height); const mimeType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'; const data = canvas.toDataURL(mimeType, mimeType === 'image/jpeg' ? .85 : undefined).split(',')[1]; data ? resolve({ data, mimeType }) : reject(new Error('编码图片失败')); }; image.src = String(reader.result); };
    reader.readAsDataURL(file);
  });
}

function Composer({ sessionId, streaming, queued, taskModeEnabled }: { sessionId: string; streaming: boolean; queued: Array<{ message: string }>; taskModeEnabled: boolean; }) {
  const { kernel } = useAppServices();
  const [value, setValue] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [error, setError] = useState('');
  const [taskModeBusy, setTaskModeBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resize = () => { const input = inputRef.current; if (input) { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; } };
  useEffect(resize, [value]);
  async function add(files: FileList | File[]) { try { const next = await Promise.all(Array.from(files).map(processImage)); setImages((current) => [...current, ...next]); setError(''); } catch (cause) { setError((cause as Error).message); } }
  async function submit(mode: 'prompt' | 'steer' = streaming ? 'steer' : 'prompt') {
    const message = value.trim() || (images.length ? '（见附加图片）' : '');
    if (!message) return;
    try { if (mode === 'steer') await kernel.commands.agent.steer({ sessionId, message }); else await kernel.commands.agent.sendPrompt({ sessionId, message, images }); setValue(''); setImages([]); } catch (cause) { setError((cause as Error).message || '发送失败'); }
  }
  async function toggleTaskMode() {
    if (streaming || taskModeBusy) return;
    setTaskModeBusy(true);
    setError('');
    try {
      await kernel.commands.agent.setTaskMode({ sessionId, enabled: !taskModeEnabled });
    } catch (cause) {
      setError((cause as Error).message || '切换任务模式失败');
    } finally {
      setTaskModeBusy(false);
    }
  }
  return <footer className="conversation-composer"><div className="queued-prompts">{queued.map((item, index) => <div key={`${item.message}-${index}`}><span>排队中</span><p>{item.message}</p><button type="button" aria-label="取消排队消息" onClick={() => kernel.dispatch({ type: 'conversation/queueItemRemoved', sessionId, index })}>×</button></div>)}</div>{images.length ? <div className="attachment-list">{images.map((image, index) => <div key={`${image.data.slice(0, 12)}-${index}`}><img src={`data:${image.mimeType};base64,${image.data}`} alt="待发送图片" /><button type="button" aria-label="移除图片" onClick={() => setImages((current) => current.filter((_, i) => i !== index))}>×</button></div>)}</div> : null}<div className="composer-row"><div className="composer-action-rail"><button className={`composer-task-toggle${taskModeEnabled ? ' is-on' : ''}`} type="button" role="switch" aria-checked={taskModeEnabled} aria-label={taskModeEnabled ? '关闭任务模式' : '开启任务模式'} disabled={streaming || taskModeBusy} onClick={() => void toggleTaskMode()}><Icon name="task" /><span className="composer-action-hint" aria-hidden="true">{taskModeEnabled ? '关闭任务模式' : '开启任务模式'}</span></button><label className="composer-attach"><Icon name="plus" /><span className="composer-action-hint" aria-hidden="true">添加图片附件</span><span className="sr-only">添加图片</span><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={(event) => { if (event.currentTarget.files) void add(event.currentTarget.files); event.currentTarget.value = ''; }} /></label></div><form onSubmit={(event) => { event.preventDefault(); void submit(); }}><textarea ref={inputRef} value={value} onChange={(event) => setValue(event.target.value)} onPaste={(event) => { const files = [...event.clipboardData.items].filter((item) => item.type.startsWith('image/')).map((item) => item.getAsFile()).filter((file): file is File => !!file); if (files.length) { event.preventDefault(); void add(files); } }} onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void add(event.dataTransfer.files); } }} onDragOver={(event) => event.preventDefault()} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }} placeholder={streaming ? '输入内容以引导当前任务…' : '输入交通问题或 Pi 指令…'} aria-label="消息输入" />{streaming ? <div className="composer-stream-actions"><button className="composer-send" type="button" aria-label="发送引导" onClick={() => void submit('steer')}>发送引导</button><button className="composer-abort" type="button" aria-label="终止当前任务" onClick={() => void kernel.commands.agent.abort(sessionId)}>终止</button></div> : <button className="composer-send" type="submit" aria-label="发送消息">↑</button>}</form></div>{error ? <p className="composer-error" role="alert">{error}</p> : null}</footer>;
}

export function ConversationWorkspace({ sessionId, showThinking }: { sessionId: string; showThinking: boolean }) {
  const conversation = useConversationState();
  const tools = useToolExecutionState();
  const viewportRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const data = conversation.bySession[sessionId];
  const entries = data?.snapshotEntries || [];
  const liveTools = tools.bySession[sessionId] || {};
  const taskState = useMemo(() => projectTaskState(entries, Object.values(liveTools)), [entries, liveTools]);
  const toolProjection = useMemo(() => projectTools(entries, liveTools), [entries, liveTools]);
  const citationProjection = useMemo(() => projectMessageCitations(entries), [entries]);
  const liveCitationProjection = useMemo(() => projectCitationText(data?.live.streamingText || '', citationProjection.available), [data?.live.streamingText, citationProjection]);
  useLayoutEffect(() => { const viewport = viewportRef.current; if (viewport && nearBottom.current) viewport.scrollTop = viewport.scrollHeight; }, [entries, data?.live.streamingText, data?.live.streamingThinking, toolProjection]);
  return <main className="conversation-workspace"><div className="conversation-scroll" ref={viewportRef} onScroll={(event) => { const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}><div className="conversation-thread">{entries.length ? entries.map((entry, index) => { const message = entry.message; if (!message) return null; const key = entry.id || index; const toolsForEntry = toolProjection.byEntry.get(entry) || []; if (message.role === 'user') return <UserMessage key={key} message={message} />; if (message.role === 'assistant') { const showMessage = !!messageText(message) || (showThinking && !!messageThinking(message)); return <div className="assistant-turn" key={key}>{showMessage ? <AssistantMessage message={message} showThinking={showThinking} projection={citationProjection.byEntry.get(entry)} sessionId={sessionId} /> : null}{toolsForEntry.map((tool) => <ToolCard key={tool.id} tool={tool} sessionId={sessionId} />)}</div>; } return toolsForEntry.length ? <div className="assistant-turn" key={key}>{toolsForEntry.map((tool) => <ToolCard key={tool.id} tool={tool} sessionId={sessionId} />)}</div> : null; }) : <div className="conversation-empty"><span>τ</span><h1>开始分析交通问题</h1><p>描述路段、时间或出行需求，Agent 会在独立会话中完成分析。</p></div>}{toolProjection.liveOnly.map((tool) => <ToolCard key={tool.id} tool={tool} sessionId={sessionId} />)}{data?.live.optimisticPrompt ? <UserMessage message={{ role: 'user', content: data.live.optimisticPrompt.message, images: data.live.optimisticPrompt.images }} /> : null}{data?.live.active ? <AssistantMessage streaming showThinking={showThinking} projection={liveCitationProjection} sessionId={sessionId} message={{ role: 'assistant', content: [{ type: 'thinking', thinking: data.live.streamingThinking }, { type: 'text', text: data.live.streamingText }] as MessageContentBlock[] }} /> : null}</div></div><Composer sessionId={sessionId} streaming={!!data?.live.active} queued={data?.live.queued || []} taskModeEnabled={taskState.enabled} /></main>;
}
