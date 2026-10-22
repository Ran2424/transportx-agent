import { memo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { formatToolResultText } from '../../../public/tool-result.js';
import { Icon } from '../../components/icons';
import i18n from '../../i18n';
import { copyText } from './conversation-clipboard';
import { durationSeconds, useElapsedMilliseconds } from './conversation-duration';
import { compactToolArgs, imagePaths, TOOL_OUTPUT_PREVIEW_LIMIT, TOOL_TEXT_PREVIEW_LIMIT, truncateToolText } from './tool-card-formatting';
import { compactCharacterCount, spatialExecutionState, toolFilePath, toolIconName, TOOL_LABELS } from './tool-card-utils';
import { ToolFilePreview } from './tool-file-preview';
import type { ToolData } from './tool-projection';
import { toolExpansionStore } from './tool-expansion-store';

function preview(args: Record<string, unknown>) {
  for (const key of ['path', 'command', 'query', 'url', 'title', 'action']) if (typeof args[key] === 'string') return args[key] as string;
  return '';
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
  const open = useSyncExternalStore(toolExpansionStore.subscribe, () => toolExpansionStore.get(sessionId, tool.id) ?? false);
  const output = tool.result === undefined ? '' : formatToolResultText(tool.result, i18n.language);
  const isEdit = tool.name.toLowerCase() === 'edit' && (typeof tool.args.oldText === 'string' || typeof tool.args.old_text === 'string');
  const oldText = truncateToolText(String(tool.args.oldText ?? tool.args.old_text ?? ''), TOOL_TEXT_PREVIEW_LIMIT);
  const newText = truncateToolText(String(tool.args.newText ?? tool.args.new_text ?? ''), TOOL_TEXT_PREVIEW_LIMIT);
  const displayedArgs = compactToolArgs(tool.args);
  const displayedOutput = truncateToolText(output, TOOL_OUTPUT_PREVIEW_LIMIT);
  const normalizedToolName = tool.name.toLowerCase().replaceAll('-', '_');
  const readPath = normalizedToolName === 'read' || normalizedToolName.startsWith('read_') ? toolFilePath(tool.args) : '';
  const state = spatialExecutionState(tool.result) || (tool.isError ? 'error' : tool.status);
  const status = state === 'unknown' ? t('conversation.tool.resultUnknown') : state === 'cancelled' ? t('conversation.cancelled') : state === 'preparing' ? t('conversation.tool.preparing') : state === 'running' ? t('conversation.tool.running') : state === 'error' ? t('conversation.tool.failed') : t('conversation.tool.completed');
  const object = preview(tool.args) || tool.name;
  const iconName = toolIconName(tool.name);
  return <section className={`tool-card${open ? ' is-open' : ''}`}><header><button type="button" className="tool-card-toggle" data-tool-call-id={tool.id} aria-expanded={open} onClick={() => toolExpansionStore.set(sessionId, tool.id, !open)}><Icon className="tool-chevron" name="chevron" /><strong>{toolLabel(tool.name)}</strong>{object ? <small title={object}>{object}</small> : null}<span className="tool-state-label">{state === 'preparing' ? t('conversation.tool.preparingShort') : status}</span>{tool.status === 'preparing' && tool.argumentChars ? <span className="tool-argument-size">{t('conversation.tool.argumentChars', { count: compactCharacterCount(tool.argumentChars) })}</span> : null}{tool.startedAt !== undefined || tool.durationMs !== undefined ? <ToolDuration startedAt={tool.status === 'running' ? tool.startedAt : undefined} durationMs={tool.durationMs} /> : null}</button><span className={`tool-status ${state}`} data-tool-kind={iconName} title={status} aria-hidden="true"><Icon name={iconName} /></span></header>{open ? <div className="tool-card-body">{isEdit ? <div className="tool-diff"><pre className="diff-removed">{oldText}</pre><pre className="diff-added">{newText}</pre></div> : Object.keys(tool.args).length ? <pre className="tool-args">{JSON.stringify(displayedArgs, null, 2)}</pre> : null}{output ? <><div className="tool-output-actions"><span>{t('conversation.tool.output')}</span><button type="button" onClick={() => void copyText(output)}>{t('common.copy')}</button></div><pre className="tool-output">{displayedOutput}</pre>{imagePaths(tool.result).map((path) => <a className="tool-image-preview" key={path} href={`/api/file/preview?${new URLSearchParams({ sessionId, path })}`} target="_blank" rel="noopener"><img loading="lazy" src={`/api/file/preview?${new URLSearchParams({ sessionId, path })}`} alt={t('conversation.tool.imagePreview', { name: path.split('/').pop() })} /></a>)}{readPath ? <ToolFilePreview sessionId={sessionId} path={readPath} /> : null}</> : readPath ? <ToolFilePreview sessionId={sessionId} path={readPath} /> : tool.status === 'running' ? <span className="tool-pending">{t('conversation.tool.waiting')}</span> : null}</div> : null}</section>;
});
