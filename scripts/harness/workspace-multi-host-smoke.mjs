#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { protocolHeaders, smokeProfile } from './workspace-client.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-multi-api-'));
const children = [], requests = [];
async function launch(args) {
  const child = spawn(process.execPath, ['scripts/harness/serve-with-fake-pi.mjs', '--runtime-coordination', path.join(root, 'guards'), ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  let log = ''; child.stdout.on('data', (chunk) => { log += chunk; }); child.stderr.on('data', (chunk) => { log += chunk; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { const ready = log.match(/TAU_FAKE_READY (\{[^\n]+\})/); if (ready) return JSON.parse(ready[1]); if (child.exitCode !== null) throw new Error(log); await new Promise((resolve) => setTimeout(resolve, 50)); }
  throw new Error(log);
}
async function request(host, pathname, body) {
  requests.push(pathname);
  const response = await fetch(host.baseUrl + pathname, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { 'Content-Type': 'application/json', ...protocolHeaders } });
  return { status: response.status, data: await response.json() };
}
try {
  const first = await launch([]);
  const created = await request(first, '/api/conversations', { requestId: crypto.randomUUID(), workspace: { kind: 'new', name: 'Shared API workspace' }, name: 'A', model: 'kimi-coding/k2p7', domainId: 'com.transportx.workbench', profile: smokeProfile });
  assert.equal(created.status, 200); const a = created.data.conversation.id, workspaceId = created.data.manifest.id;
  const activeA = await request(first, `/api/conversations/${a}/activate`, {}); assert.equal(activeA.status, 200);
  // A verified test-owned catalog snapshot gives the second scope an explicit
  // registration. There is no production import or repair adapter here.
  const second = await launch(['--no-seed', '--catalog-seed', path.join(first.tempRoot, 'agent/workspaces.json'), '--sessions-directory', first.sessionsDir, '--projects-directory', first.projectsDir]);
  const workspace = await request(second, `/api/workspaces/${workspaceId}`); assert.equal(workspace.data.availability, 'ready', JSON.stringify(workspace));
  const savedB = await request(second, '/api/conversations', { requestId: crypto.randomUUID(), workspace: { kind: 'existing', workspaceId, expectedRevision: workspace.data.revision, defaultsRevision: workspace.data.defaultsRevision }, name: 'B' });
  assert.equal(savedB.status, 200); const b = savedB.data.conversation.id;
  for (const stopCurrent of [false, true]) {
    const refused = await request(second, `/api/conversations/${b}/activate`, { stopCurrent });
    assert.equal(refused.status, 409); assert.equal(refused.data.code, 'workspace_busy');
    assert.equal((await request(first, `/api/conversations/${a}/snapshot`)).data.runtime.id, activeA.data.runtime.id, 'another Host cannot silently replace or kill A');
  }
  assert.equal((await request(second, '/api/health')).data.liveSessionCount, 0);
  assert.equal((await request(first, `/api/conversations/${a}/close`, { stopCurrent: true })).status, 200);
  const activeB = await request(second, `/api/conversations/${b}/activate`, {}); assert.equal(activeB.status, 200, JSON.stringify(activeB));
  assert.notEqual(activeB.data.runtime.id, activeA.data.runtime.id);
  assert.equal((await request(first, '/api/health')).data.liveSessionCount, 0);
  assert.equal((await request(second, '/api/health')).data.liveSessionCount, 1);
  assert.equal((await request(first, `/api/conversations/${a}/activate`, {})).status, 409, 'an idle foreign Pi also retains its lease');
  assert.equal((await request(second, `/api/conversations/${b}/close`, { stopCurrent: true })).status, 200);
  const reactivated = await request(first, `/api/conversations/${a}/activate`, {}); assert.equal(reactivated.status, 200);
  assert.notEqual(reactivated.data.runtime.id, activeA.data.runtime.id); assert.equal(reactivated.data.runtime.conversationId, a);
  assert.ok(requests.every((value) => !/^\/api\/(live-sessions|sessions|session-history|file|files)(?:\/|$)/.test(value)));
  fs.mkdirSync('.plans/workspace-conversations', { recursive: true });
  fs.writeFileSync('.plans/workspace-conversations/multi-host-network.json', JSON.stringify({ independentAgentDirs: true, sharedNativeRoot: true, exclusivePi: true, oldBusinessRequests: 0, requests }, null, 2));
  console.log('PASS: new-API exclusion across two agent dirs, foreign stop refusal, confirmed handoff and stable conversation/reactivated live identities');
} finally {
  for (const child of children.reverse()) { child.kill('SIGTERM'); await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve)); }
  fs.rmSync(root, { recursive: true, force: true });
}
