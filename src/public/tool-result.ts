type ToolResultBlock = {
  type?: string;
  text?: string;
  source?: { media_type?: string; data?: string };
  media_type?: string;
  [key: string]: unknown;
};

type ToolResult = { content?: ToolResultBlock[]; [key: string]: unknown };

const MAX_TOOL_OUTPUT_CHARS = 6000;
const MAX_TOOL_FIELD_CHARS = 1200;
const ENCODED_IMAGE_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;
const BASE64ISH_RE = /^[A-Za-z0-9+/=\s]+$/;

export function formatToolResultText(result: unknown) {
  if (!result) return '';
  const value = result as ToolResult;
  if (Array.isArray(value.content)) return limitToolOutput(value.content.map(formatToolResultBlock).join('\n'));
  return limitToolOutput(safeToolStringify(result));
}

function formatToolResultBlock(block: ToolResultBlock) {
  if (block.type === 'text') return sanitizeToolText(block.text || '');
  if (block.type === 'image') return `[图片内容已省略：${block.source?.media_type || block.media_type || 'image'}]`;
  return safeToolStringify(block);
}

function sanitizeToolText(text: string) {
  const raw = String(text || '');
  if (raw.length >= 2048 && (ENCODED_IMAGE_RE.test(raw.trim()) || (raw.replace(/\s+/g, '').length > 2048 && BASE64ISH_RE.test(raw.replace(/\s+/g, ''))))) return `[图片/二进制内容已省略：${raw.length.toLocaleString()} 字符]`;
  return raw.length <= MAX_TOOL_FIELD_CHARS ? raw : `${raw.slice(0, MAX_TOOL_FIELD_CHARS)}\n\n[输出过长，已截断 ${raw.length.toLocaleString()} 字符，避免页面卡顿]`;
}

function safeToolStringify(value: unknown) {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'string') return sanitizeToolText(item);
      if (item && typeof item === 'object') { if (seen.has(item)) return '[Circular]'; seen.add(item); }
      return item;
    }, 2);
  } catch { return sanitizeToolText(String(value)); }
}

function limitToolOutput(text: string) {
  return text.length <= MAX_TOOL_OUTPUT_CHARS ? text : `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n[工具输出过长，已截断 ${text.length.toLocaleString()} 字符]`;
}
