#!/usr/bin/env node

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JsonRecord, RpcCommand, RpcResponse, StatusError } from './types.js';
import { APP_PATHS, ARGS, ASSET_OVERRIDES, ASSET_RESOLVER, AUTH_CONFIGURED, DEFAULT_DOMAIN_ID, DESKTOP_MODE, HOST, MIME_TYPES, MODULE_INSTALLER, MODULE_REGISTRY, PI_AGENT_DIR, PI_COMMAND, PI_COMMAND_ARGS, PORT, PYTHON_EXECUTABLE, REACT_STATIC_DIR, SESSION_ASSEMBLER, SESSIONS_DIR, TAU_SETTINGS, expandHome, loadTauSettings, parseArgs, reloadModules, saveTauSetting, setModuleEnabled } from './config.js';
import { SESSION_COOKIE_NAME, SESSION_REFRESH_THRESHOLD_SECONDS, buildSessionCookie, issueSessionToken, parseCookies, verifySessionToken } from './auth.js';
import { getAvailableModels, modelLabel, normalizeModel, parseModelSpecToModel, parsePiListModels, _clearModelListCacheForTest, _setExecFileForTest } from './model-utils.js';
import { LiveSessionManager, PiRpcSession, isGenericSessionName, liveManager, makeId, setCitationEndpoint, setSpatialEndpoint, _setSpawnPiForTest } from './sessions.js';
import { handleGeoResourceRoute } from './geo-resources.js';
import { handleCitationResourceRoute } from './citation-resources.js';
import { renderReportPdf } from './report-pdf.js';
import { inspectPiRuntime, piProcessEnv } from './pi-runtime.js';
import { readSessionBranch } from './session-projection.js';
import { createApiRouter } from './api-routes.js';
import { SESSION_SNAPSHOT_SCHEMA_VERSION } from '../contracts/index.js';
import { createFileApiHandlers } from './file-api-handler.js';
import { createSessionHistoryHandlers } from './session-history-handler.js';
import { createStaticHandler } from './static-handler.js';
import { attachWebSocketHandler } from './websocket-handler.js';
import { AGENT_HOST_PROTOCOL_VERSION } from './runtime-resolver.js';
import { addPiModel } from './pi-model-config.js';
import { connectPiModelProvider, disconnectPiModelProvider, listPiModelProviders } from './pi-model-access.js';
import { platformOverview } from './platform-overview.js';
import { listSessionAttachments, saveUploadedAttachments, deleteSessionAttachment, resolveSessionAttachments, buildAttachmentContext, attachmentFilePath } from './session-attachments.js';
import { CitationService } from './citation-service.js';
import { RpcCommandLedger } from './rpc-command-ledger.js';
import { SpatialAnalysisService } from './spatial-analysis-service.js';
import { verifyChecksumFile } from './asset-integrity.js';

let authEnabled = AUTH_CONFIGURED && TAU_SETTINGS.authEnabled !== false;
let lanUrl = '';
let tailscaleUrl = '';
const citationService = new CitationService();
const spatialAnalysisService = new SpatialAnalysisService(PYTHON_EXECUTABLE, path.resolve(APP_PATHS.appRoot, 'modules/capabilities/spatial-analysis/scripts/spatial_analysis.py'));
const rpcCommandLedger = new RpcCommandLedger<RpcResponse>();
const reliableCommandTypes = new Set(['prompt', 'steer', 'follow_up', 'abort', 'extension_ui_response']);

type AuthResult = { ok: boolean; via: 'disabled' | 'basic' | 'cookie' | 'none'; expiresAt?: number };

function checkBasicAuth(req: IncomingMessage) {
  if (!authEnabled) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString(), colon = decoded.indexOf(':');
  return colon !== -1 && decoded.slice(0, colon) === TAU_SETTINGS.user && decoded.slice(colon + 1) === TAU_SETTINGS.pass;
}

