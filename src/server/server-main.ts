#!/usr/bin/env node

import { openNativeTarget } from './host-platform.js';
import { initializeHostLogging, logHostEvent, logHostError } from './diagnostic-log.js';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JsonRecord, RpcCommand, RpcResponse, StatusError } from './types.js';
import { acquireWriteLease } from './util/json-storage.js';
import { APP_PATHS, ARGS, AUTH_CONFIGURED, PROJECT_AUTH, DEFAULT_DOMAIN_ID, DESKTOP_MODE, FFMPEG_EXECUTABLES, HOST, MIME_TYPES, PI_AGENT_DIR, PI_COMMAND, PI_COMMAND_ARGS, PORT, PYTHON_EXECUTABLE, REACT_STATIC_DIR, SESSIONS_DIR, TAU_SETTINGS, expandHome, loadTauSettings, parseArgs, saveTauSetting } from './config.js';
import { ASSET_OVERRIDES, ASSET_RESOLVER, MODULE_INSTALLER, MODULE_REGISTRY, SESSION_ASSEMBLER, reloadModules, setModuleEnabled, sessionAssemblerForProfile } from './platform-composition.js';
import { buildSessionPiLaunch } from './session-pi-launch.js';
import { BUILTIN_MODULE_MANIFESTS } from './config.js';
import { ModuleTrustStore, confirmDesktopModuleTrust, ensureSessionModuleTrust } from './module-trust.js';
import { readToolContract } from './tool-contracts.js';
import { approvedHostToolContract } from './tool-request.js';
import { diagnoseTool } from './tool-diagnostics.js';
import { CORE_TOOL_BINDINGS } from '../contracts/tool-interface.js';
import { resolveSessionWorkspaceForDeletion, removeSessionWorkingDirectory } from './session-workspace.js';
import { SESSION_COOKIE_NAME, SESSION_REFRESH_THRESHOLD_SECONDS, buildSessionCookie, issueSessionToken, parseCookies, verifySessionToken } from './auth.js';
import { getAvailableModels, modelLabel, normalizeModel, parseModelSpecToModel } from './model-utils.js';
import { LiveSessionManager, PiRpcSession } from './sessions.js';
import { makeSessionId as makeId } from './session-workspace.js';
import { handleGeoResourceRoute } from './geo-resources.js';
import { handleVideoResourceRoute } from './video-resources.js';
import { handleCitationResourceRoute } from './citation-resources.js';
import { renderReportPdf, desktopMessageChannel } from './report-pdf.js';
import { UpdatePreparation } from './update-preparation.js';
import { inspectPiRuntime, piProcessEnv } from './pi-runtime.js';
import { createApiRouter, REPORT_PDF_MAX_HTML_BYTES } from './api-routes.js';
import { SESSION_SNAPSHOT_SCHEMA_VERSION } from '../contracts/index.js';
import { createFileApiHandlers } from './file-api-handler.js';
import { createStaticHandler } from './static-handler.js';
import { attachWebSocketHandler } from './websocket-handler.js';
import { AGENT_HOST_PROTOCOL_VERSION } from './runtime-resolver.js';
import type { RpcHandlerRegistry } from './rpc-handlers.js';
import { createAuthRpcHandlers } from './rpc-handlers/auth.js';
import { createModuleRpcHandlers } from './rpc-handlers/module.js';
import { createModelRpcHandlers } from './rpc-handlers/model.js';
import { createNativeRpcHandlers } from './rpc-handlers/native.js';
import { buildGeoPromptContext, geoInteractionService } from './geo-interaction-service.js';
import { createPlatformRpcHandlers } from './rpc-handlers/platform.js';
import { platformOverview, resolveModuleDirectory } from './platform-overview.js';
import { buildAttachmentContext } from '../contracts/attachments.js';
import { listSessionAttachments, saveUploadedAttachments, deleteSessionAttachment, resolveSessionAttachments, attachmentFilePath } from './session-attachments.js';
import { CitationService } from './citation-service.js';
import { WorkspaceStore } from './workspace-store.js';
import { WorkspaceMigration } from './workspace-migration.js';
import { WorkspaceMigrationRunner } from './workspace-migration-runner.js';
import { WorkspaceRuntimeGate } from './workspace-runtime.js';
import { WorkspaceService } from './workspace-service.js';
import { ConversationRuntime } from './conversation-runtime.js';
import { WorkspaceDeletion } from './workspace-deletion.js';
import { WorkspaceTransfer } from './workspace-transfer.js';
import { WorkspaceHost } from './workspace-host.js';
import { removeExecutionMetadata } from './util/execution-owner.js';
import { RpcCommandLedger } from './rpc-command-ledger.js';
import { SpatialAnalysisService } from './spatial-analysis-service.js';
import { CadService } from './cad-service.js';
import { preferUnpackedPath } from './session-assembly.js';
import { VideoService } from './video-service.js';
import { verifyChecksumFile } from './asset-integrity.js';
import { isWithin } from './util/path.js';
import { writeJson as json } from './http/response.js';
import { ModuleRegistry, moduleRuntimeCompatible } from './module-registry.js';
import { CanvasService, buildCanvasContextPrompt } from './canvas-service.js';
import { isLoopbackHost, validateHostAccess } from './host-access.js';
import { readJsonBody } from './http/request.js';
import { createHash } from 'node:crypto';
import { parseRpcCommand } from './rpc-command-input.js';
import { boundedDiagnostics } from '../contracts/diagnostics.js';
import { HOST_PROTOCOL_HEADER } from '../contracts/host-protocol.js';
const diagnoseCommand = boundedDiagnostics(200);

