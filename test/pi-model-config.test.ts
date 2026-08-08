const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { addPiModel } = require('../bin/pi-model-config.js');

test('Pi model connections are persisted in the TransportX agent directory', (t: any) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-model-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const result = addPiModel({
    provider: 'traffic-proxy',
    modelId: 'traffic-reasoner-v1',
    name: 'Traffic Reasoner',
    api: 'openai-completions',
    baseUrl: 'https://models.example.com/v1/',
    apiKey: 'sk-local-test',
    reasoning: true,
    images: true,
  }, agentDir);
  assert.equal(result.reference, 'traffic-proxy/traffic-reasoner-v1');
  const models = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8'));
  assert.equal(models.providers['traffic-proxy'].baseUrl, 'https://models.example.com/v1');
  assert.equal(models.providers['traffic-proxy'].models[0].reasoning, true);
  assert.deepEqual(models.providers['traffic-proxy'].models[0].input, ['text', 'image']);
  assert.equal(models.providers['traffic-proxy'].apiKey, undefined);
  const auth = JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8'));
  assert.deepEqual(auth['traffic-proxy'], { type: 'api_key', key: 'sk-local-test' });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(agentDir, 'models.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(agentDir, 'auth.json')).mode & 0o777, 0o600);
  }
});

test('invalid model connections do not create Pi configuration files', (t: any) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-model-invalid-'));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  assert.throws(() => addPiModel({ provider: 'BAD PROVIDER', modelId: 'x', api: 'openai-responses', baseUrl: 'file:///tmp/model', apiKey: 'secret' }, agentDir), /Provider ID/);
  assert.equal(fs.existsSync(path.join(agentDir, 'models.json')), false);
  assert.equal(fs.existsSync(path.join(agentDir, 'auth.json')), false);
});
