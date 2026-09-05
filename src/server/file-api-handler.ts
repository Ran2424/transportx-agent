import fs = require('node:fs');
import path = require('node:path');
import { execFile, spawn } from 'node:child_process';

import type { ServerResponse } from 'node:http';
import type { JsonRecord, RpcCommand, StatusError } from './types.js';
import type { PiRpcSession } from './sessions.js';
import { latestPiWebBridgeEnvelope } from '../contracts/index.js';
import { isWithin } from './util/path.js';

type FileHandlersOptions = {
  sessionsDir: string;
  expandHome(value: string): string;
  json(res: ServerResponse, status: number, data: unknown): void;
  errorMessage(error: unknown): string;
  isWithinPath(root: string, target: string): boolean;
  resolveLivePath(session: PiRpcSession | null | undefined, requestedPath?: string | null): string;
  getLiveSession(id?: string): PiRpcSession | null | undefined;
};

const IGNORED_NAMES = new Set(['node_modules', '.git', '__pycache__', '.DS_Store', '.Trash', '.next', '.nuxt', 'dist', 'build', '.cache', '.turbo', 'venv', '.venv', 'env', '.env.local', '.pi', 'coverage', '.nyc_output', '.parcel-cache']);
const FILE_PREVIEW_MAX_BYTES = 1_000_000;
const DEFAULT_TOOLS: Record<string, { label: string; description: string }> = {
  read: { label: '读取', description: '读取文件内容' }, bash: { label: '命令', description: '执行终端命令' }, edit: { label: '编辑', description: '修改已有文件' }, write: { label: '创建', description: '创建或覆盖文件' },
};