const moduleTrust = new ModuleTrustStore(path.join(APP_PATHS.settingsDir, 'module-trust.json'), (request) => DESKTOP_MODE ? confirmDesktopModuleTrust(request) : Promise.resolve(false));
const liveManager = new LiveSessionManager({
  command: PI_COMMAND, launch: async (input) => {
    await ensureSessionModuleTrust(input.resolvedSessionPlan, BUILTIN_MODULE_MANIFESTS.map((source) => source.manifestPath), moduleTrust);
    return buildSessionPiLaunch(input);
  }, spawn,
  endpoints: { citation: '', spatial: '', video: '', geo: '', canvas: '', moduleAuthoring: '', cad: '' },
});

function _setSpawnPiForTest(fn: typeof liveManager.runtime.spawn | null | undefined) { liveManager.runtime.spawn = fn || spawn; }

let authEnabled = !!PROJECT_AUTH || (AUTH_CONFIGURED && TAU_SETTINGS.authEnabled !== false);
let lanUrl = '';
let tailscaleUrl = '';
const citationService = new CitationService();
const canvasService: CanvasService = new CanvasService(citationService, (session, requestedPath) => { const live = liveManager.get(session.id); if (!live) throw Object.assign(new Error('Conversation runtime is unavailable.'), { status: 404 }); return workspaceHost.file(live.conversationId, requestedPath); }, {
  present: (session, input) => cadService.present(liveManager.get(session.id)!, input),
  resolve: (session, viewId) => cadService.resolvePresentation(liveManager.get(session.id)!, viewId),
});
const spatialAnalysisService = new SpatialAnalysisService(PYTHON_EXECUTABLE, preferUnpackedPath(path.resolve(APP_PATHS.appRoot, 'modules/capabilities/spatial-analysis/scripts/spatial_analysis.py')));
const cadService: CadService = new CadService(PYTHON_EXECUTABLE, preferUnpackedPath(path.resolve(APP_PATHS.appRoot, 'modules/capabilities/cad/scripts/cad_engine.py')), (session, ids) => canvasService.inspectContexts(session, ids));
let cadHealth: { ok: boolean; version?: string; reason?: string } | null = null;
void cadService.health().then((value) => { cadHealth = value; }).catch((error) => { cadHealth = { ok: false, reason: String(error) }; });
const videoService = new VideoService(FFMPEG_EXECUTABLES);
const rpcCommandLedger = new RpcCommandLedger<RpcResponse>(200, 10 * 60_000, (response) => response.delivery === 'unknown');
const updatePreparation = new UpdatePreparation();
const workspaceStore = new WorkspaceStore(APP_PATHS.userDataDir, SESSIONS_DIR);
const workspaceMigration = new WorkspaceMigration(workspaceStore, { agentDir: PI_AGENT_DIR, workspaceRoots: [...new Set([APP_PATHS.scenarioDir, TAU_SETTINGS.projectsDir].filter((value): value is string => !!value))], recoverTransfers: () => workspaceTransfer.recover() });
const workspaceGate = new WorkspaceRuntimeGate(PYTHON_EXECUTABLE.command, APP_PATHS.logsDir, process.env.TAU_RUNTIME_COORDINATION_DIR ? path.resolve(process.env.TAU_RUNTIME_COORDINATION_DIR) : undefined);
const migrationRunner = new WorkspaceMigrationRunner(workspaceMigration, workspaceGate, PYTHON_EXECUTABLE.command);
const assembleWorkspacePlan = (configuration: { domainId: string; profile: import('../contracts/index.js').SessionProfileV1 }, directory: string) => sessionAssemblerForProfile(configuration.profile).assemble(configuration.domainId, directory, configuration.profile);
const validateWorkspaceModel = async (spec: string) => {
  const { model } = parseModelSpecToModel(spec);
  if (!model || !(await getAvailableModels()).some((candidate: { provider?: string; id?: string }) => candidate.provider === model.provider && candidate.id === model.id)) throw Object.assign(new Error('Selected model is unavailable. Choose a configured model.'), { code: 'model_unavailable', status: 400 });
};
const conversationRuntime = new ConversationRuntime({ store: workspaceStore, sessions: liveManager, gate: workspaceGate, assertReady: (id) => workspaceMigration.assertWorkspaceReady(id), verifyPlan: async (plan, directory, modelSpec) => { const verified = SESSION_ASSEMBLER.verify(plan, directory); if (modelSpec) await validateWorkspaceModel(modelSpec); return verified; } });
const workspaceCreation = new WorkspaceService({ store: workspaceStore, defaultParentDirectory: TAU_SETTINGS.projectsDir || APP_PATHS.scenarioDir, expandHome, assemble: assembleWorkspacePlan, validateModel: validateWorkspaceModel, assertReady: (id) => id ? workspaceMigration.assertWorkspaceReady(id) : workspaceMigration.assertSystemReady(), assertAllocationAllowed: (directory) => workspaceMigration.assertAllocationAllowed(directory) });
const workspaceDeletion = new WorkspaceDeletion({ store: workspaceStore, gate: workspaceGate, runtime: conversationRuntime, pythonCommand: PYTHON_EXECUTABLE.command, assertReady: (id) => workspaceMigration.assertWorkspaceReady(id), assertSystemReady: () => workspaceMigration.assertSystemReady(), historyDirectories: () => workspaceMigration.read().scopes.map((scope) => scope.sessionsDirectory), cleanupInvocations: (context) => removeExecutionMetadata(['cad', 'spatial'].map((kind) => path.join(PI_AGENT_DIR, 'executions', kind)), context, SESSIONS_DIR), verifyWorkspace: resolveSessionWorkspaceForDeletion, removeWorkspace: removeSessionWorkingDirectory });
const workspaceTransfer = new WorkspaceTransfer({ store: workspaceStore, runtime: conversationRuntime, gate: workspaceGate, assertSystemReady: () => workspaceMigration.assertSystemReady(), assertWorkspaceReady: (id) => workspaceMigration.assertWorkspaceReady(id) });
const workspaceHost = new WorkspaceHost({ store: workspaceStore, migration: workspaceMigration, runner: migrationRunner, gate: workspaceGate, runtime: conversationRuntime, creation: workspaceCreation, deletion: workspaceDeletion, transfer: workspaceTransfer, sessions: liveManager, assemble: assembleWorkspacePlan, validateModel: validateWorkspaceModel, beginOperation: () => updatePreparation.beginOperation() });
const rpcHandlers: RpcHandlerRegistry = {
  ...createPlatformRpcHandlers(currentPlatformOverview, async () => { fs.mkdirSync(APP_PATHS.logsDir, { recursive: true }); await openNativeTarget(APP_PATHS.logsDir); }, async (moduleId) => {
    if (PROJECT_AUTH || !isLoopbackHost(HOST)) throw new Error('Module folders can only be opened on the local workstation');
    const module = MODULE_REGISTRY.get(moduleId);
    if (!module) throw new Error('Module is unavailable');
    await openNativeTarget(resolveModuleDirectory(module.packageRoot));
  }),
  ...createAuthRpcHandlers({
    configured: AUTH_CONFIGURED,
    required: !!PROJECT_AUTH || !isLoopbackHost(HOST),
    getEnabled: () => authEnabled,
    setEnabled: (enabled) => { authEnabled = enabled; saveTauSetting('authEnabled', enabled); },
    notifyChanged: (enabled) => liveManager.broadcast({ type: 'event', event: { type: 'auth_changed', enabled } }),
    disconnectClients: () => {
      const timer = setTimeout(() => [...liveManager.clients].forEach((client) => { try { client.close(4001, 'Authentication enabled'); } catch {} }), 25);
      timer.unref?.();
    },
  }),
  ...createModelRpcHandlers({ agentDir: PI_AGENT_DIR, getAvailableModels, errorMessage, syncModels: async (sessionId) => {
    const session = liveManager.get(sessionId);
    if (!session) throw new Error('当前任务已关闭，请重新选择任务。');
    await session.modelSync.reload(session);
  } }),
  ...createModuleRpcHandlers({
    desktopMode: DESKTOP_MODE,
    installer: MODULE_INSTALLER,
    registry: MODULE_REGISTRY,
    authorizeModules: (roots) => moduleTrust.ensure(roots),
    forgetModules: (roots) => moduleTrust.forget(roots),
    reloadModules,
    setModuleEnabled,
    hasActiveModule: (moduleId) => [...liveManager.sessions.values()].some((session) => session.resolvedSessionPlan?.modules.some((module) => module.id === moduleId)),
    overview: currentPlatformOverview,
    errorMessage,
  }),
  ...createNativeRpcHandlers<PiRpcSession>({
    getLiveSession: (sessionId) => liveManager.get(sessionId),
    resolveAttachments: resolveSessionAttachments,
    attachmentBase64: (cwd, attachment) => fs.readFileSync(attachmentFilePath(cwd, attachment)).toString('base64'),
    buildAttachmentContext: (attachments) => buildAttachmentContext(attachments),
    validateGeoContexts: (session, contextIds) => contextIds === undefined ? [] : geoInteractionService.validateMessageContexts(session, contextIds),
    buildGeoContext: buildGeoPromptContext,
    validateCanvasContexts: (session, contextIds) => canvasService.validateContextIds(session, contextIds),
    buildCanvasContext: buildCanvasContextPrompt,
    parseModel: parseModelSpecToModel,
    syncModels: (session) => session.modelSync.reload(session),
    errorMessage,
    completeCommand: (command, response) => {
      if (command.clientCommandId && reliableCommandTypes.has(command.type || '')) rpcCommandLedger.settle(`${command.sessionId || ''}:${command.clientCommandId}`, { ...response, clientCommandId: command.clientCommandId });
    },
  }),
};
const reliableCommandTypes = new Set(Object.entries(rpcHandlers).flatMap(([type, handler]) => handler.reliable ? [type] : []));

