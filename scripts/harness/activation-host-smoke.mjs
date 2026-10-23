import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function activationHostSmoke({ root, json, rpc, until, providerInputs }) {
  const session = (await json('/api/live-sessions', { cwd: path.join(root, 'scenario'), model: 'probe/smoke', name: 'Activation Host acceptance' })).session;
  const snapshot = () => json(`/api/live-sessions/${session.id}/snapshot`);
  const results = (state) => state.entries.filter((entry) => entry.message?.role === 'toolResult').map((entry) => entry.message);
  const execute = async (params) => {
    const before = results(await snapshot()).length;
    assert.equal((await rpc({ type: 'prompt', sessionId: session.id, message: 'core:' + JSON.stringify({ tool: 'manage_capabilities', params }) })).success, true);
    const state = await until(async () => { const state = await snapshot(); return !state.isStreaming && results(state).length > before && state; }, 'real management action');
    const result = results(state).at(-1); assert.equal(result.isError, false, JSON.stringify(result)); return result.details;
  };
  await execute({ action: 'status' });
  const initial = (await snapshot()).entries.filter((entry) => entry.customType === 'pi-web-bridge').at(-1).data;
  assert.equal(initial.tools.filter((tool) => tool.active).length, 5);
  for (const action of ['discover', 'inspect', 'status']) {
    const value = await execute({ action, ...(action === 'discover' ? { query: '地图' } : { moduleId: 'com.transportx.geo' }) });
    if (action === 'discover') assert.ok(value.modules.some((module) => module.moduleId === 'com.transportx.geo'));
    if (action === 'inspect') assert.equal(value.tools.length, 5);
    assert.equal(providerInputs.at(-1).tools.length, 5);
  }
  const unavailable = await execute({ action: 'enable', moduleId: 'local.not-in-plan' });
  assert.equal(unavailable.status, 'not_in_session_plan');
  assert.equal(providerInputs.at(-1).tools.length, 5);
  const noTools = await execute({ action: 'enable', moduleId: 'com.transportx.document' });
  assert.equal(noTools.status, 'no_tools');
  assert.equal(providerInputs.at(-1).tools.length, 5);
  const enabled = await execute({ action: 'enable', moduleId: 'com.transportx.geo' });
  assert.equal(enabled.newlyActive.length, 5);
  assert.equal(enabled.activeTools.includes('canvas_present'), false, 'dependencies do not propagate active');
  const observed = (await snapshot()).entries.filter((entry) => entry.customType === 'pi-web-bridge').at(-1).data;
  assert.equal(observed.tools.filter((tool) => tool.active).length, 10, 'Bridge samples activation immediately');
  const moduleId = 'local.activation-skill';
  const directory = path.join(root, 'skill-only'); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ manifestVersion: 2, id: moduleId, name: 'Skill-only acceptance', version: '1.0.0', type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [], entrypoints: { skills: ['SKILL.md'] } }));
  fs.writeFileSync(path.join(directory, 'SKILL.md'), '---\nname: activation-skill\ndescription: No runtime or placeholder tools, native file processing only.\n---\nRead local files.\n');
  assert.equal((await rpc({ type: 'install_module', sourcePath: directory })).success, true);
  assert.equal((await execute({ action: 'enable', moduleId })).status, 'not_in_session_plan');
  const next = (await json('/api/live-sessions', { cwd: path.join(root, 'scenario'), model: 'probe/smoke', name: 'Skill-only assembled task' })).session;
  await rpc({ type: 'prompt', sessionId: next.id, message: 'core:' + JSON.stringify({ tool: 'manage_capabilities', params: { action: 'enable', moduleId } }) });
  const state = await until(async () => { const value = await json(`/api/live-sessions/${next.id}/snapshot`); return !value.isStreaming && results(value).some((result) => result.details?.moduleId === moduleId) && value; }, 'skill-only module');
  assert.equal(results(state).at(-1).details.status, 'no_tools');
  assert.equal(providerInputs.at(-1).tools.length, 5);
  const schemas = initial.tools.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }));
  return { firstRequestFive: true, readOnlyUnchanged: true, moduleDependenciesDoNotActivate: true, bridgeRefresh: true, unknownPlanRefused: true, skillOnlyInstalledAndAssembled: true, installDoesNotExpandExistingPlan: true,
    schemaMeasurement: { allRegisteredCount: schemas.length, allRegisteredBytes: Buffer.byteLength(JSON.stringify(schemas)), firstActiveCount: 5, firstActiveBytes: Buffer.byteLength(JSON.stringify(schemas.filter((tool) => initial.tools.find((item) => item.name === tool.function.name).active))), source: 'same production Pi Bridge definitions; provider capture separately asserts actual five-tool requests', tokens: 'controlled provider supplies no tokenizer/usage; bytes only' } };
}
