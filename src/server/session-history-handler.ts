import fs = require('node:fs');
import path = require('node:path');

import type { Dirent } from 'node:fs';
import type { ServerResponse } from 'node:http';
import type { JsonRecord } from './types.js';
import type { LiveSessionManager } from './sessions.js';
import { isWithin } from './util/path.js';
import { containedFile } from './util/resource-path.js';
import { deriveSessionName, readSessionHeaderCwd as readHistoryHeaderCwd, readSessionSummary, searchSessionFile } from './session-history-reader.js';
import { listSessionHistoryFiles } from './session-history-files.js';

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
  const listSessionFiles = () => listSessionHistoryFiles(options.sessionsDir);
  const isWithinPath = isWithin;
  const normalizeSessionCwd = (cwd: unknown) => typeof cwd === 'string' && cwd.trim() ? path.resolve(options.expandHome(cwd)) : null;
  const readSessionEntries = (filePath: string) => {
    return options.readBranch(filePath) as JsonRecord[];
  };
  const resolveSessionName = (entries: JsonRecord[]) => deriveSessionName(entries, options.isGenericSessionName);
  const readSessionHeaderCwd = (filePath: string) => readHistoryHeaderCwd(filePath, normalizeSessionCwd);
  const conversationTime = (session: Record<string, unknown>) => {
    const time = new Date(String(session.lastConversationAt || session.timestamp || '')).getTime();
    return Number.isFinite(time) ? time : 0;
  };
  const parseSessionFile = (filePath: string) => readSessionSummary(filePath, normalizeSessionCwd);

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
      const results: Array<Record<string, unknown>> = [];
      for (const { filePath } of listSessionFiles()) {
        if (results.length >= 30) break;
        const result = await searchSessionFile(filePath, query, normalizeSessionCwd);
        if (result) results.push(result);
      }
      options.json(res, 200, { results });
    } catch (error) { options.json(res, 500, { error: options.errorMessage(error) }); }
  }

  const serveSessionFile = (res: ServerResponse, dirName: string, file: string) => {
    const filePath = path.join(options.sessionsDir, dirName, file);
    if (!fs.existsSync(filePath)) return options.json(res, 404, { error: 'Session not found' });
    try { return options.json(res, 200, { schemaVersion: options.snapshotSchemaVersion, entries: readSessionEntries(containedFile(options.sessionsDir, filePath)) }); }
    catch (error) { return options.json(res, (error as { status?: number }).status || 400, { error: options.errorMessage(error) }); }
  };

  return { normalizeSessionCwd, readSessionEntries, deriveSessionName: resolveSessionName, readSessionHeaderCwd, serveProjects, serveSessions, serveSearch, serveSessionFile };
}
