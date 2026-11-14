import type { TestContext } from 'node:test';

async function createHttpHostFixture(t: TestContext) {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const crypto = require('node:crypto');
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const { toPosixPath } = require('../../bin/util/path.js');

  process.env.TAU_HOST = '127.0.0.1';

  process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-http-'));
  process.env.TAU_USER_DATA_DIR = process.env.PI_CODING_AGENT_DIR;
  process.env.TAU_RUNTIME_COORDINATION_DIR = path.join(process.env.TAU_USER_DATA_DIR, 'runtime-guards');
  require('../../bin/diagnostic-log.js').initializeHostLogging(path.join(process.env.TAU_USER_DATA_DIR, 'logs'));

  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');
  process.env.TAU_USER = 'test-user';
  process.env.TAU_PASS = 'test-pass';
  const settingsFile = path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ tau: { authEnabled: false } }));

  const PROJECTS_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'projects');

  process.env.TAU_PROJECTS_DIR = PROJECTS_DIR;

  const { server, listen, workspaceHost, computeUrls, handleRpcCommand, liveManager, workspaceStore, SESSIONS_DIR, PiRpcSession, _setSpawnPiForTest } = require('../../bin/tau.js');
  const { createApiRouter } = require('../../bin/api-routes.js');

  let base = '';
  const request = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { 'X-TransportX-Protocol': '2', ...init.headers } });
  const { writeJsonAtomic } = require('../../bin/util/json-storage.js');
  function registerSession(session: any) {
    const store = workspaceStore, at = '2026-10-25T00:00:00.000Z';
    if (session.cwd === '/tmp/proj') session.cwd = path.join(PROJECTS_DIR, session.id);
    fs.mkdirSync(session.cwd, { recursive: true }); session.cwd = toPosixPath(fs.realpathSync(session.cwd));
    const catalog = store.readCatalog(); let entry = catalog.entries.find((item: any) => item.path === session.cwd);
    let manifest: any;
    if (entry) manifest = store.readWorkspace(entry.workspaceId).manifest;
    else {
      entry = { workspaceId: `ws_${crypto.randomUUID()}`, path: session.cwd, creationRequestId: session.id, creationInputSha256: crypto.createHash('sha256').update(session.cwd).digest('hex'), state: 'ready', deletion: null }; catalog.entries.push(entry); catalog.revision++;
      manifest = { schemaVersion: 1, id: entry.workspaceId, revision: 0, name: session.id, createdAt: at, updatedAt: at, defaultsRevision: 0, defaults: { domainId: null, modelSpec: null, profile: null }, citationRegistryId: session.id, conversations: [] };
    }
    session.workspaceId = entry.workspaceId;
    const key = `http/${session.conversationId}.jsonl`; session.sessionFile = path.join(SESSIONS_DIR, key);
    fs.mkdirSync(path.dirname(session.sessionFile), { recursive: true });
    fs.writeFileSync(session.sessionFile, JSON.stringify({ type: 'session', id: `native-${session.id}`, timestamp: at, cwd: session.cwd }) + '\n');
    // These HTTP service fixtures mock an already-authorized runtime; lifecycle exclusion is tested with real Pi in session-boundaries and Chrome smoke.
    session.lifecycle = { isReady: () => true, isCurrent: () => true, closed: async () => {} };
    session.citationRegistryId = manifest.citationRegistryId;
    fs.mkdirSync(path.join(session.cwd, '.tau/conversations', session.conversationId), { recursive: true });
    writeJsonAtomic(path.join(session.cwd, '.tau/conversations', session.conversationId, 'plan.json'), { schemaVersion: 3, platform: { name: 'TransportX Agent', version: '3.23.2' }, domain: { id: 'com.transportx.workbench', version: '1.4.1' }, profile: { schemaVersion: 1, task: { kind: 'data-query', expectedOutputs: ['answer'] }, modules: { selectionMode: 'explicit', selected: [] } }, modules: [], assets: [], runtime: {}, workspace: session.cwd, createdAt: at });
    manifest.conversations.push({ id: session.conversationId, creationRequestId: null, creationInputSha256: null, name: session.id, createdAt: at, updatedAt: at, defaultsRevision: null, modelSpec: null, appendSystemPrompt: '', state: 'ready', history: { key, headerId: `native-${session.id}` }, plan: { path: `conversations/${session.conversationId}/plan.json`, source: 'created' }, privateState: 'isolated', lastStartFailure: null, deletion: null }); manifest.revision++;
    writeJsonAtomic(path.join(session.cwd, '.tau/workspace.json'), manifest); writeJsonAtomic(store.catalogFile, catalog);
    liveManager.sessions.set(session.id, session);
  }
  function geoPublication(session: any, resourceId: string) {
    const resource = JSON.parse(fs.readFileSync(path.join(session.cwd, '.tau/geo-resources', resourceId, 'manifest.json'), 'utf8'));
    session.entries.push({ type: 'message', message: { role: 'toolResult', toolName: 'publish_geodata', details: { kind: 'tau-geo-resource', resource } } });
  }
  function persistResourceContext(session: any) {
    const file = path.join(session.cwd, '.tau/conversations', session.conversationId, 'plan.json');
    const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    writeJsonAtomic(file, { ...plan, ...session.resolvedSessionPlan, modules: (session.resolvedSessionPlan?.modules || []).map((module: any) => ({ version: '1.0.0', type: 'capability', origin: 'builtin', packageRoot: session.cwd, entrypoints: [], ...module })), assets: (session.resolvedSessionPlan?.assets || []).map((asset: any) => ({ moduleId: 'com.transportx.video', moduleVersion: '1.0.0', integrityStatus: 'unverified', ...asset })) });
    session.entries.forEach((entry: any, index: number) => fs.appendFileSync(session.sessionFile, JSON.stringify({ ...entry, id: `resource-${index}`, parentId: index ? `resource-${index - 1}` : null }) + '\n'));
    liveManager.sessions.delete(session.id);
  }
  function videoAuthorization(session: any, resourceId: string) {
    const resource = JSON.parse(fs.readFileSync(path.join(session.cwd, '.tau/video-resources', resourceId, 'manifest.json'), 'utf8'));
    const assetRoot = path.join(process.env.TAU_USER_DATA_DIR!, 'test-assets', session.id); fs.mkdirSync(path.join(assetRoot, 'videos'), { recursive: true });
    fs.copyFileSync(path.join(session.cwd, '.tau/video-resources', resourceId, 'video.mp4'), path.join(assetRoot, resource.sourceRelativePath));
    writeJsonAtomic(path.join(assetRoot, 'videos.json'), { schemaVersion: 1, videos: [{ videoId: resource.videoId, cameraId: 'camera_001', title: 'Test recording', locationName: 'Test', startTime: resource.recordingStartTime, endTime: resource.recordingEndTime, file: resource.sourceRelativePath, mimeType: 'video/mp4' }] });
    session.resolvedSessionPlan = { modules: [{ id: 'com.transportx.video' }], assets: [{ id: resource.sourceAssetId, kind: 'data', path: assetRoot }] };
  }


  const PROJ_DIR = path.join(SESSIONS_DIR, '--tmp--httpproj');

  function writeSessionFileAt(projectDir: string, fileName: string, lines: Array<Record<string, unknown>>) {
    fs.mkdirSync(projectDir, { recursive: true });
    const filePath = path.join(projectDir, fileName);
    fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    return filePath;
  }

  function fakeSession(id: string): any {
    return {
      id,
      conversationId: `conv_${crypto.randomUUID()}`,
      cwd: '/tmp/proj',
      model: 'openai/gpt-5.5',
      modelSpec: '',
      thinkingLevel: 'off',
      isStreaming: false,
      isCompacting: false,
      autoCompactionEnabled: true,
      sessionFile: `/tmp/${id}.jsonl`,
      sessionName: null,
      contextUsage: null,
      entries: [],
      pendingExtensionUiRequests: new Map(),
      serviceTokens: { citation: 'citation-token', spatial: 'spatial-token', video: 'video-token', geo: 'geo-token', canvas: 'canvas-token', cad: 'cad-token' },
      manager: liveManager,
      metadata: () => ({ id, cwd: '/tmp/proj', model: 'openai/gpt-5.5', isStreaming: false, sessionFile: `/tmp/${id}.jsonl` }),
      liveMetadata: () => ({ id, model: 'openai/gpt-5.5', isStreaming: false, isCompacting: false, autoCompactionEnabled: true }),
      snapshot: () => ({ schemaVersion: 1, session: { id }, entries: [], model: 'openai/gpt-5.5', isStreaming: false, sessionFile: `/tmp/${id}.jsonl` }),
      terminate: async () => { },
      send: async () => ({ data: { commands: [] } }),
      registerPendingMessage: () => { },
      discardPendingMessage: () => { },
      abortGeoInteraction: () => { },
    };
  }

  function makeFakeChild() {
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 12345;
    child.kill = () => { };
    return child;
  }

  async function jsonBody(res: Response) {
    return JSON.parse(await res.text());
  }

  function fakeVideoResource(cwd: string, resourceId: string, bytes: Buffer) {
    const dir = path.join(cwd, '.tau', 'video-resources', resourceId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'video.mp4'), bytes);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      resourceId,
      videoId: 'video_001',
      kind: 'source',
      relativePath: 'video.mp4',
      mimeType: 'video/mp4',
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      recordingStartTime: '2026-08-16T08:00:00+08:00',
      recordingEndTime: '2026-08-16T08:01:00+08:00',
      durationSeconds: 60,
      sourceAssetId: 'data:demo-videos',
      sourceRelativePath: 'videos/camera_001.mp4',
    }));
  }

  t.after(() => new Promise<void>((resolve) => {
    server.close(resolve);
  }));

  t.after(() => {
    const log = path.join(process.env.PI_CODING_AGENT_DIR!, 'logs', 'runtime.jsonl');
    if (fs.existsSync(log)) for (const line of fs.readFileSync(log, 'utf8').trim().split('\n')) {
      if (JSON.parse(line).event === 'native_process_probe') t.diagnostic(line);
    }
    fs.rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
  });

  await new Promise<void>((resolve) => {
    server.once('listening', () => {
      const port = server.address().port;
      computeUrls(port);
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
    listen(0);
  });
  const initialized = Date.now();
  while ((await (await request(`${base}/api/health`)).json()).dataState !== 'ready') { if (Date.now() - initialized > 5000) throw new Error('HTTP fixture inventory did not initialize'); await new Promise((resolve) => setTimeout(resolve, 20)); }

  return {
    base, request, liveManager, workspaceStore, SESSIONS_DIR, PROJECTS_DIR, settingsFile, PiRpcSession, handleRpcCommand, createApiRouter,
    registerSession, geoPublication, persistResourceContext, videoAuthorization,
    fakeSession, makeFakeChild, jsonBody, fakeVideoResource, writeJsonAtomic,
  };
}

export type HttpHostFixture = Awaited<ReturnType<typeof createHttpHostFixture>>;
module.exports = { createHttpHostFixture };
