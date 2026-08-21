import { formatToolResultText } from '../../../public/tool-result.js';
import i18n from '../../i18n';

const IMAGE_PATH_RE = /((?:~|\/)[^\n\r"'<>`]*?\.(?:png|jpe?g|gif|webp|svg|ico))(?:[?#][^\s"'<>`]*)?/gi;
export const TOOL_TEXT_PREVIEW_LIMIT = 4_000;
export const TOOL_OUTPUT_PREVIEW_LIMIT = 12_000;

export function imagePaths(value: unknown) {
  const text = formatToolResultText(value, i18n.language);
  const paths = new Set<string>();
  for (const match of text.matchAll(IMAGE_PATH_RE)) paths.add(match[1]);
  return [...paths].slice(0, 3);
}

export function truncateToolText(value: string, limit: number) {
  if (value.length <= limit) return value;
  const tailLength = Math.min(600, Math.floor(limit / 4));
  return `${value.slice(0, limit - tailLength)}\n\n…\n\n${value.slice(-tailLength)}\n\n${i18n.t('conversation.tool.truncated', { count: value.length.toLocaleString() })}`;
}

export function compactToolArgs(args: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === 'string' ? truncateToolText(value, TOOL_TEXT_PREVIEW_LIMIT) : value]));
}
