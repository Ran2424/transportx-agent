import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AppMessage, MessageContentBlock, PendingImage, SessionEntry } from '../../../public/app-types.js';
import { messageText, messageThinking } from '../../../public/kernel/stores/conversation-store.js';
import { formatToolResultText } from '../../../public/tool-result.js';
import { renderMarkdown, renderUserMarkdown } from '../../../public/markdown.js';
import { useAppServices } from '../../app/AppProviders';
import { useConversationState, useToolExecutionState } from '../../app/store-hooks';
import { Icon } from '../../components/icons';
import { projectTaskState } from '../../features/task/task-projection';

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

function html(markdown: string, user = false) {
  const template = document.createElement('template');
  template.innerHTML = user ? renderUserMarkdown(markdown) : renderMarkdown(markdown);
  const allowed = new Set(['A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'IMG', 'INPUT', 'LI', 'OL', 'P', 'PRE', 'SPAN', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL']);
  template.content.querySelectorAll('*').forEach((node) => {
    if (!allowed.has(node.tagName)) { node.replaceWith(document.createTextNode(node.textContent || '')); return; }
    [...node.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      const safeUrl = name === 'href' ? /^(https?:|mailto:)/i.test(value) : name === 'src' ? /^(https?:|data:image\/)/i.test(value) : true;
      if (name.startsWith('on') || !['class', 'checked', 'disabled', 'href', 'rel', 'src', 'style', 'target'].includes(name) || !safeUrl) node.removeAttribute(attribute.name);
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

const AssistantMessage = memo(function AssistantMessage({ message, streaming, showThinking }: { message: AppMessage; streaming?: boolean; showThinking: boolean }) {
  const text = messageText(message);
  const thinking = messageThinking(message);
  const [copied, setCopied] = useState(false);
  return <article className={`conversation-message assistant-message${streaming ? ' is-streaming' : ''}`}><div className="message-content"><Thinking text={thinking} visible={showThinking} />{text ? <div dangerouslySetInnerHTML={html(text)} /> : streaming ? <span className="streaming-cursor" aria-label="正在生成" /> : null}</div>{!streaming && text ? <button className="message-copy" type="button" aria-label="复制消息" onClick={() => void copy(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>{copied ? '已复制' : '复制'}</button> : null}</article>;
});

function preview(args: Record<string, unknown>) {
  for (const key of ['path', 'command', 'query', 'url', 'title', 'action']) if (typeof args[key] === 'string') return args[key] as string;
  return Object.values(args).find((value): value is string => typeof value === 'string') || '';
}

function toolLabel(name: string) {
  return ({ read: '读取', bash: '命令', edit: '编辑', write: '创建', tau_task: '任务状态', tau_ask_user: '用户交互' } as Record<string, string>)[name.toLowerCase()] || name;
}

function imagePaths(value: unknown) {
  const text = formatToolResultText(value);
  const paths = new Set<string>();
  for (const match of text.matchAll(IMAGE_PATH_RE)) paths.add(match[1]);
  return [...paths].slice(0, 3);
}

const ToolCard = memo(function ToolCard({ tool, sessionId }: { tool: ToolData; sessionId: string }) {
  const [open, setOpen] = useState(tool.status === 'running');
  const output = tool.result === undefined ? '' : formatToolResultText(tool.result);
  const isEdit = tool.name.toLowerCase() === 'edit' && (typeof tool.args.oldText === 'string' || typeof tool.args.old_text === 'string');
  const oldText = String(tool.args.oldText ?? tool.args.old_text ?? '');
  const newText = String(tool.args.newText ?? tool.args.new_text ?? '');
  const status = tool.status === 'running' ? '执行中' : tool.status === 'error' || tool.isError ? '出错' : '已完成';
  return <section className={`tool-card${open ? ' is-open' : ''}`}><header><button type="button" className="tool-card-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}><Icon name="chevron" /><strong>{toolLabel(tool.name)}</strong>{preview(tool.args) ? <small title={preview(tool.args)}>{preview(tool.args)}</small> : null}</button><span className={`tool-status ${tool.status}`}>{status}</span></header>{open ? <div className="tool-card-body">{isEdit ? <div className="tool-diff"><pre className="diff-removed">{oldText}</pre><pre className="diff-added">{newText}</pre></div> : Object.keys(tool.args).length ? <pre className="tool-args">{JSON.stringify(tool.args, null, 2)}</pre> : null}{output ? <><div className="tool-output-actions"><span>输出</span><button type="button" onClick={() => void copy(output)}>复制</button></div><pre className="tool-output">{output}</pre>{imagePaths(tool.result).map((path) => <a className="tool-image-preview" key={path} href={`/api/file/preview?${new URLSearchParams({ sessionId, path })}`} target="_blank" rel="noopener"><img loading="lazy" src={`/api/file/preview?${new URLSearchParams({ sessionId, path })}`} alt={`工具图片预览：${path.split('/').pop()}`} /></a>)}</> : tool.status === 'running' ? <span className="tool-pending">等待工具输出…</span> : null}</div> : null}</section>;
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
  async function submit(mode: 'prompt' | 'steer' | 'followUp' = streaming ? 'steer' : 'prompt') {
    const message = value.trim() || (images.length ? '（见附加图片）' : '');
    if (!message) return;
    try { if (mode === 'steer') await kernel.commands.agent.steer({ sessionId, message }); else if (mode === 'followUp') await kernel.commands.agent.followUp({ sessionId, message }); else await kernel.commands.agent.sendPrompt({ sessionId, message, images }); setValue(''); setImages([]); } catch (cause) { setError((cause as Error).message || '发送失败'); }
  }
  async function toggleTaskMode() {
    if (streaming || taskModeBusy) return;
    setTaskModeBusy(true);
    setError('');
    try {
      await kernel.commands.agent.sendPrompt({ sessionId, message: `/task ${taskModeEnabled ? 'off' : 'on'}` });
    } catch (cause) {
      setError((cause as Error).message || '切换任务模式失败');
    } finally {
      setTaskModeBusy(false);
    }
  }
  return <footer className="conversation-composer"><div className="queued-prompts">{queued.map((item, index) => <div key={`${item.message}-${index}`}><span>排队中</span><p>{item.message}</p><button type="button" aria-label="取消排队消息" onClick={() => kernel.dispatch({ type: 'conversation/queueItemRemoved', sessionId, index })}>×</button></div>)}</div>{images.length ? <div className="attachment-list">{images.map((image, index) => <div key={`${image.data.slice(0, 12)}-${index}`}><img src={`data:${image.mimeType};base64,${image.data}`} alt="待发送图片" /><button type="button" aria-label="移除图片" onClick={() => setImages((current) => current.filter((_, i) => i !== index))}>×</button></div>)}</div> : null}<div className="composer-row"><div className="composer-action-rail"><button className={`composer-task-toggle${taskModeEnabled ? ' is-on' : ''}`} type="button" role="switch" aria-checked={taskModeEnabled} aria-label={taskModeEnabled ? '关闭任务模式' : '开启任务模式'} disabled={streaming || taskModeBusy} onClick={() => void toggleTaskMode()}><Icon name="task" /><span className="composer-action-hint" aria-hidden="true">{taskModeEnabled ? '关闭任务模式' : '开启任务模式'}</span></button><label className="composer-attach"><Icon name="plus" /><span className="composer-action-hint" aria-hidden="true">添加图片附件</span><span className="sr-only">添加图片</span><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={(event) => { if (event.currentTarget.files) void add(event.currentTarget.files); event.currentTarget.value = ''; }} /></label></div><form onSubmit={(event) => { event.preventDefault(); void submit(); }}><textarea ref={inputRef} value={value} onChange={(event) => setValue(event.target.value)} onPaste={(event) => { const files = [...event.clipboardData.items].filter((item) => item.type.startsWith('image/')).map((item) => item.getAsFile()).filter((file): file is File => !!file); if (files.length) { event.preventDefault(); void add(files); } }} onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void add(event.dataTransfer.files); } }} onDragOver={(event) => event.preventDefault()} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }} placeholder={streaming ? '发送引导，或加入后续问题…' : '输入交通问题或 Pi 指令…'} aria-label="消息输入" />{streaming ? <><button className="composer-secondary" type="button" onClick={() => void submit('followUp')}>后续问题</button><button className="composer-send" type="button" onClick={() => void submit('steer')}>发送引导</button><button className="composer-abort" type="button" onClick={() => void kernel.commands.agent.abort(sessionId)}>中止</button></> : <button className="composer-send" type="submit" aria-label="发送消息">↑</button>}</form></div>{error ? <p className="composer-error" role="alert">{error}</p> : null}</footer>;
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
  useLayoutEffect(() => { const viewport = viewportRef.current; if (viewport && nearBottom.current) viewport.scrollTop = viewport.scrollHeight; }, [entries, data?.live.streamingText, data?.live.streamingThinking, toolProjection]);
  return <main className="conversation-workspace"><div className="conversation-scroll" ref={viewportRef} onScroll={(event) => { const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}><div className="conversation-thread">{entries.length ? entries.map((entry, index) => { const message = entry.message; if (!message) return null; const key = entry.id || index; const toolsForEntry = toolProjection.byEntry.get(entry) || []; if (message.role === 'user') return <UserMessage key={key} message={message} />; if (message.role === 'assistant') { const showMessage = !!messageText(message) || (showThinking && !!messageThinking(message)); return <div className="assistant-turn" key={key}>{showMessage ? <AssistantMessage message={message} showThinking={showThinking} /> : null}{toolsForEntry.map((tool) => <ToolCard key={tool.id} tool={tool} sessionId={sessionId} />)}</div>; } return toolsForEntry.length ? <div className="assistant-turn" key={key}>{toolsForEntry.map((tool) => <ToolCard key={tool.id} tool={tool} sessionId={sessionId} />)}</div> : null; }) : <div className="conversation-empty"><span>τ</span><h1>开始分析交通问题</h1><p>描述路段、时间或出行需求，Agent 会在独立会话中完成分析。</p></div>}{toolProjection.liveOnly.map((tool) => <ToolCard key={tool.id} tool={tool} sessionId={sessionId} />)}{data?.live.optimisticPrompt ? <UserMessage message={{ role: 'user', content: data.live.optimisticPrompt.message, images: data.live.optimisticPrompt.images }} /> : null}{data?.live.active ? <AssistantMessage streaming showThinking={showThinking} message={{ role: 'assistant', content: [{ type: 'thinking', thinking: data.live.streamingThinking }, { type: 'text', text: data.live.streamingText }] as MessageContentBlock[] }} /> : null}</div></div><Composer sessionId={sessionId} streaming={!!data?.live.active} queued={data?.live.queued || []} taskModeEnabled={taskState.enabled} /></main>;
}