function checkAuth(req: IncomingMessage): AuthResult {
  if (!authEnabled) return { ok: true, via: 'disabled' };
  if (checkBasicAuth(req)) return { ok: true, via: 'basic' };
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
  if (token) {
    const verdict = verifySessionToken(token);
    if (verdict.valid) return { ok: true, via: 'cookie', expiresAt: verdict.expiresAt };
  }
  return { ok: false, via: 'none' };
}

function isForwardedHttps(req: IncomingMessage) {
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function maybeSetSessionCookie(req: IncomingMessage, res: ServerResponse, auth: AuthResult) {
  if (!authEnabled || !auth.ok || auth.via === 'disabled') return;
  let expiresAt = auth.expiresAt;
  if (expiresAt === undefined) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
    if (token) {
      const verdict = verifySessionToken(token);
      if (verdict.valid) expiresAt = verdict.expiresAt;
    }
  }
  if (expiresAt !== undefined && expiresAt - Math.floor(Date.now() / 1000) >= SESSION_REFRESH_THRESHOLD_SECONDS) return;
  res.setHeader('Set-Cookie', buildSessionCookie(issueSessionToken(), { secure: isForwardedHttps(req) }));
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function errorStatus(error: unknown) { return error && typeof error === 'object' && 'status' in error && typeof (error as StatusError).status === 'number' ? (error as StatusError).status! : 400; }
function json(res: ServerResponse, status: number, data: unknown, extraHeaders: Record<string, string> = {}) { res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders }); res.end(JSON.stringify(data)); }

function sendAuthRequired(res: ServerResponse, req: IncomingMessage) {
  if (parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]) res.setHeader('Set-Cookie', buildSessionCookie('', { secure: isForwardedHttps(req), clear: true }));
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Tau"', 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

function readBody(req: IncomingMessage): Promise<RpcCommand> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); if (body.length > 20 * 1024 * 1024) reject(new Error('Request body too large')); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) as RpcCommand : {}); } catch (error) { reject(error); } });
    req.on('error', reject);
  });
}

function resolveSessionFile(filePath: string) {
  if (!filePath || typeof filePath !== 'string') throw new Error('filePath required');
  const resolved = path.resolve(filePath), root = path.resolve(SESSIONS_DIR);
  if (!resolved.startsWith(root + path.sep) || !resolved.endsWith('.jsonl')) throw new Error('Invalid session file');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error('Session not found');
  return resolved;
}

function appendSessionName(filePath: string, name: string) {
  const resolved = resolveSessionFile(filePath);
  fs.appendFileSync(resolved, `${JSON.stringify({ type: 'session_info', name, timestamp: new Date().toISOString() })}\n`);
  return resolved;
}

function updateLiveSessionName(session: PiRpcSession | null | undefined, name: string) {
  if (!session) return;
  session.sessionName = name; session.titleSet = true;
  liveManager.broadcast({ type: 'event', sessionId: session.id, event: { type: 'session_name', name } });
  liveManager.broadcastUpdated(session.id);
}

