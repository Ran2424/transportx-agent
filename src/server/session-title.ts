import fs = require('node:fs');

export function isGenericSessionName(name: unknown) {
  const normalized = String(name || '').trim().toLowerCase();
  return normalized === 'chat' || normalized === 'new chat' || normalized === 'untitled' || normalized === 'untitled chat' || normalized === 'session';
}

export function appendSessionNameEntry(filePath: string, name: string) {
  fs.appendFileSync(filePath, `${JSON.stringify({ type: 'session_info', name, explicit: true, timestamp: new Date().toISOString() })}\n`);
}

// Pi's SessionManager performs its first flush with openSync(file, 'wx');
// appending before that flush would pre-create the file and make Pi throw
// EEXIST. Only append once the file holds Pi's own header (first line
// type === 'session'); callers keep the pending name and retry otherwise.
export function sessionFileReadyForNameAppend(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      const firstLine = buf.subarray(0, read).toString('utf8').split('\n').find((line) => line.trim());
      if (!firstLine) return false;
      return (JSON.parse(firstLine) as { type?: unknown }).type === 'session';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
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
