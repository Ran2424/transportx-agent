import fs = require('node:fs');
import path = require('node:path');
import readline = require('node:readline');

import type { Dirent } from 'node:fs';
import type { ServerResponse } from 'node:http';
import type { JsonRecord } from './types.js';
import type { LiveSessionManager } from './sessions.js';
import { TimingMetricsStore } from './timing-metrics.js';
import { within } from './asset-integrity.js';
import { deriveSessionName, titleFromMessageContent } from './session-history-reader.js';

type HistoryHandlersOptions = {
  sessionsDir: string;
  snapshotSchemaVersion: number;
  projectsDir?: string;
  expandHome(value: string): string;
  json(res: ServerResponse, status: number, data: unknown): void;
  errorMessage(error: unknown): string;
  readBranch(filePath: string): unknown[];
  isGenericSessionName(name: string): boolean;
  sessions: LiveSessionManager;
};

export function createSessionHistoryHandlers(options: HistoryHandlersOptions) {
  const listSessionFiles = () => {
    if (!fs.existsSync(options.sessionsDir)) return [];
    const files: Array<{ dirName: string; file: string; filePath: string }> = [];
    for (const entry of fs.readdirSync(options.sessionsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push({ dirName: '', file: entry.name, filePath: path.join(options.sessionsDir, entry.name) });
        continue;
      }
      if (!entry.isDirectory()) continue;
      const projectDir = path.join(options.sessionsDir, entry.name);
      for (const file of fs.readdirSync(projectDir).filter((name: string) => name.endsWith('.jsonl'))) {
        files.push({ dirName: entry.name, file, filePath: path.join(projectDir, file) });
      }
    }
    return files;
  };
  const isWithinPath = within;
  const normalizeSessionCwd = (cwd: unknown) => typeof cwd === 'string' && cwd.trim() ? path.resolve(options.expandHome(cwd)) : null;
  const readSessionEntries = (filePath: string) => {
    const entries = options.readBranch(filePath) as JsonRecord[];
    const header = entries.find((entry) => entry.type === 'session');
    const cwd = normalizeSessionCwd(header?.cwd);
    return cwd ? new TimingMetricsStore(cwd).enrichEntries(entries) : entries;
  };
  const resolveSessionName = (entries: JsonRecord[]) => deriveSessionName(entries, options.isGenericSessionName);
  const readSessionHeaderCwd = (filePath: string) => {
    let fd: number | null = null;
    try {
      fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(64 * 1024);
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      for (const line of buffer.toString('utf8', 0, count).split(/\r?\n/)) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (entry?.type === 'session') return normalizeSessionCwd(entry.cwd);
      }
    } catch { return null; }
    finally { if (fd !== null) try { fs.closeSync(fd); } catch {} }
    return null;
  };
  const messageTimestamp = (entry: JsonRecord) => {
    const message = entry.message as { timestamp?: unknown } | undefined;
    const value = message?.timestamp ?? entry.timestamp;
    const date = typeof value === 'number' ? new Date(value) : typeof value === 'string' ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : '';
  };
  const conversationTime = (session: Record<string, unknown>) => {
    const time = new Date(String(session.lastConversationAt || session.timestamp || '')).getTime();
    return Number.isFinite(time) ? time : 0;
  };
  const parseSessionFile = async (filePath: string) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let header: JsonRecord | null = null, firstMessage: string | null = null, sessionName: string | null = null, lastConversationAt = '', userMessageCount = 0, lineCount = 0;
    for await (const line of lines) {
      if (!line.trim()) continue;
      lineCount += 1;
      try {
        const entry = JSON.parse(line) as JsonRecord;
        if (entry.type === 'session') header = entry;
        else if (entry.type === 'session_info' && typeof entry.name === 'string') sessionName = entry.name;
        else if (entry.type === 'message' && (entry.message as JsonRecord | undefined)?.role === 'user') {
          userMessageCount += 1;
          if (!firstMessage) firstMessage = titleFromMessageContent((entry.message as JsonRecord).content);
        }
        if (entry.type === 'message' && ['user', 'assistant'].includes(String((entry.message as JsonRecord | undefined)?.role || ''))) {
          const timestamp = messageTimestamp(entry);
          if (timestamp > lastConversationAt) lastConversationAt = timestamp;
        }
      } catch {}
    }
    lines.close(); stream.destroy();
    if (!header?.id || (userMessageCount <= 1 && lineCount <= 8)) return null;
    return { id: header.id, timestamp: header.timestamp || '', lastConversationAt: lastConversationAt || header.timestamp || '', name: sessionName, firstMessage, cwd: normalizeSessionCwd(header.cwd) };
  };

  function serveProjects(res: ServerResponse) {
    const projectsDir = options.projectsDir;
    if (!projectsDir || !fs.existsSync(projectsDir)) return options.json(res, 200, { projects: [], ...(projectsDir ? { error: 'Directory not found' } : {}) });
    try {
      const root = path.resolve(projectsDir);
      const sessionInfo = new Map<string, { count: number; lastActive: number }>();
      for (const { filePath } of listSessionFiles()) {
        try {
          const cwd = readSessionHeaderCwd(filePath);
          if (!cwd || !isWithinPath(root, cwd)) continue;
          const current = sessionInfo.get(cwd) || { count: 0, lastActive: 0 };
          sessionInfo.set(cwd, { count: current.count + 1, lastActive: Math.max(current.lastActive, fs.statSync(filePath).mtimeMs) });
        } catch {}
      }
      const liveCwds = new Set(options.sessions.list().map((session) => session.cwd));
      const projects = fs.readdirSync(root, { withFileTypes: true }).filter((entry: Dirent) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry: Dirent) => {
        const fullPath = path.join(root, entry.name);
        const info = sessionInfo.get(fullPath) || { count: 0, lastActive: 0 };
        return { name: entry.name, path: fullPath, sessionCount: info.count, lastActive: info.lastActive || null, active: liveCwds.has(fullPath) };
      });
      options.json(res, 200, { projects });
    } catch (error) { options.json(res, 500, { error: options.errorMessage(error) }); }
  }

  async function serveSessions(res: ServerResponse) {
    try {
      if (!fs.existsSync(options.sessionsDir)) return options.json(res, 200, { projects: [] });
      const projectsByPath = new Map<string, { path: string; dirName: string; sessions: Array<Record<string, unknown>> }>();
      const liveFiles = new Set(options.sessions.list().map((session) => session.sessionFile).filter(Boolean));
      for (const { dirName, file, filePath } of listSessionFiles()) {
        try {
          const parsed = await parseSessionFile(filePath);
          if (!parsed) continue;
          const projectPath = parsed.cwd || '';
          const project = projectsByPath.get(projectPath) || { path: projectPath, dirName, sessions: [] };
          projectsByPath.set(projectPath, project);
          project.sessions.push({ ...parsed, file, filePath, mtime: fs.statSync(filePath).mtimeMs, live: liveFiles.has(filePath) });
        } catch {}
      }
      const projects = [...projectsByPath.values()];
      projects.forEach((project) => project.sessions.sort((a, b) => conversationTime(b) - conversationTime(a)));
      projects.sort((a, b) => conversationTime(b.sessions[0] || {}) - conversationTime(a.sessions[0] || {}));
      options.json(res, 200, { projects });
    } catch (error) { options.json(res, 500, { error: options.errorMessage(error) }); }
  }

  async function serveSearch(res: ServerResponse, query: string) {
    try {
      if (!query || query.length < 2 || !fs.existsSync(options.sessionsDir)) return options.json(res, 200, { results: [] });
      const results: Array<Record<string, unknown>> = [], needle = query.toLowerCase();
      for (const { filePath } of listSessionFiles()) {
        if (results.length >= 30) break;
        const stream = fs.createReadStream(filePath, { encoding: 'utf8' }), lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let sessionId = '', sessionName = '', sessionTimestamp = '', firstMessage = '', cwd: string | null = null;
        const matches: Array<Record<string, string>> = [];
        for await (const line of lines) try {
          const entry = JSON.parse(line);
          if (entry.type === 'session') { sessionId = entry.id; sessionTimestamp = entry.timestamp || ''; cwd = normalizeSessionCwd(entry.cwd); }
          if (entry.type === 'session_info' && entry.name) sessionName = entry.name;
          if (entry.type === 'message') {
            const content = entry.message?.content, text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((block) => block.type === 'text').map((block) => block.text).join(' ') : '';
            if (!firstMessage && entry.message?.role === 'user' && text) firstMessage = text.slice(0, 120);
            const index = text.toLowerCase().indexOf(needle);
            if (index >= 0) matches.push({ role: entry.message?.role || 'unknown', snippet: `${index > 0 ? '…' : ''}${text.slice(Math.max(0, index - 60), Math.min(text.length, index + needle.length + 60)).replace(/\n/g, ' ')}${index + needle.length + 60 < text.length ? '…' : ''}` });
            if (matches.length >= 3) break;
          }
        } catch {}
        lines.close(); stream.destroy();
        if (matches.length) results.push({ filePath, project: cwd || '', sessionId, sessionName, sessionTimestamp, firstMessage, matches });
      }
      options.json(res, 200, { results });
    } catch (error) { options.json(res, 500, { error: options.errorMessage(error) }); }
  }

  const serveSessionFile = (res: ServerResponse, dirName: string, file: string) => {
    const filePath = path.join(options.sessionsDir, dirName, file);
    if (!fs.existsSync(filePath)) return options.json(res, 404, { error: 'Session not found' });
    return options.json(res, 200, { schemaVersion: options.snapshotSchemaVersion, entries: readSessionEntries(filePath) });
  };

  return { normalizeSessionCwd, readSessionEntries, deriveSessionName: resolveSessionName, readSessionHeaderCwd, serveProjects, serveSessions, serveSearch, serveSessionFile };
}