function isWithinPath(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveLiveSessionPath(session: PiRpcSession | null | undefined, requestedPath?: string | null) {
  if (!session) { const error = new Error('Live session not found') as StatusError; error.status = 404; throw error; }
  const root = fs.realpathSync(path.resolve(session.cwd));
  const requested = expandHome(requestedPath || session.cwd);
  const candidate = path.resolve(path.isAbsolute(requested) ? requested : path.join(root, requested));
  let resolved = candidate;
  try { resolved = fs.realpathSync(candidate); } catch {}
  if (!isWithinPath(root, resolved)) { const error = new Error('Path is outside the active session directory') as StatusError; error.status = 403; throw error; }
  return resolved;
}

function resolveExportOutputPath(outputPath: string, sessionFile: string) {
  if (!outputPath || typeof outputPath !== 'string') throw new Error('outputPath required');
  const sessionDir = path.dirname(path.resolve(sessionFile)), sessionDirReal = fs.realpathSync(sessionDir), expanded = expandHome(outputPath), resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(sessionDir, expanded);
  if (!isWithinPath(sessionDir, resolved) || path.extname(resolved).toLowerCase() !== '.html') { const error = new Error('Export outputPath must be an .html file in the session directory') as StatusError; error.status = 403; throw error; }
  let parentReal: string;
  try { parentReal = fs.realpathSync(path.dirname(resolved)); } catch { const error = new Error('Export output directory not found') as StatusError; error.status = 404; throw error; }
  if (!isWithinPath(sessionDirReal, parentReal) || (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink())) { const error = new Error('Export outputPath must stay inside the session directory') as StatusError; error.status = 403; throw error; }
  return resolved;
}

function openUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error('Invalid URL'));
  if (process.platform === 'win32') { spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref(); return Promise.resolve(); }
  return new Promise((resolve, reject) => execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], (error: NodeJS.ErrnoException | null) => error ? reject(error) : resolve()));
}

function currentPlatformOverview() {
  const storage = { root: PI_AGENT_DIR, scenario: TAU_SETTINGS.projectsDir || APP_PATHS.scenarioDir };
  try {
    const plan = SESSION_ASSEMBLER.assemble(DEFAULT_DOMAIN_ID, storage.scenario);
    return platformOverview(APP_PATHS, MODULE_REGISTRY, ASSET_RESOLVER, storage, new Set(plan.assets.map((asset) => asset.id)));
  } catch (error) {
    return platformOverview(APP_PATHS, MODULE_REGISTRY, ASSET_RESOLVER, storage, new Set(), errorMessage(error));
  }
}

function currentSessionOptions() {
  const enabled = new Set(TAU_SETTINGS.enabledModuleIds);
  const defaultVersions = new Set(MODULE_INSTALLER.sources().map((source) => `${source.moduleId}:${path.basename(source.packageRoot!)}`));
  return {
    schemaVersion: 1,
    modules: MODULE_INSTALLER.catalog().map((entry) => ({
      id: entry.id,
      name: entry.manifest.name,
      version: entry.version,
      type: entry.manifest.type,
      origin: 'installed',
      compatible: true,
      enabledForNewSessions: enabled.has(entry.id),
      selectedByDefault: enabled.has(entry.id) && defaultVersions.has(`${entry.id}:${entry.version}`),
      dependencies: entry.manifest.dependencies,
      assets: (entry.manifest.contributes?.assets || []).map((asset) => {
        const assetPath = path.resolve((ASSET_OVERRIDES as Record<string, string>)[asset.id] || path.resolve(entry.source.packageRoot!, asset.path));
        const integrityFile = asset.integrityFile ? (fs.existsSync(path.resolve(entry.source.packageRoot!, asset.integrityFile)) ? path.resolve(entry.source.packageRoot!, asset.integrityFile) : path.join(assetPath, path.basename(asset.integrityFile))) : '';
        let integrity: 'verified' | 'unverified' | 'missing' = asset.integrityFile ? 'missing' : 'unverified';
        if (asset.integrityFile && fs.existsSync(assetPath) && fs.existsSync(integrityFile)) try { verifyChecksumFile(assetPath, integrityFile); integrity = 'verified'; } catch { integrity = 'missing'; }
        return { id: asset.id, kind: asset.kind, configured: fs.existsSync(assetPath), integrity };
      }),
    })),
  };
}

