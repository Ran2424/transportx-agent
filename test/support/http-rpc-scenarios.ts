import type { HttpHostFixture } from './http-host-fixture.ts';

async function assertHttpRpcDelivery(fixture: HttpHostFixture) {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { PiRpcSession, SESSIONS_DIR, base, fakeSession, handleRpcCommand, liveManager, makeFakeChild, registerSession, request, writeJsonAtomic } = fixture;

  // normalizes model references before sending Pi set_model commands
  {
    liveManager.sessions.clear();
    const commands: Array<Record<string, unknown>> = [];
    const session = {
      ...fakeSession('tau_set_model'),
      modelSync: new (require('../../bin/model-session-sync.js').SessionModelSync)(),
      send: async (command: Record<string, unknown>) => {
        commands.push(command);
        if (command.type === 'get_commands') return { success: true, data: { commands: [{ name: 'transportx_reload_models', source: 'extension' }] } };
        if (command.type === 'prompt') session.modelSync.consume({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'transportx:model-sync', statusText: JSON.stringify({ token: String(command.message).split(' ')[1] }) });
        return { success: true, data: { model: { provider: 'deepseek', id: 'deepseek-v4-flash' } } };
      },
    };
    registerSession(session);

    const response = await handleRpcCommand({ type: 'set_model', sessionId: session.id, model: 'deepseek/deepseek-v4-flash' });
    assert.equal(response.success, true);
    assert.deepEqual(commands.map((command) => command.type), ['get_commands', 'prompt', 'set_model']);
    assert.equal(commands[2].provider, 'deepseek');
    assert.equal(commands[2].modelId, 'deepseek-v4-flash');
  }

  // reliable prompt command IDs are acknowledged and executed once
  {
    liveManager.sessions.clear();
    let calls = 0;
    const session = {
      ...fakeSession('tau_reliable_prompt'),
      send: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { success: true };
      },
    };
    registerSession(session);
    const command = { type: 'prompt', sessionId: session.id, message: '一次即可', clientCommandId: 'client-command-one' };
    const [first, duplicate] = await Promise.all([handleRpcCommand(command), handleRpcCommand(command)]);
    assert.equal(calls, 1);
    assert.equal(first.success, true);
    assert.equal(first.delivery, 'accepted');
    assert.equal(first.clientCommandId, 'client-command-one');
    assert.deepEqual(duplicate, first);
  }

  // Pi RPC prompt timeout is reported instead of optimistic success
  {
    liveManager.sessions.clear();
    const session = {
      ...fakeSession('tau_prompt_timeout'),
      send: async () => { throw new Error('RPC command timed out: prompt'); },
    };
    registerSession(session);
    const response = await handleRpcCommand({ type: 'prompt', sessionId: session.id, message: '不要假成功', clientCommandId: 'client-command-timeout' });
    assert.equal(response.success, false);
    assert.match(String(response.error), /timed out/);
    let newCalls = 0;
    const replacement = { ...session, id: 'tau_prompt_replacement', send: async () => { newCalls++; return { success: true }; } };
    const terminate = session.terminate;
    session.terminate = async () => { throw Object.assign(new Error('Stop unconfirmed'), { code: 'process_stop_unconfirmed' }); };
    await assert.rejects(liveManager.delete(session.id), { code: 'process_stop_unconfirmed' });
    assert.equal(liveManager.get(session.id), session);
    session.terminate = terminate;
    await liveManager.delete(session.id);
    liveManager.sessions.set(replacement.id, replacement);
    const replay = await handleRpcCommand({ type: 'prompt', sessionId: replacement.id, message: '不要假成功', clientCommandId: 'client-command-timeout' });
    assert.equal(replay.code, 'command_replay');
    assert.equal(replay.delivery, 'unknown');
    assert.equal(newCalls, 0);
  }

  // Published simulation GETs preserve the run journal and the reservation, even after restart.
  {
    liveManager.sessions.clear();
    const session = fakeSession('tau_simulation_read');
    registerSession(session);
    const { SIMULATION_MODULE_ID, SIMULATION_CANVAS_ADAPTER_ID } = require('../../bin/contracts/simulation.js');
    const { executionOwner, executionOwnerKey } = require('../../bin/util/execution-owner.js');
    const { simulationDigest } = require('../../bin/simulation-job.js');
    const root = path.join(process.env.PI_CODING_AGENT_DIR!, 'executions', 'traffic-simulation');
    const runId = 'sim_' + '1'.repeat(32);
    const scenarioId = 'scenario_' + '2'.repeat(32);
    session.resolvedSessionPlan = { workspace: session.cwd, modules: [{ id: SIMULATION_MODULE_ID, version: '0.6.0', canvasViews: [{ adapterId: SIMULATION_CANVAS_ADAPTER_ID, kind: 'simulation', protocolVersion: '1.0' }] }] };
    session.serviceTokens.traffic = 'traffic-fixture';
    session.lifecycle.lease = { assertOwned() { throw Object.assign(new Error('Lease lost'), { code: 'writer_busy', status: 409 }); } };
    const owner = executionOwnerKey(executionOwner(session, SESSIONS_DIR));
    const directory = path.join(root, owner);
    const pointer = path.join(root, 'workspaces', simulationDigest(session.workspaceId) + '.json');
    const journal = path.join(directory, runId + '.json');
    const bytes = Buffer.from('frozen test network');
    const geometry = Buffer.from(JSON.stringify({ type: 'FeatureCollection', routes: { road: ['edge'] }, features: [{ type: 'Feature', id: 'edge', properties: { edgeId: 'edge' }, geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }] }));
    const scenarioRoot = path.join(session.cwd, 'traffic-simulation/scenarios', scenarioId);
    const document = { title: 'published simulation', provenance: { kind: 'synthetic' }, configuration: {} };
    fs.mkdirSync(scenarioRoot, { recursive: true });
    fs.writeFileSync(path.join(scenarioRoot, 'network.net.xml'), bytes);
    fs.writeFileSync(path.join(scenarioRoot, 'geometry.json'), geometry);
    writeJsonAtomic(path.join(scenarioRoot, 'scenario.json'), document);
    writeJsonAtomic(path.join(directory, scenarioId + '.json'), { schemaVersion: 1, owner, moduleVersion: '0.6.0', scenarioId, document, networkSha256: simulationDigest(bytes), geometrySha256: simulationDigest(geometry) });
    writeJsonAtomic(journal, { schemaVersion: 1, owner, workspaceId: session.workspaceId, moduleVersion: '0.6.0', runId, scenarioId, state: 'running', createdAt: '2026-11-14T00:00:00Z' });
    writeJsonAtomic(pointer, { owner, runId });
    const files = [journal, pointer];
    const before = files.map((file) => fs.readFileSync(file));
    const prefix = `${base}/api/conversations/${session.conversationId}/simulation-runs`;
    const results = await Promise.all([request(prefix), request(prefix + '/' + runId + '/index'), request(prefix)]);
    for (const result of results) if (!result.ok) assert.fail(await result.text());
    assert.equal((await results[0].json()).runs[0].run.state, 'running');
    assert.equal((await results[1].json()).index, null);
    assert.deepEqual(files.map((file) => fs.readFileSync(file)), before);
    const recover = (token = 'traffic-fixture') => request(`${base}/api/internal/traffic/execution`, { method: 'POST', body: JSON.stringify({ sessionId: session.id, token, contractVersion: '1.0.0', toolCallId: 'fixture-recovery', action: 'query', runId }) });
    assert.equal((await recover('unscoped')).status, 403);
    const blocked = await recover();
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).code, 'writer_busy');
    assert.deepEqual(files.map((file) => fs.readFileSync(file)), before);
    session.lifecycle.lease.assertOwned = () => {};
    const recovery = await recover();
    if (!recovery.ok) assert.fail(await recovery.text());
    const recovered = (await recovery.json()).result.run;
    assert.equal(recovered.state, 'unknown');
    assert.equal(recovered.error.code, 'traffic_result_unpublished');
    const after = fs.readFileSync(journal);
    assert.equal((await recover()).status, 200);
    assert.deepEqual(fs.readFileSync(journal), after);
    assert.deepEqual(fs.readFileSync(pointer), before[1]);
  }

  // Pi RPC extension UI responses acknowledge after writing because Pi sends no response envelope
  {
    liveManager.sessions.clear();
    const manager = new (require('../../bin/live-session-manager.js').LiveSessionManager)();
    const session = new PiRpcSession(manager, { conversationId: 'conv_00000000-0000-4000-8000-000000000001', cwd: '/tmp/pi-extension-ui' });
    const child = makeFakeChild();
    const received: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => received.push(chunk.toString()));
    (session as any).child = child;

    const response = await Promise.race([
      session.send({ type: 'extension_ui_response', id: 'ui-1', value: 'northbound' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('extension UI response was not acknowledged')), 100)),
    ]);

    assert.equal((response as { success: boolean }).success, true);
    assert.match(received.join(''), /"type":"extension_ui_response"/);
  }
}

module.exports = { assertHttpRpcDelivery };