type AuthResult = { ok: boolean; via: 'disabled' | 'basic' | 'cookie' | 'project' | 'none'; expiresAt?: number };

function checkBasicAuth(req: IncomingMessage) {
  if (!authEnabled) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString(), colon = decoded.indexOf(':');
  return colon !== -1 && decoded.slice(0, colon) === TAU_SETTINGS.user && decoded.slice(colon + 1) === TAU_SETTINGS.pass;
}

function checkAuth(req: IncomingMessage): AuthResult {
  if (PROJECT_AUTH) {
    try { return { ok: !!PROJECT_AUTH.authenticate(req.headers), via: 'project' }; }
    catch { return { ok: false, via: 'none' }; }
  }
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
  if (PROJECT_AUTH) return;
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

function errorMessage(error: unknown) { logHostError('operation_failed', error); return error instanceof Error ? error.message : String(error); }
function errorStatus(error: unknown) { return error && typeof error === 'object' && 'status' in error && typeof (error as StatusError).status === 'number' ? (error as StatusError).status! : 400; }
function sendAuthRequired(res: ServerResponse, req: IncomingMessage) {
  if (parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]) res.setHeader('Set-Cookie', buildSessionCookie('', { secure: isForwardedHttps(req), clear: true }));
  res.writeHead(401, { ...(PROJECT_AUTH ? {} : { 'WWW-Authenticate': 'Basic realm="Tau"' }), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

function readBody(req: IncomingMessage): Promise<RpcCommand> {
  const pathname = req.url?.split('?')[0];
  const limit = pathname === '/api/reports/pdf' || pathname === '/api/reports/pdf/download' ? REPORT_PDF_MAX_HTML_BYTES + 1024 * 1024
    : /\/geo-screenshots(?:\/[^/]+\/respond)?$/.test(pathname || '') ? 16 * 1024 * 1024 : 1024 * 1024;
  return readJsonBody(req, limit) as Promise<RpcCommand>;
}

function resolveLiveSessionPath(session: PiRpcSession | null | undefined, requestedPath?: string | null) {
  if (!session) { const error = new Error('Live session not found') as StatusError; error.status = 404; throw error; }
  const root = fs.realpathSync(path.resolve(session.cwd));
  const requested = expandHome(requestedPath || session.cwd);
  const candidate = path.resolve(path.isAbsolute(requested) ? requested : path.join(root, requested));
  let resolved = candidate;
  try { resolved = fs.realpathSync(candidate); } catch {}
  if (!isWithin(root, resolved)) { const error = new Error('Path is outside the active session directory') as StatusError; error.status = 403; throw error; }
  return resolved;
}

function openUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error('Invalid URL'));
  return openNativeTarget(url);
}

function currentPlatformOverview(sessionId?: string, frozenPlan?: import('../contracts/index.js').ResolvedSessionPlanV3) {
  const storage = { root: PI_AGENT_DIR, scenario: TAU_SETTINGS.projectsDir || APP_PATHS.scenarioDir };
  const session = sessionId ? liveManager.get(sessionId) : null;
  const selectedPlan = frozenPlan || session?.resolvedSessionPlan;
  const withTools = (overview: ReturnType<typeof platformOverview>) => ({ ...overview, modules: overview.modules.map((module) => {
    const identities = CORE_TOOL_BINDINGS[module.id];
    if (!identities) return module;
    const selected = selectedPlan?.modules.find((item) => item.id === module.id);
    const toolDiagnostics = identities.map(({ toolId, piName }) => {
      const base = { moduleId: module.id, toolId, piName, contractVersion: 'unknown', ...(session?.id ? { sessionId: session.id } : {}) };
      try {
        const contract = readToolContract(selected?.packageRoot || MODULE_REGISTRY.get(module.id)!.packageRoot, module.id, toolId);
        if (!contract) return { ...base, state: 'unverified' as const, reason: 'missing_contract' };
        return diagnoseTool(contract, selected, session && !session.terminating && session.child ? session.capabilityTracker.observation() : undefined, session?.entries || [], session?.id, approvedHostToolContract(module.id, toolId));
      } catch {
        return { ...base, state: 'unavailable' as const, reason: 'invalid_contract' };
      }
    });
    return { ...module, toolDiagnostics };
  }) });
  try {
    const plan = selectedPlan || SESSION_ASSEMBLER.assemble(DEFAULT_DOMAIN_ID, storage.scenario);
    return withTools(platformOverview(APP_PATHS, MODULE_REGISTRY, ASSET_RESOLVER, storage, new Set(plan.assets.map((asset) => asset.id))));
  } catch (error) {
    return withTools(platformOverview(APP_PATHS, MODULE_REGISTRY, ASSET_RESOLVER, storage, new Set(), errorMessage(error)));
  }
}

function currentSessionOptions() {
  const enabled = new Set(TAU_SETTINGS.enabledModuleIds);
  const defaultVersions = new Set(MODULE_INSTALLER.sources().map((source) => `${source.moduleId}:${path.basename(source.packageRoot!)}`));
  const platformModules = [...MODULE_REGISTRY.modules.values()].filter((module) => module.origin !== 'installed');
  const platformSources = platformModules.map((module) => ({ manifestPath: module.manifestPath, packageRoot: module.packageRoot, origin: module.origin }));
  const platformModuleIds = new Set(platformModules.map((module) => module.manifest.id));
  const defaultModuleIds = new Set(MODULE_REGISTRY.dependencyOrder('com.transportx.workbench').map((module) => module.manifest.id));
  return {
    schemaVersion: 1,
    modules: [
      ...MODULE_INSTALLER.catalog(),
      ...platformModules.filter((module) => module.origin === 'builtin' && module.enabled && module.manifest.type === 'capability' && !defaultModuleIds.has(module.manifest.id)).map((module) => ({ id: module.manifest.id, version: module.manifest.version, manifest: module.manifest, source: { manifestPath: module.manifestPath, packageRoot: module.packageRoot, origin: module.origin } })),
    ].map((entry) => {
      const runtime = moduleRuntimeCompatible(entry.manifest);
      let dependenciesCompatible = false;
      try {
        const selectedSources = MODULE_INSTALLER.sourcesForSelectionsWithDependencies([{ id: entry.id, version: entry.version }], platformModuleIds);
        const selectionRegistry = new ModuleRegistry(MODULE_REGISTRY.platformVersion).load([...platformSources, ...selectedSources]);
        dependenciesCompatible = selectionRegistry.errors.length === 0 && selectionRegistry.get(entry.id)?.enabled === true;
      } catch {}
      const compatible = runtime.compatible && dependenciesCompatible;
      return {
        id: entry.id,
        name: entry.manifest.name,
        ...(entry.manifest.presentation ? { presentation: entry.manifest.presentation } : {}),
        version: entry.version,
        type: entry.manifest.type,
        origin: entry.source.origin,
        compatible,
        enabledForNewSessions: compatible && (entry.source.origin === 'builtin' || enabled.has(entry.id)),
        selectedByDefault: compatible && enabled.has(entry.id) && defaultVersions.has(`${entry.id}:${entry.version}`),
        dependencies: entry.manifest.dependencies,
        assets: (entry.manifest.contributes?.assets || []).map((asset) => {
          const assetPath = path.resolve((ASSET_OVERRIDES as Record<string, string>)[asset.id] || path.resolve(entry.source.packageRoot!, asset.path));
          const integrityFile = asset.integrityFile ? (fs.existsSync(path.resolve(entry.source.packageRoot!, asset.integrityFile)) ? path.resolve(entry.source.packageRoot!, asset.integrityFile) : path.join(assetPath, path.basename(asset.integrityFile))) : '';
          let integrity: 'verified' | 'unverified' | 'missing' = asset.integrityFile ? 'missing' : 'unverified';
          if (asset.integrityFile && fs.existsSync(assetPath) && fs.existsSync(integrityFile)) try { verifyChecksumFile(assetPath, integrityFile); integrity = 'verified'; } catch { integrity = 'missing'; }
          return { id: asset.id, kind: asset.kind, configured: fs.existsSync(assetPath), integrity };
        }),
      };
    }),
  };
}

async function handleRpcCommandOnce(command: RpcCommand): Promise<RpcResponse> {
  let complete: () => void;
  try { complete = updatePreparation.beginOperation(); }
  catch { return { type: 'response', command: command.type, success: false, id: command.id, error: 'Host is preparing an update' }; }
  try { return await dispatchRpcCommand(command); } finally { complete(); }
}

async function dispatchRpcCommand(command: RpcCommand): Promise<RpcResponse> {
  if (!['get_auth', 'set_auth', 'open_logs_directory'].includes(command.type || '')) workspaceMigration.assertSystemReady();
  if (command.sessionId) {
    const session = liveManager.get(command.sessionId);
    if (!session?.workspaceId || !session.conversationId || workspaceHost.live(session.conversationId, false) !== session) throw Object.assign(new Error('The live conversation binding is no longer current.'), { code: 'conversation_not_active', status: 409 });
  }
  const success = (data?: unknown): RpcResponse => ({ type: 'response', command: command.type, success: true, id: command.id, ...(data === undefined ? {} : { data }) });
  const failure = (message: string): RpcResponse => {
    logHostEvent('warn', 'rpc_failed', { command: command.type, sessionId: command.sessionId, message });
    return { type: 'response', command: command.type, success: false, error: message, id: command.id };
  };
  const registered = typeof command.type === 'string' && Object.prototype.hasOwnProperty.call(rpcHandlers, command.type) ? rpcHandlers[command.type] : null;
  if (registered) return registered.handle(command, { success, failure });
  return failure(`Unknown command: ${command.type}`);
}

async function handleRpcCommand(input: RpcCommand): Promise<RpcResponse> {
  const command = parseRpcCommand(input);
  const clientCommandId = typeof command.clientCommandId === 'string' && command.clientCommandId.trim() ? command.clientCommandId.trim() : '';
  if (!clientCommandId || !reliableCommandTypes.has(command.type || '')) return handleRpcCommandOnce(command);
  if (clientCommandId.length > 200) return { success: false, error: 'clientCommandId is too long', delivery: 'rejected' };
  const key = `${command.sessionId || ''}:${clientCommandId}`;
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
  return rpcCommandLedger.run(key, async () => {
    const response = await handleRpcCommandOnce(command);
    if (response.delivery === 'unknown' || response.success === false) diagnoseCommand('command_delivery_unconfirmed', { sessionId: createHash('sha256').update(String(command.sessionId || '')).digest('hex').slice(0, 16), commandId: createHash('sha256').update(clientCommandId).digest('hex').slice(0, 16) });
    return response.success === false ? { ...response, clientCommandId } : {
      ...response,
      clientCommandId,
      delivery: 'accepted',
      acceptedAt: new Date().toISOString(),
    };
  }, createHash('sha256').update(JSON.stringify(canonical({ ...command, clientCommandId }))).digest('hex')).catch((error) => ({ success: false, error: errorMessage(error), code: error.code, delivery: 'rejected', clientCommandId }));
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
  res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${HOST_PROTOCOL_HEADER}`);
  return true;
}

const files = createFileApiHandlers({ expandHome, json, errorMessage });
const apiRouter = createApiRouter({
  beginOperation: (url) => url.pathname === '/api/health' ? () => {} : updatePreparation.beginOperation(),
  conversationOverview: (id) => { const target = workspaceHost.target(id), session = workspaceHost.live(id, false); return currentPlatformOverview(session?.id, workspaceStore.readPlan(target.directory, target.conversation)); },
  workspaces: workspaceHost, sessions: liveManager, snapshotSchemaVersion: SESSION_SNAPSHOT_SCHEMA_VERSION, health: () => ({ status: 'ok', product: 'TransportX Agent', role: 'agent-host', protocolVersion: AGENT_HOST_PROTOCOL_VERSION, dataState: workspaceMigration.status().dataState, migration: workspaceMigration.status(), liveSessionCount: liveManager.sessions.size, lanUrl, tailscaleUrl: tailscaleUrl || undefined, platform: process.platform, cad: cadHealth ? { status: cadHealth.ok ? 'ok' : 'unavailable', ...(cadHealth.version ? { version: cadHealth.version } : {}), ...(cadHealth.reason ? { reason: cadHealth.reason } : {}) } : { status: 'unknown' } }), sessionOptions: currentSessionOptions, json, errorMessage, errorStatus, readBody, serveFiles: files.serveFiles, serveFileContent: files.serveFileContent, serveResources: files.serveResources, servePreview: files.servePreview, serveRawFile: files.serveRawFile, openNative: files.openNative, handleRpc: handleRpcCommand, renderReportPdf,
  listAttachments: listSessionAttachments,
  uploadAttachments: saveUploadedAttachments,
  deleteAttachment: deleteSessionAttachment,
  citation: citationService,
  spatial: spatialAnalysisService,
  video: videoService,
  geo: geoInteractionService,
  canvas: canvasService,
  cad: cadService,
});

function handleApiRoute(req: IncomingMessage, res: ServerResponse, urlPath: string) {
  if (new URL(req.url || urlPath, 'http://localhost').pathname !== '/api/health') {
    let complete: () => void;
    try { complete = updatePreparation.beginOperation(); }
    catch { return json(res, 503, { error: 'Host is preparing an update', code: 'update_preparing' }); }
    // Check the lock here; the router retains its own lease until the
    // handler settles, even if the client disconnects during a write.
    complete();
  }
  const originAllowed = setCorsForAllowedOrigin(req, res);
  if (req.method === 'OPTIONS') { if (!originAllowed) return json(res, 403, { error: 'Origin not allowed' }); res.writeHead(200); res.end(); return; }
  if (!originAllowed) return json(res, 403, { error: 'Origin not allowed' });
  const parsed = new URL(`http://localhost${req.url || urlPath}`);
  if (!parsed.pathname.startsWith('/api/internal/') && ['POST', 'PATCH', 'DELETE'].includes(req.method || '') && req.headers[HOST_PROTOCOL_HEADER.toLowerCase()] !== String(AGENT_HOST_PROTOCOL_VERSION)) return json(res, 426, { code: 'unsupported_client', error: 'Client protocol is incompatible. Upgrade or restart the client.', expectedProtocolVersion: AGENT_HOST_PROTOCOL_VERSION });
  const diagnostic = parsed.pathname === '/api/health' || parsed.pathname.startsWith('/api/migration') || /^\/api\/workspaces\/[^/]+\/(migration|runtime-diagnostics|runtime-recovery)(?:\/resolve)?$/.test(parsed.pathname);
  if (!diagnostic && parsed.pathname !== '/api/rpc') {
    try { workspaceMigration.assertSystemReady(); }
    catch (error) { return json(res, 503, { code: 'system_not_ready', error: (error as Error).message, migration: workspaceMigration.status() }); }
  }
  try {
    if (handleGeoResourceRoute(req, res, parsed.pathname, { getSession: (id) => workspaceHost.live(id) })) return;
    if (handleVideoResourceRoute(req, res, parsed.pathname, { getSession: (id) => workspaceHost.live(id), authorize: (id, resourceId) => { videoService.loadManifest(workspaceHost.live(id)!, resourceId); } })) return;
    if (handleCitationResourceRoute(req, res, parsed.pathname, { getSession: (id) => workspaceHost.live(id) })) return;
  } catch (error) { return json(res, ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '') ? 404 : errorStatus(error), { error: errorMessage(error), code: (error as { code?: string }).code }); }
  if (!apiRouter.dispatch(req, res, parsed)) json(res, 404, { error: 'Not found' });
}

