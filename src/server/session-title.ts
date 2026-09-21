import fs = require('node:fs');

export function isGenericSessionName(name: unknown) {
  const normalized = String(name || '').trim().toLowerCase();
  return normalized === 'chat' || normalized === 'new chat' || normalized === 'untitled' || normalized === 'untitled chat' || normalized === 'session';
}

export function appendSessionNameEntry(filePath: string, name: string) {
  fs.appendFileSync(filePath, `${JSON.stringify({ type: 'session_info', name, explicit: true, timestamp: new Date().toISOString() })}\n`);
}

// ===== 修复 BEGIN：第二条消息起全部卡死（EEXIST）=====
// 原实现见 fix-backup/session-title.ts.orig。
// 问题：Pi 的 SessionManager._persist 首次落盘使用 openSync(file, 'wx')
// 排他创建会话文件；而本函数用 appendFileSync 会提前创建该文件（写入
// session_info），导致 Pi 首次 flush 抛 EEXIST——第一个 run 的回复仍能
// 流式显示（事件先于落盘发出），但从第二条消息起，用户消息落盘即抛错，
// run 立刻以空 assistant（stopReason=error）结束，表现为"卡住"。
// 修复：只有当会话文件已包含 Pi 自己的头部（首行 type === 'session'，
// 即 Pi 已完成首次 wx flush）时才允许追加 session_info；否则调用方应
// 保留 pending 状态等待下次时机。
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
// ===== 修复 END =====

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
