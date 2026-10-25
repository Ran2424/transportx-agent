import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { AGENT_HOST_PROTOCOL_VERSION, HOST_PROTOCOL_HEADER } = createRequire(import.meta.url)('../../bin/contracts/host-protocol.js');
export const protocolHeaders = { [HOST_PROTOCOL_HEADER]: String(AGENT_HOST_PROTOCOL_VERSION) };
export const smokeProfile = { schemaVersion: 1, task: { kind: 'data-query', expectedOutputs: ['answer'] }, modules: { selectionMode: 'explicit', selected: [] } };

/** Test setup uses the same explicit create, then activate operations as a client. */
export async function createHostConversation(json, { name, model = 'probe/smoke', parentDirectory, profile, domainId = 'com.transportx.workbench' }) {
  if (!profile) {
    const options = await json('/api/platform/session-options');
    profile = { ...smokeProfile, modules: { selectionMode: 'explicit', selected: options.modules.filter((item) => item.selectedByDefault).map(({ id, version }) => ({ id, version })) } };
  }
  const saved = await json('/api/conversations', { requestId: crypto.randomUUID(), workspace: { kind: 'new', name, ...(parentDirectory ? { parentDirectory } : {}) }, name, model, profile, domainId });
  return (await json(`/api/conversations/${saved.conversation.id}/activate`, {})).runtime;
}
export const nativeSnapshot = async (json, conversationId) => (await json(`/api/conversations/${conversationId}/snapshot`)).snapshot;
export const closeHostConversation = (json, conversationId) => json(`/api/conversations/${conversationId}/close`, { stopCurrent: true });

export async function browserJson(page, baseUrl, pathname, data, method = data === undefined ? 'GET' : 'POST') {
  const response = await page.request.fetch(baseUrl + pathname, { method, headers: protocolHeaders, ...(data === undefined ? {} : { data }) });
  const result = await response.json(); assert.equal(response.ok(), true, JSON.stringify(result)); return result;
}
export async function createBrowserConversation(page, baseUrl, name) {
  const json = (pathname, data) => browserJson(page, baseUrl, pathname, data);
  const runtime = await createHostConversation(json, { name, model: 'kimi-coding/k2p7' });
  return { id: runtime.conversationId, liveSessionId: runtime.id, cwd: runtime.cwd, workspaceId: runtime.workspaceId, sessionName: name };
}
export const closeBrowserConversation = (page, baseUrl, id) => browserJson(page, baseUrl, `/api/conversations/${id}/close`, { stopCurrent: true });

export const listHostRuntimes = async (json) => (await json('/api/workspaces')).workspaces.flatMap((workspace) => workspace.conversations.flatMap(({ runtime }) => runtime ? [runtime] : []));