const staticHandler = createStaticHandler({ reactStaticDir: REACT_STATIC_DIR, mimeTypes: MIME_TYPES as Record<string, string>, authEnabled: () => authEnabled, publicStatic: !!PROJECT_AUTH, checkAuth, sendAuthRequired, maybeSetSessionCookie, handleApi: handleApiRoute });
const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
  const pathname = (req.url || '/').split('?')[0];
  if (pathname.startsWith('/api/auth/')) {
    if (!PROJECT_AUTH && pathname === '/api/auth/session' && req.method === 'GET') return json(res, 200, { enabled: false, username: null });
    if (PROJECT_AUTH) { void PROJECT_AUTH.handle(req, res, isAllowedApiOrigin(req)).catch((error) => { logHostError('project_auth_failed', error); json(res, 503, { error: 'Login service unavailable' }); }); return; }
  }
  staticHandler.serveStaticFile(req, res);
});
const socketHandler = attachWebSocketHandler({ server, sessions: liveManager, isAllowedOrigin: isAllowedApiOrigin, authEnabled: () => authEnabled, recheckAuthentication: !!PROJECT_AUTH, suppressChallenge: !!PROJECT_AUTH, isAuthenticated: (request) => checkAuth(request).ok });
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
  const endpointHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST === '::' ? '::1' : HOST;
  const endpoint = `http://${endpointHost.includes(':') ? `[${endpointHost}]` : endpointHost}:${port}`;
  lanUrl = loopback ? endpoint : `http://${localIp}:${port}`; tailscaleUrl = tailscaleIp ? `http://${tailscaleIp}:${port}` : '';
  liveManager.runtime.endpoints.citation = endpoint;
  liveManager.runtime.endpoints.spatial = endpoint;
  liveManager.runtime.endpoints.video = endpoint;
  liveManager.runtime.endpoints.geo = endpoint;
  liveManager.runtime.endpoints.canvas = endpoint;
  liveManager.runtime.endpoints.moduleAuthoring = endpoint;
  liveManager.runtime.endpoints.cad = endpoint;
}