export function createFileApiHandlers(options: FileHandlersOptions) {
  const serveFiles = (res: ServerResponse, rawPath: string) => {
    try {
      const dirPath = path.resolve(options.expandHome(rawPath));
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return options.json(res, 400, { error: 'Not a directory' });
      const items = fs.readdirSync(dirPath, { withFileTypes: true }).flatMap((entry) => {
        if ((entry.name.startsWith('.') && entry.name !== '.env') || IGNORED_NAMES.has(entry.name)) return [];
        try {
          const fullPath = path.join(dirPath, entry.name), stat = fs.statSync(fullPath);
          return [{ name: entry.name, path: fullPath, isDirectory: entry.isDirectory(), size: entry.isDirectory() ? null : stat.size, mtime: stat.mtimeMs }];
        } catch { return []; }
      });
      items.sort((a, b) => a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name));
      options.json(res, 200, { path: dirPath, items });
    } catch (error) { options.json(res, 500, { error: options.errorMessage(error) }); }
  };
  const serveFileContent = (res: ServerResponse, filePath: string) => {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return options.json(res, 404, { error: 'File not found' });
    const stat = fs.statSync(filePath);
    if (stat.size > FILE_PREVIEW_MAX_BYTES) return options.json(res, 413, { error: `File is too large to preview (limit ${FILE_PREVIEW_MAX_BYTES} bytes)` });
    try {
      const buffer = fs.readFileSync(filePath), extension = path.extname(filePath).toLowerCase();
      if (['.xlsx', '.xls', '.ods'].includes(extension)) return options.json(res, 200, { content: buffer.toString('base64'), encoding: 'base64', size: stat.size });
      if (buffer.includes(0)) return options.json(res, 415, { error: 'Binary files cannot be previewed as text' });
      options.json(res, 200, { content: buffer.toString('utf8'), encoding: 'utf8', size: stat.size });
    } catch (error) { options.json(res, 500, { error: options.errorMessage(error) }); }
  };
  const resourcePath = (command: JsonRecord) => {
    const sourceInfo = command.sourceInfo;
    if (sourceInfo && typeof sourceInfo === 'object' && 'path' in sourceInfo && typeof sourceInfo.path === 'string') return sourceInfo.path;
    return typeof command.path === 'string' ? command.path : '';
  };
  const resourceScope = (command: JsonRecord) => {
    const sourceInfo = command.sourceInfo;
    if (sourceInfo && typeof sourceInfo === 'object' && 'scope' in sourceInfo && typeof sourceInfo.scope === 'string') return sourceInfo.scope;
    return typeof command.location === 'string' ? command.location : '';
  };
  const previewToolArgs = (args: unknown) => {
    if (!args || typeof args !== 'object') return '';
    const record = args as JsonRecord;
    for (const key of ['path', 'command', 'query', 'url']) if (typeof record[key] === 'string' && record[key]) return String(record[key]);
    const value = Object.values(record).find((item) => typeof item === 'string' && item);
    return typeof value === 'string' ? value : '';
  };
  const collectSessionTools = (entries: JsonRecord[]) => {
    const byName = new Map(Object.entries(DEFAULT_TOOLS).map(([name, meta]) => [name, { name, label: meta.label, description: meta.description, usedCount: 0, lastPreview: '', source: 'builtin' }]));
    for (const entry of entries) {
      const message = entry.type === 'message' ? entry.message as JsonRecord | undefined : undefined;
      if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        const call = block as JsonRecord;
        if (!call || call.type !== 'toolCall') continue;
        const name = String(call.name || '').trim();
        if (!name) continue;
        const known = byName.get(name) || { name, label: DEFAULT_TOOLS[name]?.label || name, description: '会话中出现过的工具调用', usedCount: 0, lastPreview: '', source: 'observed' };
        known.usedCount += 1; known.lastPreview = previewToolArgs(call.arguments); byName.set(name, known);
      }
    }
    return [...byName.values()].sort((a, b) => a.usedCount !== b.usedCount ? b.usedCount - a.usedCount : a.label.localeCompare(b.label));
  };
  const serveResources = async (res: ServerResponse, session: PiRpcSession) => {
    let commands: JsonRecord[] = [], commandsError = '';
    try {
      const response = await session.send({ type: 'get_commands' }, { timeoutMs: 5000 });
      const data = (response.data || response.result || response) as JsonRecord;
      commands = Array.isArray(data.commands) ? data.commands.filter((item): item is JsonRecord => !!item && typeof item === 'object') : [];
    } catch (error) { commandsError = options.errorMessage(error); }
    const skills = commands.filter((command) => command.source === 'skill').map((command) => ({ name: String(command.name || ''), description: typeof command.description === 'string' ? command.description : '', path: resourcePath(command), scope: resourceScope(command) })).filter((command) => command.name);
    const observed = collectSessionTools(session.entries);
    const observedByName = new Map(observed.map((tool) => [tool.name, tool]));
    const bridge = latestPiWebBridgeEnvelope(session.entries);
    const tools = bridge ? bridge.tools.map((tool) => {
      const used = observedByName.get(tool.name);
      return { name: tool.name, label: tool.name, description: tool.description, usedCount: used?.usedCount || 0, lastPreview: used?.lastPreview || '', source: tool.sourceInfo || 'pi-manifest', active: tool.active, parameters: tool.parameters, promptGuidelines: tool.promptGuidelines };
    }) : observed;
    options.json(res, 200, { skills, tools, toolsComplete: !!bridge, commandsError: commandsError || undefined });
  };
  const servePreview = (res: ServerResponse, filePath: string) => {
    if (!filePath) return options.json(res, 400, { error: 'path required' });
    const mimes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon' };
    const mime = mimes[path.extname(filePath).toLowerCase().slice(1)];
    if (!mime) return options.json(res, 415, { error: 'Not a previewable image' });
    try { if (!fs.statSync(filePath).isFile()) throw new Error('Not a file'); res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'max-age=60' }); fs.createReadStream(filePath).pipe(res); }
    catch (error) { options.json(res, 404, { error: options.errorMessage(error) }); }
  };
  const resolveExportedSessionPath = (filePath: string) => {
    const resolved = path.resolve(options.expandHome(filePath || '')), root = path.resolve(options.sessionsDir);
    if (!isWithin(root, resolved) || path.extname(resolved).toLowerCase() !== '.html') { const error = new Error('Can only open exported session HTML without a live session') as StatusError; error.status = 403; throw error; }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) { const error = new Error('File not found') as StatusError; error.status = 404; throw error; }
    return resolved;
  };
  const resolveOpen = (body: RpcCommand) => {
    if (!body?.filePath || typeof body.filePath !== 'string') throw new Error('filePath required');
    if (body.sessionId) {
      const resolved = options.resolveLivePath(options.getLiveSession(body.sessionId), body.filePath);
      if (!fs.existsSync(resolved)) { const error = new Error('File not found') as StatusError; error.status = 404; throw error; }
      return resolved;
    }
    return resolveExportedSessionPath(body.filePath);
  };
  const openNative = async (filePath: string) => {
    if (!filePath || typeof filePath !== 'string') throw new Error('filePath required');
    const resolved = path.resolve(options.expandHome(filePath));
    if (!fs.existsSync(resolved)) throw new Error('File not found');
    if (process.platform === 'win32') spawn('explorer.exe', [resolved], { detached: true, stdio: 'ignore' }).unref();
    else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [resolved], () => {});
  };
  return { serveFiles, serveFileContent, serveResources, servePreview, resolveOpen, openNative, resolveExportedSessionPath };
}
