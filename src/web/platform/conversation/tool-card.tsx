import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatToolResultText } from '../../../public/tool-result.js';
import { Icon } from '../../components/icons';
import i18n from '../../i18n';
import { copyText } from './conversation-clipboard';
import { durationSeconds, useElapsedMilliseconds } from './conversation-duration';
import { compactToolArgs, imagePaths, TOOL_OUTPUT_PREVIEW_LIMIT, TOOL_TEXT_PREVIEW_LIMIT, truncateToolText } from './tool-card-formatting';
import { compactCharacterCount, toolFilePath, toolIconName, TOOL_LABELS } from './tool-card-utils';
import { ToolFilePreview } from './tool-file-preview';
import type { ToolData } from './tool-projection';

function preview(args: Record<string, unknown>) {
  for (const key of ['path', 'command', 'query', 'url', 'title', 'action']) if (typeof args[key] === 'string') return args[key] as string;
  return Object.values(args).find((value): value is string => typeof value === 'string') || '';
}

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

function ToolDuration({ startedAt, durationMs }: { startedAt?: number; durationMs?: number }) {
  const { t } = useTranslation();
  const elapsedMs = useElapsedMilliseconds(startedAt ?? null, durationMs ?? null);
  return elapsedMs === null ? null : <span className="tool-duration">{t('conversation.thinkingDuration', { count: durationSeconds(elapsedMs) })}</span>;
}

export const ToolCard = memo(function ToolCard({ tool, sessionId }: { tool: ToolData; sessionId: string }) {
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
  return <section className={`tool-card${open ? ' is-open' : ''}`}><header><button type="button" className="tool-card-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}><Icon className="tool-chevron" name="chevron" /><strong>{toolLabel(tool.name)}</strong>{preview(tool.args) ? <small title={preview(tool.args)}>{preview(tool.args)}</small> : null}{tool.status === 'preparing' && tool.argumentChars ? <span className="tool-argument-size">{t('conversation.tool.argumentChars', { count: compactCharacterCount(tool.argumentChars) })}</span> : null}{tool.startedAt !== undefined || tool.durationMs !== undefined ? <ToolDuration startedAt={tool.status === 'running' ? tool.startedAt : undefined} durationMs={tool.durationMs} /> : null}</button><span className={`tool-status ${tool.status}`} data-tool-kind={iconName} title={status}><Icon name={iconName} /><span className="sr-only">{status}</span></span></header>{open ? <div className="tool-card-body">{isEdit ? <div className="tool-diff"><pre className="diff-removed">{oldText}</pre><pre className="diff-added">{newText}</pre></div> : Object.keys(tool.args).length ? <pre className="tool-args">{JSON.stringify(displayedArgs, null, 2)}</pre> : null}{output ? <><div className="tool-output-actions"><span>{t('conversation.tool.output')}</span><button type="button" onClick={() => void copyText(output)}>{t('common.copy')}</button></div><pre className="tool-output">{displayedOutput}</pre>{imagePaths(tool.result).map((path) => <a className="tool-image-preview" key={path} href={`/api/file/preview?${new URLSearchParams({ sessionId, path })}`} target="_blank" rel="noopener"><img loading="lazy" src={`/api/file/preview?${new URLSearchParams({ sessionId, path })}`} alt={t('conversation.tool.imagePreview', { name: path.split('/').pop() })} /></a>)}{readPath ? <ToolFilePreview sessionId={sessionId} path={readPath} /> : null}</> : readPath ? <ToolFilePreview sessionId={sessionId} path={readPath} /> : tool.status === 'running' ? <span className="tool-pending">{t('conversation.tool.waiting')}</span> : null}</div> : null}</section>;
});
