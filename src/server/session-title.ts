import fs = require('node:fs');

export function isGenericSessionName(name: unknown) {
  const normalized = String(name || '').trim().toLowerCase();
  return normalized === 'chat' || normalized === 'new chat' || normalized === 'untitled' || normalized === 'untitled chat' || normalized === 'session';
}

export function appendSessionNameEntry(filePath: string, name: string) {
  fs.appendFileSync(filePath, `${JSON.stringify({ type: 'session_info', name, explicit: true, timestamp: new Date().toISOString() })}\n`);
}

export function inferSessionTitle(messages: string[]) {
  const message = messages.find((item) => item.trim().length > 8) || messages[0];
  if (!message) return null;
  let title = message.replace(/^(ok |okay |so |actually |hey |please |can you |could you |i want(ed)? to |i wanna |let'?s )/i, '').replace(/\n.*/s, '').trim();
  const sentenceEnd = title.search(/[.!?]\s/);
  if (sentenceEnd > 10 && sentenceEnd < 80) title = title.slice(0, sentenceEnd);
  if (title.length > 60) title = title.slice(0, 57).replace(/\s+\S*$/, '') + '…';
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return title || null;
}