let releaseHostWriter: (() => void) | null = null;
function listen(port: number, attemptsLeft = 10) {
  initializeHostLogging(APP_PATHS.logsDir);
  validateHostAccess(TAU_SETTINGS, !!PROJECT_AUTH);
  if (!releaseHostWriter) {
    try { releaseHostWriter = acquireWriteLease(path.join(PI_AGENT_DIR, 'host')); }
    catch (error) { logHostError('host_writer_unavailable', error); }
    const release = (force = false) => {
      // A background CAD health probe can still be settling while normal
      // server shutdown completes. Once the process is exiting, this writer
      // must release its own lease regardless of that transient probe.
      if (!force && (liveManager.sessions.size || spatialAnalysisService.activeCount || videoService.activeCount || cadService.activeCount)) return;
      releaseHostWriter?.();
      releaseHostWriter = null;
    };
    server.once('close', () => release());
    process.once('exit', () => release(true));
    if (releaseHostWriter) { const complete = updatePreparation.beginOperation(); void workspaceMigration.initialize().then(() => workspaceHost.startConversions()).catch((error) => logHostError('workspace_migration_failed', error)).finally(complete); }
  }
  server.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && attemptsLeft > 0) { console.log(`[Tau] Port ${port} in use, trying ${port + 1}...`); server.removeAllListeners('error'); listen(port + 1, attemptsLeft - 1); }
    else { console.error(`[Tau] Failed to start: ${error.message}`); process.exit(1); }
  });
  server.listen(port, HOST, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    logHostEvent('info', 'host_ready', { port: actualPort, platform: process.platform });
    computeUrls(actualPort);
    console.log(`[Tau] Server running on ${lanUrl}${tailscaleUrl ? `  •  Tailscale: ${tailscaleUrl}` : ''}`);
    console.log(`[Tau] React application: ${REACT_STATIC_DIR} (/)`);
    if (DESKTOP_MODE || ARGS['ready-json'] === true) console.log(JSON.stringify({ type: 'transportx-agent-host-ready', port: actualPort, host: HOST, protocolVersion: AGENT_HOST_PROTOCOL_VERSION, pid: process.pid }));
    if (ARGS.open) openUrl(lanUrl).catch(() => {});
  });
}

