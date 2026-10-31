import { createHostConversation, nativeSnapshot } from './workspace-client.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function modulePackageSmoke({ root, json, rpc, until }) {
  const session = await createHostConversation(json, { parentDirectory: path.join(root, 'scenario'), model: 'probe/smoke', name: 'P4 package tool' });
  const target = path.join(session.cwd, 'generated-package');
  fs.cpSync(path.join(root, 'lifecycle-backup-1.0.1'), target, { recursive: true });
  const file = path.join(target, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...manifest, version: '1.0.2' }));
  for (const action of ['inspect', 'install']) {
    await rpc({ type: 'prompt', sessionId: session.id, message: 'module-package:' + JSON.stringify({ action, packagePath: 'generated-package' }) });
    const state = await until(async () => { const state = await nativeSnapshot(json, session.conversationId); return !state.isStreaming && state.entries.some((entry) => entry.message?.details?.kind === 'tau-module-package' && entry.message?.details?.action === action) && state; }, `actual package tool ${action}`);
    const result = state.entries.filter((entry) => entry.message?.role === 'toolResult').at(-1).message;
    assert.equal(result.isError, false);
    if (action === 'inspect') assert.equal(result.details.codeExecuted, false);
    else assert.equal(result.details.installed, true);
  }
  const state = await nativeSnapshot(json, session.conversationId);
  assert.equal(state.session.resolvedSessionPlan.modules.find((module) => module.id === manifest.id).version, '1.0.1');
  return { nativePiPackageInspection: true, nativeTrustInstall: true, currentTaskPlanRemainsFrozen: true };
}
