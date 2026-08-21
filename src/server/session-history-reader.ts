import type { JsonRecord } from './types.js';

export function titleFromMessageContent(content: unknown) {
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((block): block is { type?: unknown; text?: unknown } => !!block && typeof block === 'object').filter((block) => block.type === 'text').map((block) => typeof block.text === 'string' ? block.text : '').join('\n')
    : '';
  let title = text.replace(/^(ok |okay |so |actually |hey |please |can you |could you |i want(ed)? to |i wanna |let'?s )/i, '').replace(/\n.*/s, '').trim();
  if (!title) return null;
  const sentenceEnd = title.search(/[.!?]\s/);
  if (sentenceEnd > 10 && sentenceEnd < 80) title = title.slice(0, sentenceEnd);
  if (title.length > 60) title = title.slice(0, 57).replace(/\s+\S*$/, '') + '…';
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export function deriveSessionName(entries: JsonRecord[], isGenericSessionName: (name: string) => boolean) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; name?: unknown };
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (entry?.type === 'session_info' && name && !isGenericSessionName(name)) return name;
  }
  for (const entry of entries) {
    const message = entry as { type?: string; message?: { role?: string; content?: unknown } };
    if (message?.type === 'message' && message.message?.role === 'user') {
      const title = titleFromMessageContent(message.message.content);
      if (title) return title;
    }
  }
  return null;
}
