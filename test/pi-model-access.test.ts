const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { connectPiModelProvider, disconnectPiModelProvider, listAvailablePiModels, listPiModelProviders } = require('../bin/pi-model-access.js');

test('Pi provider access reuses auth.json in the configured TransportX directory', async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-model-access-'));
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
  assert.equal(fs.statSync(path.join(agentDir, 'auth.json')).mode & 0o777, 0o600);
  const models = await listAvailablePiModels(agentDir);
  const providerModels = models.filter((model: { provider: string }) => model.provider === candidate.id);
  assert.equal(providerModels.length, candidate.modelCount);
  assert.ok(providerModels.every((model: { id?: string; contextWindow?: number; maxOutput?: number }) => model.id && model.contextWindow && model.maxOutput));

  await disconnectPiModelProvider(candidate.id, agentDir);
  const after = await listPiModelProviders(agentDir);
  assert.equal(after.find((provider: { id: string; credentialStored: boolean }) => provider.id === candidate.id)?.credentialStored, false);
});