async function handleRpcCommandOnce(command: RpcCommand): Promise<RpcResponse> {
  const success = (data?: unknown): RpcResponse => ({ type: 'response', command: command.type, success: true, id: command.id, ...(data === undefined ? {} : { data }) });
  const failure = (message: string): RpcResponse => ({ type: 'response', command: command.type, success: false, error: message, id: command.id });
  if (command.type === 'get_auth') return success({ configured: AUTH_CONFIGURED, enabled: authEnabled });
  if (command.type === 'set_auth') {
    if (!AUTH_CONFIGURED) return failure('No credentials configured. Set tau.user and tau.pass in settings.json');
    const wasEnabled = authEnabled; authEnabled = !!command.enabled; saveTauSetting('authEnabled', authEnabled);
    liveManager.broadcast({ type: 'event', event: { type: 'auth_changed', enabled: authEnabled } });
    if (!wasEnabled && authEnabled) { const timer = setTimeout(() => [...liveManager.clients].forEach((client) => { try { client.close(4001, 'Authentication enabled'); } catch {} }), 25); timer.unref?.(); }
    return success({ enabled: authEnabled });
  }
  if (command.type === 'get_available_models') return success({ models: await getAvailableModels() });
  if (command.type === 'get_model_providers') {
    try { return success({ providers: await listPiModelProviders(PI_AGENT_DIR) }); }
    catch (error) { return failure(errorMessage(error)); }
  }
  if (command.type === 'connect_model_provider') {
    try {
      const provider = await connectPiModelProvider(String(command.provider || ''), String(command.apiKey || ''), PI_AGENT_DIR);
      _clearModelListCacheForTest();
      return success({ provider });
    } catch (error) { return failure(errorMessage(error)); }
  }
  if (command.type === 'disconnect_model_provider') {
    try {
      await disconnectPiModelProvider(String(command.provider || ''), PI_AGENT_DIR);
      _clearModelListCacheForTest();
      return success();
    } catch (error) { return failure(errorMessage(error)); }
  }
  if (command.type === 'add_model') {
    try {
      const model = await addPiModel(command as Omit<Partial<import('./pi-model-config.js').AddPiModelInput>, 'api'> & { api?: string }, PI_AGENT_DIR);
      _clearModelListCacheForTest();
      return success({ model });
    } catch (error) { return failure(errorMessage(error)); }
  }
  if (command.type === 'get_platform_overview') return success(currentPlatformOverview());
  if (command.type === 'install_module') {
    if (!DESKTOP_MODE) return failure('Module installation is only available in the desktop app');
    let installed: { id: string; name: string; version: string; path: string } | null = null;
    try {
      installed = MODULE_INSTALLER.install(String(command.sourcePath || ''));
      reloadModules();
      if (MODULE_REGISTRY.get(installed.id)?.origin !== 'installed') throw new Error(`Module id conflicts with an existing module: ${installed.id}`);
      setModuleEnabled(installed.id, true);
      return success({ installed, overview: currentPlatformOverview() });
    } catch (error) {
      if (installed) {
        try { MODULE_INSTALLER.uninstall(installed.id); } catch {}
        try { reloadModules(); } catch {}
      }
      return failure(errorMessage(error));
    }
  }
  if (command.type === 'uninstall_module') {
    if (!DESKTOP_MODE) return failure('Module uninstallation is only available in the desktop app');
    try {
      const moduleId = String(command.moduleId || '');
      if ([...liveManager.sessions.values()].some((session) => session.resolvedSessionPlan?.modules.some((module) => module.id === moduleId))) throw new Error('Close active tasks that use this module before uninstalling it');
      MODULE_INSTALLER.uninstall(moduleId, MODULE_REGISTRY);
      reloadModules();
      return success({ overview: currentPlatformOverview() });
    } catch (error) { return failure(errorMessage(error)); }
  }
  if (command.type === 'set_module_enabled') {
    if (!DESKTOP_MODE) return failure('Module selection is only available in the desktop app');
    try {
      setModuleEnabled(String(command.moduleId || ''), command.enabled === true);
      return success({ overview: currentPlatformOverview() });
    } catch (error) { return failure(errorMessage(error)); }
  }
  if (command.type === 'migrate_legacy_modules') {
    if (!DESKTOP_MODE) return failure('Module migration is only available in the desktop app');
    try {
      const migrated = MODULE_INSTALLER.migrateLegacyPackages();
      reloadModules();
      return success({ migrated, overview: currentPlatformOverview() });
    } catch (error) { return failure(errorMessage(error)); }
  }
  if (command.type === 'set_session_name') {
    const name = command.name?.trim();
    if (!name) return failure('Name cannot be empty');
    const session = command.sessionId ? liveManager.get(command.sessionId) : null, resolvedFile = command.filePath || session?.sessionFile ? appendSessionName(command.filePath || session!.sessionFile!, name) : null;
    const matching = resolvedFile ? [...liveManager.sessions.values()].find((item) => item.sessionFile && path.resolve(item.sessionFile) === resolvedFile) : null;
    if (session) updateLiveSessionName(session, name); else if (matching) updateLiveSessionName(matching, name); else if (!resolvedFile) return failure('sessionId or filePath required');
    return success({ name });
  }
  const session = command.sessionId ? liveManager.get(command.sessionId) : null;
  if (command.type === 'export_html') {
    try {
      if (command.sessionId && !session) throw new Error('Live session not found');
      const file = command.filePath ? resolveSessionFile(command.filePath) : session?.sessionFile;
      if (!file) throw new Error('No session file to export yet');
      const args = [...PI_COMMAND_ARGS, '--export', file, ...(command.outputPath ? [resolveExportOutputPath(command.outputPath, file)] : [])];
      const output = await new Promise<string>((resolve, reject) => execFile(PI_COMMAND, args, { cwd: session?.cwd || path.dirname(file), timeout: 30000, encoding: 'utf8', env: piProcessEnv() }, (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => error ? reject(new Error(stderr || error.message)) : resolve(stdout)));
      let result = path.resolve(expandHome(output.trim().split('\n').pop() || file.replace(/\.jsonl$/, '.html')));
      if (!fs.existsSync(result)) result = file.replace(/\.jsonl$/, '.html');
      return success({ path: result });
    } catch (error) { return failure(errorMessage(error)); }
  }
  if (!session) return failure('No active Tau session. 没有活跃的交通任务，请先创建或选择一个任务。');
  if (command.type === 'get_state') return success({ model: session.model, thinkingLevel: session.thinkingLevel, isStreaming: session.isStreaming, sessionFile: session.sessionFile, sessionName: session.sessionName, autoCompactionEnabled: true });
  if (command.type === 'get_messages') return success({ entries: session.entries });
  if (command.type === 'live_session_snapshot_request') return { type: 'live_session_snapshot', sessionId: session.id, ...session.snapshot() };
  if (command.type === 'set_auto_compaction') return success({ enabled: !!command.enabled });
  const native = new Set(['prompt', 'steer', 'follow_up', 'abort', 'compact', 'set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level', 'get_session_stats', 'get_commands', 'extension_ui_response']);
  if (!native.has(command.type || '')) return failure(`Unknown command: ${command.type}`);
  const previousLevel = command.type === 'set_thinking_level' ? session.thinkingLevel : null;
  if (command.type === 'extension_ui_response' && (typeof command.id !== 'string' || !session.pendingExtensionUiRequests.has(command.id))) {
    return failure('Extension UI request is no longer pending');
  }
  if (previousLevel !== null && command.level) session.thinkingLevel = command.level;
  let trackedPromptAttachments: string[] | null = null;
  try {
    let rpcCommand = { ...command };
    delete rpcCommand.clientCommandId;
    if (['prompt', 'steer', 'follow_up'].includes(command.type || '')) {
      const rawIds = command.attachmentIds;
      const attachmentIds = rawIds === undefined ? [] : Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === 'string') : null;
      if (!attachmentIds) return failure('attachmentIds must be an array');
      const attachments = resolveSessionAttachments(session.cwd, attachmentIds);
      const message = typeof command.message === 'string' ? command.message : '';
      const context = buildAttachmentContext(attachments);
      const imageInputs = session.model && ((session.model as Record<string, unknown>).images === true || (Array.isArray((session.model as Record<string, unknown>).input) && ((session.model as Record<string, unknown>).input as unknown[]).includes('image')))
        ? attachments.filter((attachment) => attachment.kind === 'image').map((attachment) => ({ type: 'image', data: fs.readFileSync(attachmentFilePath(session.cwd, attachment)).toString('base64'), mimeType: attachment.mimeType }))
        : [];
      rpcCommand = { ...command, message: `${message}${context}`, ...(imageInputs.length ? { images: imageInputs } : {}) } as unknown as RpcCommand;
      delete rpcCommand.attachmentIds;
    }
    if (command.type === 'set_model' && (!command.provider || !command.modelId)) {
      const parsed = parseModelSpecToModel(command.model);
      if (!parsed.model?.provider || !parsed.model.id) return failure('模型格式无效，请使用 provider/model');
      rpcCommand = { ...command, provider: parsed.model.provider, modelId: parsed.model.id };
    }
    if (['prompt', 'steer', 'follow_up'].includes(command.type || '')) {
      trackedPromptAttachments = Array.isArray(command.attachmentIds) ? command.attachmentIds.filter((id): id is string => typeof id === 'string') : [];
      session.registerPromptAttachments(trackedPromptAttachments);
    }
    const response = await session.send(rpcCommand, { timeoutMs: command.type === 'prompt' ? 300000 : 60000 });
    if (command.type === 'extension_ui_response' && typeof command.id === 'string') session.pendingExtensionUiRequests.delete(command.id);
    if (response.success === false && previousLevel !== null) session.thinkingLevel = previousLevel;
    return { ...response, success: response.success !== false };
  } catch (error) {
    if (previousLevel !== null) session.thinkingLevel = previousLevel;
    if (trackedPromptAttachments) session.discardPromptAttachments(trackedPromptAttachments);
    return failure(errorMessage(error));
  }
}

