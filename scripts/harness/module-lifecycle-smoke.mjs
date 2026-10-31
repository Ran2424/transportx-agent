import { createHostConversation, nativeSnapshot, closeHostConversation, listHostRuntimes, protocolHeaders } from './workspace-client.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function moduleLifecycleSmoke({ root, endpoint, json, rpc, until }) {
  const id = 'local.traffic-peak';
  const sessions = (await listHostRuntimes(json));
  const original = sessions.find((session) => session.sessionName === 'P1 Spatial acceptance');
  const snapshot = await nativeSnapshot(json, original.conversationId);
  assert.equal(original.resolvedSessionPlan.modules.find((module) => module.id === id).version, '1.0.0');
  assert.equal((await rpc({ type: 'set_module_enabled', moduleId: id, enabled: false })).success, true);
  const inactive = await createHostConversation(json, { parentDirectory: path.join(root, 'scenario'), model: 'probe/smoke', name: 'Disabled plugin new task' });
  assert.ok(!inactive.resolvedSessionPlan.modules.some((module) => module.id === id));
  const oldCount = snapshot.entries.filter((entry) => entry.message?.role === 'toolResult').length;
  await rpc({ type: 'prompt', sessionId: original.id, message: 'traffic:' + JSON.stringify({ inputPath: 'volumes.csv' }) });
  const live = await until(async () => { const state = await nativeSnapshot(json, original.conversationId); return !state.isStreaming && state.entries.filter((entry) => entry.message?.role === 'toolResult').length > oldCount && state; }, 'disabled plugin retained by its existing frozen task');
  assert.equal(live.entries.filter((entry) => entry.message?.role === 'toolResult').at(-1).message.isError, false);
  assert.equal((await rpc({ type: 'uninstall_module', moduleId: id })).success, false, 'active tasks keep their code');
  await closeHostConversation(json, original.conversationId);
  const restored = (await json(`/api/conversations/${original.conversationId}/activate`, {})).runtime;
  assert.equal(restored.resolvedSessionPlan.modules.find((module) => module.id === id).version, '1.0.0', 'disable affects new selections; explicit history resume retains its trusted exact version');
  assert.equal((await rpc({ type: 'set_module_enabled', moduleId: id, enabled: true })).success, true);
  const updated = await createHostConversation(json, { parentDirectory: path.join(root, 'scenario'), model: 'probe/smoke', name: 'Updated plugin new task' });
  assert.equal(updated.resolvedSessionPlan.modules.find((module) => module.id === id).version, '1.0.1');
  fs.writeFileSync(path.join(updated.cwd, 'volumes.csv'), 'road,hour,volume\nA,08,10\nA,08,20\n');
  await rpc({ type: 'prompt', sessionId: updated.id, message: 'traffic:' + JSON.stringify({ inputPath: 'volumes.csv' }) });
  const executed = await until(async () => { const state = await nativeSnapshot(json, updated.conversationId); return !state.isStreaming && state.entries.some((entry) => entry.message?.toolName === 'traffic_peak_hour') && state; }, 'updated plugin actual Pi call');
  assert.equal(executed.entries.filter((entry) => entry.message?.role === 'toolResult').at(-1).message.isError, false);
  for (const session of (await listHostRuntimes(json))) await closeHostConversation(json, session.conversationId);
  const persisted = fs.readFileSync(snapshot.sessionFile, 'utf8');
  assert.match(persisted, /local.traffic-peak/);
  assert.equal((await rpc({ type: 'uninstall_module', moduleId: id })).success, true);
  assert.equal(fs.readFileSync(snapshot.sessionFile, 'utf8'), persisted, 'uninstall never rewrites history');
  const failed = await fetch(`${endpoint}/api/conversations/${original.conversationId}/activate`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...protocolHeaders }, body: JSON.stringify({}) });
  assert.equal(failed.status, 409);
  const failure = await failed.json();
  assert.equal(failure.code, 'module_version_missing');
  // Reinstall each exact package through the normal path, not managed-storage edits.
  for (const version of ['1.0.0', '1.0.1']) {
    const source = path.join(root, `lifecycle-backup-${version}`);
    assert.equal((await rpc({ type: 'install_module', sourcePath: source })).success, true);
  }
  const resumed = (await json(`/api/conversations/${original.conversationId}/activate`, {})).runtime;
  assert.equal(resumed.resolvedSessionPlan.modules.find((module) => module.id === id).version, '1.0.0');
  return { disableNewTasks: true, existingTaskStillExecutes: true, disabledTrustedHistoryResumesExactVersion: true, updateNewTaskExecutes: true, activeUninstallRefused: true, uninstallPreservesHistory: true, missingVersionExplained: true, exactVersionReinstallAndResume: true };
}
