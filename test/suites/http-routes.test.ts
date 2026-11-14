const { test } = require('node:test') as typeof import('node:test');

test('HTTP enforces resource ownership, request limits, reliable delivery and safe history recovery', async (t) => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const crypto = require('node:crypto');
  const http = require('node:http');
  const { PassThrough } = require('node:stream');
  const { toPosixPath } = require('../../bin/util/path.js');
  const { testSymlink } = require('../support/symlink.ts');
  const { createHttpHostFixture } = require('../support/http-host-fixture.ts');
  const { assertHttpResourceAuthorization } = require('../support/http-resource-scenarios.ts');
  const { assertHttpRpcDelivery } = require('../support/http-rpc-scenarios.ts');
  const { assertHttpResponseFailures } = require('../support/http-response-scenarios.ts');

  const fixture: import('../support/http-host-fixture.ts').HttpHostFixture = await createHttpHostFixture(t);
  const { base, request, liveManager, workspaceStore, SESSIONS_DIR, settingsFile, registerSession, fakeSession, jsonBody, writeJsonAtomic } = fixture;

  // bounded JSON requests preserve UTF-8 and return readable 413 responses
  {
    liveManager.sessions.clear();
    const { readJsonBody } = require('../../bin/http/request.js');
    const req = new PassThrough() as any;
    const parsed = readJsonBody(req, 100);
    const value = Buffer.from('{"text":"道路"}');
    for (const byte of value) req.write(Buffer.from([byte]));
    req.end();
    assert.deepEqual(await parsed, { text: '道路' });
    const over = new PassThrough() as any;
    const rejected = assert.rejects(readJsonBody(over, 4), (error: any) => error.status === 413);
    over.write(Buffer.from('12345'));
    await rejected;
    for (let index = 0; index < 100; index++) over.write(Buffer.alloc(1024));
    over.end();
    const oversizedBody = JSON.stringify({ type: 'prompt', message: 'x'.repeat(1024 * 1024) });
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const client = http.request(`${base}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(oversizedBody), 'X-TransportX-Protocol': '2' } }, (incoming: any) => {
        let body = ''; incoming.setEncoding('utf8'); incoming.on('data', (chunk: string) => { body += chunk; }); incoming.on('end', () => resolve({ status: incoming.statusCode || 0, body }));
      });
      client.on('error', reject); client.end(oversizedBody);
    });
    assert.equal(response.status, 413);
    assert.match(JSON.parse(response.body).error, /too large/);
    await request(`${base}/api/session-history?filePath=invalid&api_key=private-query-secret`);
    const log = fs.readFileSync(path.join(process.env.TAU_USER_DATA_DIR, 'logs', 'runtime.jsonl'), 'utf8');
    assert.ok(log.includes('host_logging_started'));
    assert.doesNotMatch(log, /private-query-secret/);
  }

  // multipart limits return a readable error over HTTP
  {
    liveManager.sessions.clear();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-upload-http-limit-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const session = fakeSession('tau_upload_limit');
    session.cwd = cwd;
    registerSession(session);
    const form = new FormData();
    for (let index = 0; index < 21; index++) form.append('file', new Blob(['x']), `${index}.txt`);
    const response = await request(`${base}/api/conversations/${session.conversationId}/attachments?source=picker`, { method: 'POST', body: form });
    assert.equal(response.status, 413);
    assert.match((await jsonBody(response)).error, /20 file limit/);
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.tau', 'attachment-tmp')), []);
  }

  // A conversation can move between workspaces and continue standalone with its history identity intact
  {
    liveManager.sessions.clear();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-http-move-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const firstCwd = path.join(root, 'first'), secondCwd = path.join(root, 'second');
    fs.mkdirSync(firstCwd); fs.mkdirSync(secondCwd);
    const first = fakeSession('tau_move_first'), second = fakeSession('tau_move_second');
    first.cwd = firstCwd; second.cwd = secondCwd;
    registerSession(first); registerSession(second);
    const entry = (cwd: string) => workspaceStore.readCatalog().entries.find((item: any) => item.path === toPosixPath(fs.realpathSync(cwd))).workspaceId;
    const firstWorkspace = entry(firstCwd), secondWorkspace = entry(secondCwd);
    const attachmentId = 'att_abcdefghijkl', attachmentBytes = Buffer.from('moved attachment');
    const attachmentDir = path.join(firstCwd, 'attachments', attachmentId); fs.mkdirSync(attachmentDir, { recursive: true });
    fs.writeFileSync(path.join(attachmentDir, 'note.txt'), attachmentBytes);
    writeJsonAtomic(path.join(firstCwd, '.tau/attachments.json'), { version: 1, attachments: [{ id: attachmentId, name: 'note.txt', relativePath: `attachments/${attachmentId}/note.txt`, mimeType: 'text/plain', size: attachmentBytes.length, sha256: crypto.createHash('sha256').update(attachmentBytes).digest('hex'), kind: 'document', source: 'picker', status: 'ready', sourceConversationId: first.conversationId }] });
    writeJsonAtomic(path.join(firstCwd, '.tau/conversations', first.conversationId, 'attachment-message-refs.json'), { version: 1, refs: [{ text: 'moved', attachmentIds: [attachmentId] }] });
    liveManager.sessions.delete(first.id); liveManager.sessions.delete(second.id);
    const move = (target: string, stopCurrent = false) => request(`${base}/api/conversations/${first.conversationId}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, ...(stopCurrent ? { stopCurrent } : {}) }) });
    let response = await move(secondWorkspace);
    if (response.status !== 200) assert.fail(await response.text());
    let moved = await jsonBody(response);
    assert.equal(moved.workspace.id, secondWorkspace);
    assert.equal(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `http/${first.conversationId}.jsonl`), 'utf8').split('\n')[0]).cwd, toPosixPath(fs.realpathSync(secondCwd)));
    assert.equal(JSON.parse(fs.readFileSync(path.join(secondCwd, '.tau/conversations', first.conversationId, 'plan.json'), 'utf8')).workspace, toPosixPath(fs.realpathSync(secondCwd)));
    assert.equal(fs.existsSync(path.join(secondCwd, 'attachments', attachmentId, 'note.txt')), true);
    assert.equal(workspaceStore.readWorkspace(firstWorkspace).manifest.conversations.some((record: any) => record.id === first.conversationId), false);
    assert.equal(workspaceStore.readWorkspace(secondWorkspace).manifest.conversations.some((record: any) => record.id === first.conversationId), true);
    const store = workspaceStore, edit = store.editWorkspace.bind(store);
    store.editWorkspace = async (id: string, ...args: any[]) => { if (id === secondWorkspace) throw Object.assign(new Error('Interrupted after header commit'), { code: 'EIO' }); return edit(id, ...args); };
    try { response = await move(firstWorkspace); assert.equal(response.status, 409); assert.equal((await jsonBody(response)).code, 'EIO'); } finally { store.editWorkspace = edit; }
    assert.equal((await jsonBody(await request(`${base}/api/health`))).dataState, 'initializing');
    assert.equal((await request(`${base}/api/workspaces`)).status, 503, 'pending moves cannot expose a duplicate business projection');
    assert.equal((await request(`${base}/api/migration/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
    const recovered = await jsonBody(await request(`${base}/api/workspaces`));
    assert.equal(recovered.workspaces.flatMap((workspace: any) => workspace.conversations).filter((item: any) => item.record.id === first.conversationId).length, 1, 'inventory recovers the durable move before checking identity uniqueness');
    assert.equal(store.readWorkspace(firstWorkspace).manifest.conversations.some((record: any) => record.id === first.conversationId), true);
    assert.equal(store.readWorkspace(secondWorkspace).manifest.conversations.some((record: any) => record.id === first.conversationId), false);
    response = await move('standalone');
    assert.equal(response.status, 200);
    moved = await jsonBody(response);
    assert.equal(moved.standalone, true);
    const standalone = workspaceStore.readCatalog().entries.find((item: any) => item.kind === 'standalone' && item.workspaceId === moved.workspace.id);
    assert.ok(standalone);
    const index = await jsonBody(await request(`${base}/api/workspaces`));
    assert.equal(index.workspaces.some((workspace: any) => workspace.kind === 'standalone' && workspace.conversations.some((item: any) => item.record.id === first.conversationId)), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `http/${first.conversationId}.jsonl`), 'utf8').split('\n')[0]).cwd, standalone.path);
    response = await move(firstWorkspace);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, `http/${first.conversationId}.jsonl`), 'utf8').split('\n')[0]).cwd, toPosixPath(fs.realpathSync(firstCwd)));
    assert.equal(workspaceStore.readWorkspace(firstWorkspace).manifest.conversations.some((record: any) => record.id === first.conversationId), true);
  }

  // Internal service tokens authenticate independently of user credentials and require scope
  {
    liveManager.sessions.clear();
    const { _setAuthForTest } = require('../../bin/tau.js');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-service-auth-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const session = fakeSession('tau_internal_auth') as any;
    session.cwd = cwd;
    session.resolvedSessionPlan = { modules: [{ id: 'com.transportx.canvas', canvasViews: [] }, { id: 'com.transportx.document', canvasViews: [{ adapterId: 'com.transportx.canvas.document', kind: 'document', protocolVersion: '1.0' }] }] };
    fs.writeFileSync(path.join(cwd, 'counts.csv'), 'road,count\nA,12\n');
    const { CanvasService } = require('../../bin/canvas-service.js');
    const canvas = new CanvasService({}, (_session: unknown, requested: string) => path.resolve(cwd, requested));
    const presentation = canvas.present(session, { adapterId: 'com.transportx.canvas.document', resource: { scope: 'session-file', path: 'counts.csv' } });
    session.entries.push({ message: { details: { canvas: presentation } } });
    const context = canvas.createContext(session, { viewId: presentation.viewId, revision: presentation.revision });
    session.activeCanvasContextIds = [context.contextId];
    registerSession(session);
    const credentials = { Authorization: 'Basic ' + Buffer.from('test-user:test-pass').toString('base64') };
    const setAuth = (enabled: boolean) => request(`${base}/api/rpc`, { method: 'POST', headers: credentials, body: JSON.stringify({ type: 'set_auth', enabled }) });
    const saved = fs.readFileSync(settingsFile);
    fs.renameSync(settingsFile, settingsFile + '.fixture-backup');
    fs.mkdirSync(settingsFile);
    try {
      const failed = await setAuth(true);
      assert.equal((await failed.json()).success, false);
      const stillLocal = await request(`${base}/api/health`);
      assert.equal(stillLocal.status, 200);
      assert.ok((await stillLocal.json()).migration);
    } finally {
      fs.rmdirSync(settingsFile);
      fs.renameSync(settingsFile + '.fixture-backup', settingsFile);
    }
    assert.deepEqual(fs.readFileSync(settingsFile), saved);
    try {
      assert.equal((await (await setAuth(true)).json()).success, true);
      assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).tau.authEnabled, true);
      const health = await request(`${base}/api/health`, { headers: { 'X-Forwarded-Proto': 'https' } });
      assert.equal(health.status, 200);
      assert.deepEqual(Object.keys(await health.json()).sort(), ['dataState', 'product', 'protocolVersion', 'role', 'status']);
      assert.equal(health.headers.get('Cache-Control'), 'no-store');
      const authenticatedHealth = await request(`${base}/api/health`, { headers: { ...credentials, 'X-Forwarded-Proto': 'https' } });
      assert.ok((await authenticatedHealth.json()).migration);
      assert.doesNotMatch(authenticatedHealth.headers.get('Set-Cookie') || '', /; Secure/);
      const wrongScheme = await request(`${base}/api/health`, { headers: { Origin: base.replace('http:', 'https:'), 'X-Forwarded-Proto': 'https' } });
      assert.equal(wrongScheme.status, 403);
      const call = (body: Record<string, unknown>) => request(`${base}/api/internal/canvas/inspect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contextIds: [context.contextId], ...body }) });
      assert.equal((await call({ sessionId: session.id, token: 'canvas-token' })).status, 200);
      for (const body of [{ sessionId: session.id }, { sessionId: session.id, token: 'geo-token' }, { sessionId: 'other', token: 'canvas-token' }]) assert.equal((await call(body)).status, 403);
      session.resolvedSessionPlan.modules = [];
      assert.equal((await call({ sessionId: session.id, token: 'canvas-token' })).status, 403);
      session.resolvedSessionPlan.modules = [{ id: 'com.transportx.canvas' }];
      session.terminating = true;
      assert.equal((await call({ sessionId: session.id, token: 'canvas-token' })).status, 403);
      for (const route of ['/api/live-sessions', '/api/health-extra', '/api/internal/unknown', '/api/internal/canvas/inspect']) assert.equal((await request(`${base}${route}`)).status, 401, route);
      const cad = await request(`${base}/api/internal/cad/inspect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id }) });
      assert.equal(cad.status, 403, 'CAD route requires a service token');
      for (const operation of ['prepare', 'run/prepare', 'run', 'execution', 'query']) {
        const denied = await request(`${base}/api/internal/traffic/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id, token: 'canvas-token' }) });
        assert.equal(denied.status, 403, `Traffic ${operation} rejects another service's token`);
      }
      assert.equal((await (await setAuth(false)).json()).success, true);
      assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).tau.authEnabled, false);
    } finally { _setAuthForTest(false); }
  }

  await assertHttpResourceAuthorization(fixture, t);

  // serves session files inline or as downloads with PDF byte ranges
  {
    liveManager.sessions.clear();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-file-raw-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const payload = Buffer.from('%PDF-1.7\ntransportx-preview');
    const filePath = path.join(cwd, '课程设计.pdf');
    fs.writeFileSync(filePath, payload);
    const session = fakeSession('tau_file_raw');
    session.cwd = cwd;
    registerSession(session);
    const url = `${base}/api/conversations/${session.conversationId}/files/raw?${new URLSearchParams({ path: filePath })}`;
    const inline = await request(url);
    assert.equal(inline.status, 200);
    assert.equal(inline.headers.get('content-type'), 'application/pdf');
    assert.match(String(inline.headers.get('content-disposition')), /^inline;/);
    assert.deepEqual(Buffer.from(await inline.arrayBuffer()), payload);

    const ranged = await request(url, { headers: { Range: 'bytes=5-11' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 5-11/${payload.length}`);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), payload.subarray(5, 12));

    const download = await request(`${url}&download=1`);
    assert.match(String(download.headers.get('content-disposition')), /^attachment;/);
    assert.equal((await request(`${base}/api/conversations/${session.conversationId}/files/raw?${new URLSearchParams({ path: path.join(cwd, '..', 'secret.pdf') })}`)).status, 403);
  }

  // reads files within the live-session directory but blocks static traversal
  {
    liveManager.sessions.clear();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-files-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const report = path.join(cwd, 'report.md');
    fs.writeFileSync(report, '# Report\n\nTraffic analysis');
    const session = fakeSession('tau_files');
    session.cwd = cwd;
    registerSession(session);
    const content = await jsonBody(await request(`${base}/api/conversations/${session.conversationId}/files/content?path=${encodeURIComponent(report)}`));
    assert.equal(content.content, '# Report\n\nTraffic analysis');
    assert.equal((await request(`${base}/%2e%2e%2fsecret`)).status, 403);
    assert.equal((await request(`${base}/api/health`)).status, 200);
  }

  await assertHttpRpcDelivery(fixture);

  await assertHttpResponseFailures(fixture, t);

  // history symlinks escaping the root are refused and SVG routes share sandbox headers
  {
    liveManager.sessions.clear();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-history-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const file = path.join(outside, 'secret.jsonl');
    fs.writeFileSync(file, '{"type":"session","cwd":"/tmp"}\n');
    const linked = path.join(SESSIONS_DIR, 'outside.jsonl');
    await testSymlink(t, 'history symlink cannot expose files outside the root', file, linked, async () => {
      const rejected = await request(`${base}/api/session-history?filePath=${encodeURIComponent(linked)}`);
      assert.notEqual(rejected.status, 200);
      assert.notEqual((await request(`${base}/api/sessions/./outside.jsonl`)).status, 200);
      assert.equal((await rejected.text()).includes('"cwd":"/tmp"'), false);
    });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-svg-policy-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    fs.writeFileSync(path.join(cwd, 'active.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>window.svgExecuted=true</script></svg>');
    const session = fakeSession('svg-policy');
    session.cwd = cwd;
    registerSession(session);
    for (const route of ['preview', 'raw']) {
      const response = await request(`${base}/api/conversations/${session.conversationId}/files/${route}?path=active.svg`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-security-policy') || '', /sandbox; default-src 'none'/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
  }

  // RPC rejects invalid envelopes and shared fields before invoking effects
  {
    liveManager.sessions.clear();
    for (const body of [null, [], { type: 7 }, { type: 'set_session_name', name: 7 }, { type: 'prompt', sessionId: 'missing', message: 'x', attachmentIds: [7] }, { type: 'set_auto_compaction', enabled: 'false' }]) {
      const response = await request(`${base}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
      assert.match((await jsonBody(response)).error, /Invalid RPC field/);
    }
    const { parseRpcCommand } = require('../../bin/rpc-command-input.js');
    const extension = { type: 'extension_ui_response', id: 'id', sessionId: 'session', value: { custom: true } };
    assert.equal(parseRpcCommand(extension), extension);
  }
});
