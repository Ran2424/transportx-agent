import type { TestContext } from 'node:test';

async function assertChatGptSubscription(t: TestContext) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { listAvailablePiModels, listPiModelProviders } = require('../../bin/pi-model-access.js');

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

module.exports = { assertChatGptSubscription };