async function handleRpcCommand(command: RpcCommand): Promise<RpcResponse> {
  const clientCommandId = typeof command.clientCommandId === 'string' && command.clientCommandId.trim() ? command.clientCommandId.trim() : '';
  if (!clientCommandId || !reliableCommandTypes.has(command.type || '')) return handleRpcCommandOnce(command);
  const key = `${command.sessionId || ''}:${command.type}:${clientCommandId}`;
  return rpcCommandLedger.run(key, async () => {
    const response = await handleRpcCommandOnce(command);
    return response.success === false ? { ...response, clientCommandId } : {
      ...response,
      clientCommandId,
      delivery: 'accepted',
      acceptedAt: new Date().toISOString(),
    };
  });
}

function isAllowedApiOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function setCorsForAllowedOrigin(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!isAllowedApiOrigin(req)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return true;
}

const history = createSessionHistoryHandlers({ sessionsDir: SESSIONS_DIR, projectsDir: TAU_SETTINGS.projectsDir, snapshotSchemaVersion: SESSION_SNAPSHOT_SCHEMA_VERSION, expandHome, json, errorMessage, readBranch: readSessionBranch, isGenericSessionName, sessions: liveManager });
const files = createFileApiHandlers({ sessionsDir: SESSIONS_DIR, expandHome, json, errorMessage, isWithinPath, resolveLivePath: resolveLiveSessionPath, getLiveSession: (id) => id ? liveManager.get(id) : null });
const apiRouter = createApiRouter({
  sessions: liveManager, snapshotSchemaVersion: SESSION_SNAPSHOT_SCHEMA_VERSION, health: () => ({ status: 'ok', product: 'TransportX Traffic Agent', role: 'agent-host', protocolVersion: AGENT_HOST_PROTOCOL_VERSION, liveSessionCount: liveManager.sessions.size, lanUrl, tailscaleUrl: tailscaleUrl || undefined, platform: process.platform }), sessionOptions: currentSessionOptions, json, errorMessage, errorStatus, readBody, resolveSessionFile, sessionCwd: history.normalizeSessionCwd, readSessionHeaderCwd: history.readSessionHeaderCwd, readSessionEntries: history.readSessionEntries, deriveSessionName: history.deriveSessionName, serveProjects: history.serveProjects, serveSessions: history.serveSessions, serveSearch: history.serveSearch, resolveLivePath: resolveLiveSessionPath, serveFiles: files.serveFiles, serveFileContent: files.serveFileContent, serveResources: files.serveResources, servePreview: files.servePreview, resolveOpen: files.resolveOpen, openNative: files.openNative, handleRpc: handleRpcCommand, renderReportPdf, serveSessionFile: history.serveSessionFile,
  listAttachments: listSessionAttachments,
  uploadAttachments: saveUploadedAttachments,
  deleteAttachment: deleteSessionAttachment,
  citation: citationService,
  spatial: spatialAnalysisService,
});

