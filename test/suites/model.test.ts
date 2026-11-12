const { test } = require('node:test') as typeof import('node:test');

test('Model access and mutations preserve credentials, concurrent writes, backups and Host ownership', async (t) => {
  {
    const assert = require('node:assert/strict');
    const { createModelRpcHandlers } = require('../../bin/rpc-handlers/model.js');
    const reply = {
      success(data: unknown) { return { success: true, data }; },
      failure(error: string) { return { success: false, error }; },
    };

    // Model RPC registry registers every model and Provider command
    {
      const handlers = createModelRpcHandlers({
        agentDir: '/tmp/transportx-models',
        getAvailableModels: async () => ['openai/gpt-5.5'],
        errorMessage(error: unknown) { return String(error); },
      });
      assert.deepEqual(Object.keys(handlers).sort(), [
        'add_local_model',
        'add_model',
        'chatgpt_sign_in',
        'connect_model_provider',
        'delete_model',
        'delete_model_provider',
        'disconnect_model_provider',
        'discover_local_models',
        'get_available_models',
        'get_model_providers',
        'refresh_models',
        'update_model',
      ]);
      assert.deepEqual(await handlers.get_available_models.handle({ type: 'get_available_models' }, reply), {
        success: true,
        data: { models: ['openai/gpt-5.5'] },
      });
    }
    // Concurrent refresh callers share the catalog result, but a busy session
    // must not contaminate diagnostics returned for another session.
    {
      const access = require('../../bin/pi-model-access.js');
      const refresh = access.refreshPiModels;
      const shared = { models: ['deepseek/new'], errors: [{ provider: 'openai', message: '503' }] };
      access.refreshPiModels = async () => shared;
      try {
        const handlers = createModelRpcHandlers({ agentDir: '/tmp/unused', getAvailableModels: async () => [], syncModels: async (id: string) => { if (id === 'busy') throw new Error('session busy'); }, errorMessage: (error: Error) => error.message });
        const [busy, idle] = await Promise.all(['busy', 'idle'].map((sessionId) => handlers.refresh_models.handle({ type: 'refresh_models', sessionId }, reply)));
        assert.deepEqual(busy.data.errors, [...shared.errors, { message: 'session busy' }]);
        assert.deepEqual(idle.data.errors, shared.errors);
        assert.equal(shared.errors.length, 1);
        access.refreshPiModels = async () => { throw new Error('broken models.json'); };
        assert.deepEqual(await handlers.refresh_models.handle({ type: 'refresh_models' }, reply), { success: false, error: 'broken models.json' });
      } finally { access.refreshPiModels = refresh; }
    }
  }

  {
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { connectPiModelProvider, disconnectPiModelProvider, listAvailablePiModels, listPiModelProviders } = require('../../bin/pi-model-access.js');
    const { addLocalPiModel, addPiModel, updatePiModel, deletePiModelProvider } = require('../../bin/pi-model-config.js');

    // The desktop OAuth flow persists a separate Pi credential and model catalog.
    {
      const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
      const { generateKeyPairSync, sign, createHash } = require('node:crypto') as typeof import('node:crypto');
      const { registerChatGPTPlanProvider } = require('../../bin/chatgpt-provider.js');
      const { CHATGPT_PLAN_PROVIDER } = require('../../bin/contracts/chatgpt-plan.js');
      const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-chatgpt-plan-'));
      t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
      const authPath = path.join(agentDir, 'auth.json');
      fs.writeFileSync(authPath, JSON.stringify({ openai: { type: 'api_key', key: 'existing-api-key' } }));
      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const key = { ...publicKey.export({ format: 'jwk' }), kid: 'local-test-key', use: 'sig' };
      let authorize: URL;
      const scopes = 'openid offline_access resource.invoke chatgpt.tokens.use.direct';
      let signedIn = 0, refreshed = 0, listed = 0;
      let audience = ['oaiapp_test'];
      let nonceOverride: string | undefined;
      const request: typeof fetch = async (url, init) => {
        if (String(url).endsWith('/.well-known/openid-configuration')) return Response.json({ jwks_uri: 'https://auth.openai.com/test-keys' });
        if (String(url).endsWith('/test-keys')) return Response.json({ keys: [key] });
        if (String(url).endsWith('/oauth/token')) {
          const params = init?.body as URLSearchParams;
          assert.equal(params.get('client_id'), 'oaiapp_test');
          assert.equal(params.get('resource'), 'https://api.openai.com/v1');
          if (params.get('grant_type') === 'refresh_token') {
            refreshed++;
            assert.equal(params.get('refresh_token'), 'test-refresh');
            return Response.json({ access_token: 'refreshed-access', refresh_token: 'refreshed-token', expires_in: 3600, scope: scopes });
          }
          signedIn++;
          assert.equal(params.get('redirect_uri'), authorize.searchParams.get('redirect_uri'));
          assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'), authorize.searchParams.get('code_challenge'));
          const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
          const token = `${encode({ alg: 'RS256', kid: key.kid })}.${encode({ iss: 'https://auth.openai.com', aud: audience, sub: 'test-user', exp: Math.floor(Date.now() / 1000) + 300, nonce: nonceOverride ?? authorize.searchParams.get('nonce') })}`;
          return Response.json({ id_token: `${token}.${sign('RSA-SHA256', Buffer.from(token), privateKey).toString('base64url')}`, access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, scope: scopes });
        }
        assert.equal(String(url), 'https://api.openai.com/v1/models');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-access');
        listed++;
        return Response.json({ models: [{ slug: 'plan-test', display_name: 'Plan test', visibility: 'list' }, { slug: 'hidden', visibility: 'hidden' }] });
      };
      const createRuntime = async () => {
        const runtime = await ModelRuntime.create({ authPath, modelsPath: path.join(agentDir, 'models.json'), allowModelNetwork: false });
        await registerChatGPTPlanProvider(runtime, agentDir, request);
        await runtime.refresh({ allowNetwork: false });
        return runtime;
      };
      const runtime = await createRuntime();
      let replied: Promise<void> | undefined;
      const login = () => runtime.login(CHATGPT_PLAN_PROVIDER, 'oauth', {
        async prompt() { throw new Error('No credential prompt expected'); },
        notify(event) {
          if (event.type !== 'auth_url') return;
          authorize = new URL(event.url);
          assert.equal(authorize.origin, 'https://auth.openai.com');
          assert.equal(authorize.searchParams.get('client_id'), 'dynamic_agent_client');
          assert.equal(authorize.searchParams.get('agent_name_hint'), 'TransportX Agent');
          assert.match(authorize.searchParams.get('ext_agent_host_id')!, /^urn:uuid:/);
          const callback = new URL(authorize.searchParams.get('redirect_uri')!);
          callback.search = new URLSearchParams({ code: 'local-code', client_id: 'oaiapp_test', state: 'invalid-state' }).toString();
          replied = (async () => {
            assert.equal((await fetch(callback)).status, 400);
            callback.searchParams.set('state', authorize.searchParams.get('state')!);
            const response = await fetch(callback);
            assert.equal(response.status, 200);
            assert.match(await response.text(), /check the connection status/);
          })();
        },
      });
      audience = ['oaiapp_test', 'untrusted_client'];
      await assert.rejects(login, /客户端标识不匹配/);
      await replied;
      audience = ['oaiapp_test'];
      nonceOverride = 'wrong-nonce';
      await assert.rejects(login, /与本次登录请求不匹配/);
      await replied;
      assert.equal(JSON.parse(fs.readFileSync(authPath, 'utf8'))[CHATGPT_PLAN_PROVIDER], undefined);
      assert.equal(listed, 0);
      nonceOverride = undefined;
      await login();
      await replied;
      assert.equal(signedIn, 3);
      assert.equal(listed, 1);
      const stored = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      assert.equal(stored.openai.key, 'existing-api-key');
      assert.equal(stored[CHATGPT_PLAN_PROVIDER].refresh, 'test-refresh');
      assert.ok((await listAvailablePiModels(agentDir)).some((model: { provider: string; id: string }) => model.provider === CHATGPT_PLAN_PROVIDER && model.id === 'plan-test'));
      const providers = await listPiModelProviders(agentDir) as Array<{ id: string; credentialType?: string }>;
      assert.equal(providers.find((provider) => provider.id === 'openai')?.credentialType, 'api_key');
      assert.equal(providers.find((provider) => provider.id === CHATGPT_PLAN_PROVIDER)?.credentialType, 'oauth');
      const restarted = await createRuntime();
      assert.deepEqual((await restarted.getAvailable(CHATGPT_PLAN_PROVIDER)).map((model) => model.id), ['plan-test']);
      assert.equal(listed, 1, 'the Pi session restores its catalog offline');
      stored[CHATGPT_PLAN_PROVIDER].expires = 1;
      fs.writeFileSync(authPath, JSON.stringify(stored));
      assert.equal((await restarted.getAuth(CHATGPT_PLAN_PROVIDER))?.auth.apiKey, 'refreshed-access');
      assert.equal(refreshed, 1);

      const savedFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const message = new Request(input, init);
        assert.equal(message.url, 'https://api.openai.com/v1/responses');
        assert.equal(message.headers.get('authorization'), 'Bearer refreshed-access');
        const payload = await message.json() as Record<string, any>;
        assert.equal(payload.model, 'plan-test');
        assert.equal(payload.store, false);
        assert.equal(payload.stream, true);
        assert.equal('max_output_tokens' in payload, false);
        assert.equal('temperature' in payload, false);
        assert.equal(payload.input.some((item: any) => item.role === 'system'), false);
        assert.equal(payload.tools[0].name, 'transportx');
        assert.equal(payload.tools[0].tools[0].name, 'status');
        const call = { type: 'function_call', id: 'fc_local', call_id: 'call_local', name: 'status', namespace: 'transportx', arguments: '{}' };
        const toolOutput = payload.input.find((item: any) => item.type === 'function_call_output');
        const reply = { type: 'message', id: 'msg_local', role: 'assistant', content: [{ type: 'output_text', text: 'Workspace ready.' }] };
        if (toolOutput) {
          assert.equal(toolOutput.call_id, call.call_id);
          assert.equal(toolOutput.output, 'ready');
          assert.equal(payload.input.find((item: any) => item.type === 'function_call')?.namespace, 'transportx');
        }
        const events = toolOutput ? [
          { type: 'response.output_item.added', output_index: 0, item: { ...reply, content: [] } },
          { type: 'response.output_text.delta', output_index: 0, delta: 'Workspace ready.' },
          { type: 'response.output_item.done', output_index: 0, item: reply },
        ] : [
          { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
          { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' },
          { type: 'response.output_item.done', output_index: 0, item: call },
        ];
        const done = { type: 'response.completed', response: { id: 'resp_local', status: 'completed', output: [toolOutput ? reply : call], usage: { input_tokens: 10, output_tokens: 2 } } };
        return new Response([...events, done].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
      };
      try {
        const model = restarted.getModel(CHATGPT_PLAN_PROVIDER, 'plan-test')!;
        const context = {
          systemPrompt: 'Use the local status tool.',
          messages: [{ role: 'user' as const, content: 'Check status', timestamp: Date.now() }],
          tools: [{ name: 'status', description: 'Read status.', parameters: { type: 'object', properties: {} } as never }],
        };
        const result = await restarted.completeSimple(model, context, { temperature: 0.2, maxTokens: 512 });
        assert.equal(result.stopReason, 'toolUse', result.errorMessage);
        const call = result.content.find((item) => item.type === 'toolCall');
        if (!call) throw new Error('Expected a local tool call.');
        assert.equal(call.name, 'status');
        const reply = await restarted.completeSimple(model, { ...context, messages: [...context.messages, result, {
          role: 'toolResult', toolName: call.name, toolCallId: call.id, content: [{ type: 'text', text: 'ready' }], isError: false, timestamp: Date.now(),
        }] });
        assert.equal(reply.stopReason, 'stop', reply.errorMessage);
        assert.ok(reply.content.some((item) => item.type === 'text' && item.text === 'Workspace ready.'));
      } finally { globalThis.fetch = savedFetch; }
    }

    // Host retains one native runtime, uses Pi's forced catalog refresh/cache,
    // preserves user overrides and reports partial failures without losing models.
    {
      const http = require('node:http') as typeof import('node:http');
      const { createPiModelRuntime } = require('../../bin/pi-model-runtime.js');
      const { refreshPiModelCatalog } = require('../../bin/pi-model-access.js');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-pi-catalog-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({ deepseek: { type: 'api_key', key: 'test-only' } }));
      fs.writeFileSync(path.join(root, 'models.json'), JSON.stringify({ providers: { deepseek: { modelOverrides: { 'deepseek-v4-flash': { contextWindow: 1_000_000, maxTokens: 32768 } } } } }));
      let mode = 'success', requests = 0;
      let remoteModel: any;
      const server = http.createServer((request, response) => {
        if (request.url !== '/api/models/providers/deepseek') { response.writeHead(404).end(); return; }
        requests++;
        if (mode === 'failure') { response.writeHead(503).end(); return; }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ models: [remoteModel, { ...remoteModel, id: 'new-traffic-model', name: 'New Traffic Model' }] }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
      const catalogBaseUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
      const use = createPiModelRuntime(root, { catalogBaseUrl });
      const first = await use(async (runtime: any) => {
        remoteModel = { ...runtime.getModel('deepseek', 'deepseek-v4-flash'), contextWindow: 200_000, maxTokens: 8192 };
        return runtime;
      });
      assert.equal(requests, 0, 'ordinary reads stay offline');
      assert.equal(await use(async (runtime: any) => runtime), first, 'readers reuse the native runtime');
      const configBefore = fs.readFileSync(path.join(root, 'models.json'), 'utf8');
      const refreshed = await use(refreshPiModelCatalog);
      assert.equal(refreshed.errors.length, 0);
      assert.ok(refreshed.models.some((model: any) => model.provider === 'deepseek' && model.id === 'new-traffic-model'));
      assert.equal(refreshed.models.find((model: any) => model.id === 'deepseek-v4-flash').contextWindow, 1_000_000);
      assert.equal(refreshed.models.find((model: any) => model.id === 'deepseek-v4-flash').maxOutput, 32768);
      await use(refreshPiModelCatalog);
      assert.equal(requests, 2, 'explicit refresh bypasses Pi catalog TTL');
      mode = 'failure';
      const failed = await use(refreshPiModelCatalog);
      assert.ok(failed.errors.some((error: any) => error.provider === 'deepseek' && error.message.includes('503')));
      assert.ok(failed.models.some((model: any) => model.id === 'new-traffic-model'), 'failed refresh retains the last usable overlay');
      assert.equal(fs.readFileSync(path.join(root, 'models.json'), 'utf8'), configBefore, 'catalog refresh never rewrites user configuration');
      const restored = await createPiModelRuntime(root, { catalogBaseUrl })(async (runtime: any) => runtime.getAvailable());
      assert.ok(restored.some((model: any) => model.id === 'new-traffic-model'), 'new offline processes load Pi persisted cache');
      assert.equal(requests, 3);
      fs.writeFileSync(path.join(root, 'models.json'), '{broken');
      await assert.rejects(use(async () => []), /corrupt/);
      fs.writeFileSync(path.join(root, 'models.json'), configBefore.replace('1000000', '1100000'));
      assert.equal(await use(async (runtime: any) => runtime.getModel('deepseek', 'deepseek-v4-flash').contextWindow), 1_100_000, 'external configuration changes reload without a second Host cache');
      const aborted = await refreshPiModelCatalog({ refresh: async () => ({ aborted: true, errors: new Map() }), getAvailable: async () => [], getError: () => undefined });
      assert.match(aborted.errors[0].message, /超时/);
    }

    // Local discovery, credentials and persisted configuration work with the real Pi runtime.
    {
      const { discoverLocalModels, localModelConnection } = require('../../bin/local-model-service.js');
      const http = require('node:http') as typeof import('node:http');
      const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-local-model-'));
      t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
      let catalog = 'models';
      let requestAuth: string | undefined;
      const server = http.createServer(async (request, response) => {
        requestAuth = request.headers.authorization;
        if (request.url === '/v1/models') {
          if (catalog === 'auth' && requestAuth !== 'Bearer local-secret') { response.writeHead(401).end(); return; }
          if (catalog === 'failure') { response.writeHead(404).end(); return; }
          if (catalog === 'redirect') { response.writeHead(302, { Location: '/v1/models' }).end(); return; }
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(catalog === 'invalid' ? {} : { data: catalog === 'empty' ? [] : [{ id: 'traffic-local', name: 'Local Traffic' }, { id: 'traffic-local' }, { id: '' }, {}] }));
          return;
        }
        let body = '';
        for await (const chunk of request) body += chunk;
        const prompt = JSON.parse(body);
        assert.equal(request.url, '/v1/chat/completions');
        assert.equal(prompt.model, 'traffic-local');
        assert.equal(prompt.max_tokens ?? prompt.max_completion_tokens, 32768, 'configured output budget reaches the actual Provider request');
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = { id: 'local-reply', object: 'chat.completion.chunk', created: 1, model: prompt.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'local reply' }, finish_reason: null }] };
        response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }));
      const baseUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
      const discovered = await discoverLocalModels({ baseUrl });
      assert.equal(discovered.baseUrl, `${baseUrl}/v1`);
      assert.deepEqual(discovered.models, [{ id: 'traffic-local', name: 'Local Traffic' }]);
      assert.equal(requestAuth, undefined, 'keyless discovery sends no credential');
      assert.throws(() => localModelConnection({ baseUrl: 'file:///tmp/models' }), /HTTP/);
      assert.throws(() => localModelConnection({ baseUrl: 'http://secret:password@localhost' }), /凭据/);
      catalog = 'empty';
      assert.deepEqual((await discoverLocalModels({ baseUrl })).models, []);
      catalog = 'invalid';
      await assert.rejects(discoverLocalModels({ baseUrl }), /兼容的模型列表/);
      catalog = 'failure';
      await assert.rejects(discoverLocalModels({ baseUrl }), /HTTP 404/);
      catalog = 'redirect';
      await assert.rejects(discoverLocalModels({ baseUrl, apiKey: 'local-secret' }), /无法连接/);
      catalog = 'auth';
      await assert.rejects(discoverLocalModels({ baseUrl }), /鉴权/);
      assert.equal((await discoverLocalModels({ baseUrl, apiKey: 'local-secret' })).models.length, 1);
      catalog = 'models';

      const added = await addLocalPiModel({ baseUrl, modelId: 'traffic-local', contextWindow: 1_000_000, maxTokens: 32768 }, agentDir);
      assert.match(added.provider, /^local-[a-f0-9]{12}$/);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8')), {}, 'keyless access stores no user credential');
      assert.equal((await listAvailablePiModels(agentDir)).find((model: any) => model.provider === added.provider)?.id, 'traffic-local');
      const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
      const send = async () => {
        const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json'), allowModelNetwork: false });
        const model = runtime.getModel(added.provider, 'traffic-local');
        assert.ok(model);
        assert.equal(model!.contextWindow, 1_000_000);
        assert.equal(model!.maxTokens, 32768);
        const reply = await runtime.completeSimple(model!, { messages: [{ role: 'user', content: 'history '.repeat(20_000), timestamp: Date.now() }] });
        assert.equal(reply.stopReason, 'stop');
        assert.deepEqual(reply.content, [{ type: 'text', text: 'local reply' }]);
      };
      await assert.rejects(updatePiModel({ provider: added.provider, modelId: 'traffic-local', contextWindow: 1000, maxTokens: 1001 }, agentDir), /最大输出/);
      await assert.rejects(updatePiModel({ provider: added.provider, modelId: 'traffic-local', maxTokens: -1 }, agentDir), /最大输出/);
      await send();
      assert.equal(requestAuth, 'Bearer transportx-local');
      const sameService = await addLocalPiModel({ baseUrl: `${baseUrl}/v1/`, modelId: 'second-model' }, agentDir);
      assert.equal(sameService.provider, added.provider, 'normalized addresses share a provider');
      const anotherService = await addLocalPiModel({ baseUrl: `${baseUrl}/other/v1`, modelId: 'traffic-local' }, agentDir);
      assert.notEqual(anotherService.provider, added.provider, 'different services stay separate');
      await addLocalPiModel({ baseUrl, modelId: 'traffic-local', apiKey: 'local-secret' }, agentDir);
      assert.equal(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8').includes('local-secret'), false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8'))[added.provider].key, 'local-secret');
      await send();
      assert.equal(requestAuth, 'Bearer local-secret');
      await addLocalPiModel({ baseUrl, modelId: 'traffic-local' }, agentDir);
      await send();
      assert.equal(requestAuth, 'Bearer transportx-local', 'clearing authentication removes the previous secret');
      const summary = (await listPiModelProviders(agentDir)).find((provider: any) => provider.id === added.provider);
      assert.equal(summary.connected, true);
      assert.equal(summary.credentialStored, false);
      assert.equal(JSON.stringify(summary).includes('transportx-local'), false);
      await assert.rejects(addPiModel({ provider: 'cloud-no-key', modelId: 'cloud', baseUrl: 'https://example.com/v1', api: 'openai-completions' }, agentDir), /API Key/);
      await deletePiModelProvider(added.provider, agentDir);
      assert.equal((await listAvailablePiModels(agentDir)).some((model: any) => model.provider === added.provider), false);
    }

    // Pi provider access reuses auth.json in the configured TransportX directory
    {
      const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-model-access-'));
      t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
      const before = await listPiModelProviders(agentDir);
      const candidate = before.find((provider: { id: string }) => provider.id === 'xiaomi-token-plan-cn');
      assert.ok(candidate);
      assert.equal(candidate.credentialStored, false);
      assert.ok(candidate.authMethods.includes('api_key'));

      const connected = await connectPiModelProvider(candidate.id, 'test-token-plan-key', agentDir);
      assert.equal(connected.connected, true);
      assert.equal(connected.credentialStored, true);
      const auth = JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8'));
      assert.deepEqual(auth[candidate.id], { type: 'api_key', key: 'test-token-plan-key' });
      if (require('../../bin/host-platform.js').hostPlatform.posixPermissions) assert.equal(fs.statSync(path.join(agentDir, 'auth.json')).mode & 0o777, 0o600);
      else t.diagnostic('Windows ACL permissions cannot be verified through POSIX mode bits');
      const models = await listAvailablePiModels(agentDir);
      const providerModels = models.filter((model: { provider: string }) => model.provider === candidate.id);
      // Login can refresh the provider catalog; availability must not depend on its previous count.
      assert.ok(providerModels.length > 0, 'connecting a provider exposes usable models');
      assert.ok(providerModels.every((model: { id?: string; contextWindow?: number; maxOutput?: number }) => model.id && model.contextWindow && model.maxOutput));

      await disconnectPiModelProvider(candidate.id, agentDir);
      const after = await listPiModelProviders(agentDir);
      assert.equal(after.find((provider: { id: string; credentialStored: boolean }) => provider.id === candidate.id)?.credentialStored, false);
      assert.equal((await listAvailablePiModels(agentDir)).some((model: { provider: string }) => model.provider === candidate.id), false);
    }

    // provider deletion cannot overwrite a model update across await
    {
      const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-model-concurrent-'));
      t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
      const file = path.join(agentDir, 'models.json');
      fs.writeFileSync(file, JSON.stringify({ providers: { remove: { baseUrl: 'https://example.com', api: 'openai-completions', models: [{ id: 'a' }] }, keep: { baseUrl: 'https://example.com', api: 'openai-completions', models: [{ id: 'b', name: 'before' }] } } }));
      await Promise.all([deletePiModelProvider('remove', agentDir), updatePiModel({ provider: 'keep', modelId: 'b', name: 'after', reasoning: true }, agentDir)]);
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(config.providers.remove, undefined);
      assert.equal(config.providers.keep.models[0].name, 'after');
      assert.ok(fs.existsSync(`${file}.bak`));
    }

    // corrupt JSON refuses mutations, and atomic writes retain the previous valid copy
    {
      const { readJsonObject, writeJsonAtomic, acquireWriteLease } = require('../../bin/util/json-storage.js');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-json-recovery-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const file = path.join(root, 'models.json');
      fs.writeFileSync(file, '{broken');
      assert.throws(() => readJsonObject(file), /corrupt/);
      assert.throws(() => writeJsonAtomic(file, { providers: {} }), /corrupt/);
      await assert.rejects(updatePiModel({ provider: 'keep', modelId: 'b' }, root), /corrupt/);
      assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
      fs.writeFileSync(file, '{"providers":{}}');
      writeJsonAtomic(file, { providers: { next: {} } });
      assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { providers: {} });
      assert.equal(fs.readdirSync(root).some((name: string) => name.endsWith('.tmp')), false);
      const release = acquireWriteLease(file);
      assert.throws(() => acquireWriteLease(file), /writer/);
      release();
      const again = acquireWriteLease(file);
      again();
    }

    // Dead owners are recovered, while incomplete/unknown owners and competing generations stay protected.
    {
      const crypto = require('node:crypto');
      const { spawnSync } = require('node:child_process');
      const { acquireWriteLease } = require('../../bin/util/json-storage.js');
      const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
      assert.ok(deadPid > 0);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-stale-lease-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const target = path.join(root, 'host');
      const lock = `${target}.transportx-lock`;
      const writeOwner = (legacy: boolean, pid = deadPid) => {
        fs.mkdirSync(lock);
        const nonce = crypto.randomUUID();
        const file = path.join(lock, legacy ? 'owner.json' : `owner.${nonce}.json`);
        fs.writeFileSync(file, JSON.stringify({ pid, nonce, createdAt: new Date().toISOString() }));
        return file;
      };
      for (const legacy of [false, true]) {
        writeOwner(legacy);
        const release = acquireWriteLease(target);
        assert.equal(JSON.parse(fs.readFileSync(path.join(lock, fs.readdirSync(lock)[0]), 'utf8')).pid, process.pid);
        assert.throws(() => acquireWriteLease(target), (error: any) => error.code === 'writer_busy');
        release(); release();
        assert.equal(fs.existsSync(lock), false);
      }
      for (const content of [null, '{broken', '{}', JSON.stringify({ pid: -1, nonce: crypto.randomUUID() })]) {
        fs.mkdirSync(lock);
        if (content !== null) fs.writeFileSync(path.join(lock, 'owner.json'), content);
        const before = fs.readdirSync(lock);
        // Even an old malformed directory does not prove its owner is dead.
        fs.utimesSync(lock, new Date(0), new Date(0));
        assert.throws(() => acquireWriteLease(target), (error: any) => error.code === 'writer_busy');
        assert.deepEqual(fs.readdirSync(lock), before);
        fs.rmSync(lock, { recursive: true });
      }
      const { testSymlink } = require('../support/symlink.ts');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(outside);
      const outsideOwner = path.join(outside, 'owner.json');
      const outsideBytes = JSON.stringify({ pid: deadPid, nonce: crypto.randomUUID() });
      fs.writeFileSync(outsideOwner, outsideBytes);
      await testSymlink(t, 'a lock directory symlink cannot reclaim an external owner', outside, lock, () => {
        assert.throws(() => acquireWriteLease(target), (error: any) => error.code === 'writer_busy');
        assert.equal(fs.readFileSync(outsideOwner, 'utf8'), outsideBytes);
      }, 'dir');
      fs.mkdirSync(lock);
      await testSymlink(t, 'an owner symlink cannot be reclaimed', outsideOwner, path.join(lock, 'owner.json'), () => {
        assert.throws(() => acquireWriteLease(target), (error: any) => error.code === 'writer_busy');
        assert.equal(fs.readFileSync(outsideOwner, 'utf8'), outsideBytes);
      }, 'file');
      fs.rmdirSync(lock);
      const kill = process.kill;
      for (const code of ['EPERM', 'EINVAL']) {
        const file = writeOwner(false);
        const before = fs.readFileSync(file, 'utf8');
        process.kill = ((pid: number, signal: any) => { if (pid === deadPid) throw Object.assign(new Error('unknown process status'), { code }); return kill(pid, signal); }) as typeof process.kill;
        try { assert.throws(() => acquireWriteLease(target), (error: any) => error.code === 'writer_busy'); }
        finally { process.kill = kill; }
        assert.equal(fs.readFileSync(file, 'utf8'), before);
        fs.rmSync(lock, { recursive: true });
      }
      // Pause contender A after its read, let B acquire, then resume A. A must not delete B's lock.
      for (const legacy of [false, true]) {
        writeOwner(legacy);
        let releaseWinner: (() => void) | undefined;
        let winnerFile = '';
        let winnerBytes = '';
        process.kill = ((pid: number, signal: any) => {
          if (pid === deadPid) {
            process.kill = kill;
            releaseWinner = acquireWriteLease(target);
            winnerFile = path.join(lock, fs.readdirSync(lock)[0]);
            winnerBytes = fs.readFileSync(winnerFile, 'utf8');
          }
          return kill(pid, signal);
        }) as typeof process.kill;
        try { assert.throws(() => acquireWriteLease(target), (error: any) => error.code === 'writer_busy'); }
        finally { process.kill = kill; }
        assert.equal(fs.readFileSync(winnerFile, 'utf8'), winnerBytes);
        releaseWinner!();
        assert.equal(fs.existsSync(lock), false);
      }
    }

    // another process cannot take a Host lease or mutate its Agent directory
    {
      const { acquireWriteLease } = require('../../bin/util/json-storage.js');
      const { execFileSync } = require('node:child_process');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-host-writer-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const release = acquireWriteLease(path.join(root, 'host'));
      t.after(release);
      const output = execFileSync(process.execPath, ['-e', `const {acquireWriteLease,assertHostWriter}=require('./bin/util/json-storage.js');for(const attempt of [()=>acquireWriteLease(require('path').join(process.argv[1],'host')),()=>assertHostWriter(process.argv[1])]){try{attempt();process.exitCode=1}catch(e){if(e.code!=='writer_busy')throw e;process.stdout.write(e.code+'\\n')}}`, root], { cwd: process.cwd(), encoding: 'utf8' });
      assert.equal(output.trim().split('\n').length, 2);
    }

    // failed atomic replacement preserves the target, backup and removes temporary files
    {
      const { writeJsonAtomic } = require('../../bin/util/json-storage.js');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-json-interrupt-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const file = path.join(root, 'settings.json');
      fs.writeFileSync(file, '{"tau":{"authEnabled":true}}');
      const rename = fs.renameSync;
      fs.renameSync = (source: string, destination: string) => { if (destination === file) throw new Error('interrupted replacement'); return rename(source, destination); };
      try { assert.throws(() => writeJsonAtomic(file, { tau: { authEnabled: false } }), /interrupted/); }
      finally { fs.renameSync = rename; }
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tau.authEnabled, true);
      assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).tau.authEnabled, true);
      assert.equal(fs.readdirSync(root).some((name: string) => name.endsWith('.tmp')), false);
    }
  }
});
