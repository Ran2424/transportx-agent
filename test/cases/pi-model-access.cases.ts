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

caseTest('provider deletion cannot overwrite a model update across await', async (t: any) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-model-concurrent-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const file = path.join(agentDir, 'models.json');
  fs.writeFileSync(file, JSON.stringify({ providers: { remove: { baseUrl: 'https://example.com', api: 'openai-completions', models: [{ id: 'a' }] }, keep: { baseUrl: 'https://example.com', api: 'openai-completions', models: [{ id: 'b', name: 'before' }] } } }));
  await Promise.all([deletePiModelProvider('remove', agentDir), updatePiModel({ provider: 'keep', modelId: 'b', name: 'after', reasoning: true }, agentDir)]);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(config.providers.remove, undefined);
  assert.equal(config.providers.keep.models[0].name, 'after');
  assert.ok(fs.existsSync(`${file}.bak`));
});

caseTest('corrupt JSON refuses mutations, and atomic writes retain the previous valid copy', async (t: any) => {
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
});

caseTest('another process cannot take a Host lease or mutate its Agent directory', async (t: any) => {
  const { acquireWriteLease } = require('../../bin/util/json-storage.js');
  const { execFileSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-host-writer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const release = acquireWriteLease(path.join(root, 'host'));
  t.after(release);
  const output = execFileSync(process.execPath, ['-e', `const {acquireWriteLease,assertHostWriter}=require('./bin/util/json-storage.js');for(const attempt of [()=>acquireWriteLease(require('path').join(process.argv[1],'host')),()=>assertHostWriter(process.argv[1])]){try{attempt();process.exitCode=1}catch(e){if(e.code!=='writer_busy')throw e;process.stdout.write(e.code+'\\n')}}`, root], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(output.trim().split('\n').length, 2);
});

caseTest('failed atomic replacement preserves the target, backup and removes temporary files', (t: any) => {
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
});