function handleApiRoute(req: IncomingMessage, res: ServerResponse, urlPath: string) {
  const originAllowed = setCorsForAllowedOrigin(req, res);
  if (req.method === 'OPTIONS') { if (!originAllowed) return json(res, 403, { error: 'Origin not allowed' }); res.writeHead(200); res.end(); return; }
  if (!originAllowed) return json(res, 403, { error: 'Origin not allowed' });
  const parsed = new URL(`http://localhost${req.url || urlPath}`);
  if (handleGeoResourceRoute(req, res, parsed.pathname, { getSession: (id) => liveManager.get(id) })) return;
  if (handleCitationResourceRoute(req, res, parsed.pathname, { knowledgeRoots: (session) => (session.resolvedSessionPlan?.assets || []).filter((asset): asset is { id: string; kind: 'knowledge'; path: string } => asset.kind === 'knowledge' && typeof asset.id === 'string' && typeof asset.path === 'string').map((asset) => ({ id: asset.id, path: asset.path })), getSession: (id) => liveManager.get(id) })) return;
  if (!apiRouter.dispatch(req, res, parsed)) json(res, 404, { error: 'Not found' });
}

const staticHandler = createStaticHandler({ reactStaticDir: REACT_STATIC_DIR, mimeTypes: MIME_TYPES as Record<string, string>, authEnabled: () => authEnabled, checkAuth, sendAuthRequired, maybeSetSessionCookie, handleApi: handleApiRoute });
const server = http.createServer(staticHandler.serveStaticFile);
const socketHandler = attachWebSocketHandler({ server, sessions: liveManager, isAllowedOrigin: isAllowedApiOrigin, authEnabled: () => authEnabled, isAuthenticated: (request) => checkAuth(request).ok });
const { wss } = socketHandler;