let shuttingDown = false;
async function verifyIdleAndSave() {
  const busy = () => { throw Object.assign(new Error('Host is busy'), { code: 'host_busy' }); };
  if (shuttingDown || spatialAnalysisService.activeCount || videoService.activeCount || cadService.activeCount) busy();
  const sessions = [...liveManager.sessions.values()];
  for (const session of sessions) {
    if (session.isStreaming || session.isCompacting || session.terminating || session.transport.pendingCount || session.pendingExtensionUiRequests.size) busy();
    if (session.child) {
      const response = await session.send({ type: 'get_state' }, { timeoutMs: 5000 });
      const state = response.data as { isStreaming?: boolean; isCompacting?: boolean; pendingMessageCount?: number } | undefined;
      if (!response.success || typeof state?.isStreaming !== 'boolean' || typeof state.isCompacting !== 'boolean' || typeof state.pendingMessageCount !== 'number') throw new Error('Pi idle state could not be confirmed');
      if (state.isStreaming || state.isCompacting || state.pendingMessageCount) busy();
    }
    session.persistPendingSessionName();
    if (session.pendingSessionNamePersistence && session.userMessages.length) throw new Error('Session name could not be saved');
  }
}

function attachDesktopUpdateChannel() {
  const channel = desktopMessageChannel();
  if (!channel) return;
  channel.onMessage((value) => {
    const message = value as { type?: string; id?: string };
    if (message?.type === 'transportx-agent-host-stop') { void shutdown('desktop_stop'); return; }
    if (!message || typeof message.id !== 'string') return;
    const id = message.id;
    if (message.type === 'transportx-update-cancel') { updatePreparation.cancel(id); return; }
    if (message.type !== 'transportx-update-stop') return;
    void (async () => {
      try {
        await updatePreparation.prepare(id, verifyIdleAndSave);
        const sessions = [...liveManager.sessions.values()];
        const results = await Promise.allSettled(sessions.map((session) => session.stopForUpdate()));
        if (results.some((result) => result.status === 'rejected')) throw new Error('Pi stop was not confirmed');
        updatePreparation.assertPrepared(id);
        for (const session of sessions) {
          session.persistPendingSessionName();
          if (session.pendingSessionNamePersistence && session.userMessages.length) throw new Error('Session save was not confirmed');
        }
        shuttingDown = true;
        socketHandler.close();
        for (const client of liveManager.clients) client.terminate();
        wss.close();
        server.close(() => {
          channel.send({ type: 'transportx-update-stopped', id, ok: true });
          // Let the acknowledgement reach the parent before terminating.
          setImmediate(() => process.exit(0));
        });
        server.closeIdleConnections();
        // Writes have settled under the gate. Remaining connections can only
        // be static/resource reads and must not delay the confirmed shutdown.
        server.closeAllConnections();
      } catch (error) {
        updatePreparation.cancel(id);
        channel.send({ type: 'transportx-update-stopped', id, ok: false, code: (error as { code?: string }).code === 'host_busy' ? 'host_busy' : 'prepare_failed' });
      }
    })();
  });
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true; console.log(`\n[Tau] Shutting down (${signal}); terminating ${liveManager.sessions.size} Pi session(s)...`);
  logHostEvent('info', 'host_shutdown', { signal, sessions: liveManager.sessions.size });
  socketHandler.close(); try { wss.close(); } catch {}
  try {
    await Promise.all([spatialAnalysisService.terminateAll(), videoService.terminateAll(), cadService.terminateAll(), conversationRuntime.shutdown()]);
    server.close(() => process.exit(process.exitCode || 0));
    setTimeout(() => process.exit(process.exitCode || 0), 2500).unref();
  } catch (error) {
    console.error('[Tau] Shutdown could not confirm process exit:', error);
    process.exitCode = 1;
    // A Python child may not acknowledge termination on some hosts. The Host
    // is already shutting down, so do not let that child keep the writer lease
    // alive indefinitely.
    server.close(() => process.exit(process.exitCode || 1));
    setTimeout(() => process.exit(process.exitCode || 1), 2500).unref();
  }
}
function startCli() {
  validateHostAccess(TAU_SETTINGS, !!PROJECT_AUTH);
  if (DESKTOP_MODE) attachDesktopUpdateChannel();
  const runtime = inspectPiRuntime(PI_COMMAND, PI_COMMAND_ARGS); liveManager.setPiVersion(runtime.version); console.log(`[Tau] Pi runtime: ${runtime.command} ${runtime.version}`);
  console.log(`[Tau] Modules: ${MODULE_REGISTRY.enabled().length} enabled, ${MODULE_REGISTRY.errors.length} error(s)`);
  process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => { for (const session of liveManager.sessions.values()) try { session.child?.kill('SIGTERM'); } catch {} });
  process.on('uncaughtException', (error) => { console.error(error); process.exitCode = 1; shutdown('uncaughtException'); }); process.on('unhandledRejection', (error) => { logHostError('unhandled_rejection', error); console.error(error); });
  const parentPid = Number(ARGS['parent-pid'] || process.env.TAU_PARENT_PID || 0);
  if (parentPid > 0) {
    const watcher = setInterval(() => { try { process.kill(parentPid, 0); } catch { clearInterval(watcher); shutdown('parent_exit'); } }, 1000);
    watcher.unref();
  }
  listen(PORT);
}

