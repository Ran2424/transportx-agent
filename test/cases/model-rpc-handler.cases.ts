const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');

const { createModelRpcHandlers } = require('../../bin/rpc-handlers/model.js');

const reply = {
  success(data: unknown) { return { success: true, data }; },
  failure(error: string) { return { success: false, error }; },
};

caseTest('Model RPC registry registers every model and Provider command', async () => {
  const handlers = createModelRpcHandlers({
    agentDir: '/tmp/transportx-models',
    getAvailableModels: async () => ['openai/gpt-5.5'],
    invalidateModelListCache() {},
    errorMessage(error: unknown) { return String(error); },
  });
  assert.deepEqual(Object.keys(handlers).sort(), [
    'add_model',
    'connect_model_provider',
    'delete_model',
    'delete_model_provider',
    'disconnect_model_provider',
    'get_available_models',
    'get_model_providers',
    'update_model',
  ]);
  assert.deepEqual(await handlers.get_available_models.handle({ type: 'get_available_models' }, reply), {
    success: true,
    data: { models: ['openai/gpt-5.5'] },
  });
});