function computeUrls(port: number) {
  const loopback = HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost';
  let localIp = 'localhost', tailscaleIp = '';
  if (!loopback) {
    const nets = os.networkInterfaces();
    for (const name of ['en0', 'en1', 'wlan0', 'eth0']) { for (const net of nets[name] || []) if (net.family === 'IPv4' && !net.internal) { localIp = net.address; break; } if (localIp !== 'localhost') break; }
    if (localIp === 'localhost') outer: for (const name of Object.keys(nets)) { if (/^(bridge|utun|lo)/.test(name)) continue; for (const net of nets[name] || []) if (net.family === 'IPv4' && !net.internal) { localIp = net.address; break outer; } }
    for (const name of Object.keys(nets)) for (const net of nets[name] || []) if (net.family === 'IPv4' && !net.internal && net.address.startsWith('100.')) tailscaleIp = net.address;
  }
  lanUrl = `http://${localIp}:${port}`; tailscaleUrl = tailscaleIp ? `http://${tailscaleIp}:${port}` : '';
  setCitationEndpoint(`http://127.0.0.1:${port}`);
  setSpatialEndpoint(`http://127.0.0.1:${port}`);
}

function listen(port: number, attemptsLeft = 10) {
  server.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && attemptsLeft > 0) { console.log(`[Tau] Port ${port} in use, trying ${port + 1}...`); server.removeAllListeners('error'); listen(port + 1, attemptsLeft - 1); }
    else { console.error(`[Tau] Failed to start: ${error.message}`); process.exit(1); }
  });
  server.listen(port, HOST, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    computeUrls(actualPort);
    console.log(`[Tau] Server running on ${lanUrl}${tailscaleUrl ? `  •  Tailscale: ${tailscaleUrl}` : ''}`);
    console.log(`[Tau] React application: ${REACT_STATIC_DIR} (/)`);
    if (DESKTOP_MODE) console.log(JSON.stringify({ type: 'transportx-agent-host-ready', port: actualPort, host: HOST, protocolVersion: AGENT_HOST_PROTOCOL_VERSION, pid: process.pid }));
    if (ARGS.open) openUrl(lanUrl).catch(() => {});
  });
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true; console.log(`\n[Tau] Shutting down (${signal}); terminating ${liveManager.sessions.size} Pi session(s)...`);
  socketHandler.close(); try { wss.close(); } catch {}
  spatialAnalysisService.terminateAll(); await liveManager.shutdown(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2500).unref();
}
function startCli() {
  const runtime = inspectPiRuntime(PI_COMMAND, PI_COMMAND_ARGS); liveManager.setPiVersion(runtime.version); console.log(`[Tau] Pi runtime: ${runtime.command} ${runtime.version}`);
  console.log(`[Tau] Modules: ${MODULE_REGISTRY.enabled().length} enabled, ${MODULE_REGISTRY.errors.length} error(s)`);
  process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => { for (const session of liveManager.sessions.values()) try { session.child?.kill('SIGTERM'); } catch {} });
  process.on('uncaughtException', (error) => { console.error(error); shutdown('uncaughtException'); }); process.on('unhandledRejection', (error) => console.error(error));
  const parentPid = Number(ARGS['parent-pid'] || process.env.TAU_PARENT_PID || 0);
  if (DESKTOP_MODE && parentPid > 0) {
    const watcher = setInterval(() => { try { process.kill(parentPid, 0); } catch { clearInterval(watcher); shutdown('parent_exit'); } }, 1000);
    watcher.unref();
  }
  listen(PORT);
}