function _setRuntimeCoordinationForTest(directory: string) { if (server.listening || liveManager.sessions.size || releaseHostWriter) throw new Error('Configure test coordination before starting Host.'); Object.assign(workspaceGate, { coordinationDirectory: path.resolve(directory) }); }
function _setAuthForTest(enabled: boolean) { authEnabled = !!enabled; }
function _setCredentialsForTest(user: string, pass: string) { TAU_SETTINGS.user = user; TAU_SETTINGS.pass = pass; }
function _issueSessionTokenForTest(expiresAtSeconds?: number) { return issueSessionToken(expiresAtSeconds); }

module.exports = { parseArgs, expandHome, loadTauSettings, modelLabel, normalizeModel, parseModelSpecToModel, getAvailableModels, makeId, PiRpcSession, LiveSessionManager, liveManager, isWithinPath: isWithin, resolveLiveSessionPath, openUrl, handleRpcCommand, isAllowedApiOrigin, setCorsForAllowedOrigin, handleApiRoute, serveStaticFile: staticHandler.serveStaticFile, serveReactStaticFile: staticHandler.serveReactStaticFile, server, wss, workspaceHost, conversationRuntime, computeUrls, listen, startCli, SESSIONS_DIR, PI_AGENT_DIR, checkAuth, SESSION_COOKIE_NAME, _setAuthForTest, _setCredentialsForTest, _issueSessionTokenForTest, _setSpawnPiForTest, _setRuntimeCoordinationForTest };
