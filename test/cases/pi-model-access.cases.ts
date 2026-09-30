const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { connectPiModelProvider, disconnectPiModelProvider, listAvailablePiModels, listPiModelProviders } = require('../../bin/pi-model-access.js');
const { updatePiModel, deletePiModel, deletePiModelProvider } = require('../../bin/pi-model-config.js');

caseTest('Pi provider access reuses auth.json in the configured TransportX directory', async () => {
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

caseTest('model settings update and delete persist in models.json', async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-model-config-'));
  const modelsPath = path.join(agentDir, 'models.json');
  fs.writeFileSync(modelsPath, JSON.stringify({ providers: {
    custom: {
      baseUrl: 'https://api.example.com/v1',
      api: 'openai-responses',
      models: [{ id: 'traffic-model', input: ['text'], reasoning: false }],
    },
  }}));

  await updatePiModel({ provider: 'custom', modelId: 'traffic-model', name: 'Traffic Model', contextWindow: 256000, reasoning: true, images: true }, agentDir);
  let config = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
  assert.deepEqual(config.providers.custom.models[0], { id: 'traffic-model', input: ['text', 'image'], reasoning: true, name: 'Traffic Model', contextWindow: 256000 });

  await deletePiModel('custom', 'traffic-model', agentDir);
  config = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
  assert.equal(config.providers.custom.models, undefined);

  await deletePiModelProvider('custom', agentDir);
  config = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
  assert.deepEqual(config.providers, {});
});