function _setAuthForTest(enabled: boolean) { authEnabled = !!enabled; }
function _setCredentialsForTest(user: string, pass: string) { TAU_SETTINGS.user = user; TAU_SETTINGS.pass = pass; }
function _issueSessionTokenForTest(expiresAtSeconds?: number) { return issueSessionToken(expiresAtSeconds); }

module.exports = { parseArgs, expandHome, loadTauSettings, modelLabel, normalizeModel, parseModelSpecToModel, parsePiListModels, getAvailableModels, makeId, PiRpcSession, LiveSessionManager, liveManager, resolveSessionFile, appendSessionName, updateLiveSessionName, isWithinPath, resolveLiveSessionPath, resolveExportOutputPath, resolveExportedSessionPath: files.resolveExportedSessionPath, resolveOpenPath: files.resolveOpen, openUrl, handleRpcCommand, isAllowedApiOrigin, setCorsForAllowedOrigin, handleApiRoute, serveStaticFile: staticHandler.serveStaticFile, serveReactStaticFile: staticHandler.serveReactStaticFile, server, wss, computeUrls, listen, startCli, SESSIONS_DIR, PI_AGENT_DIR, checkAuth, SESSION_COOKIE_NAME, _setAuthForTest, _setCredentialsForTest, _issueSessionTokenForTest, _setSpawnPiForTest, _setExecFileForTest, _clearModelListCacheForTest };
