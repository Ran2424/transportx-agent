const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');

const { createModuleRpcHandlers } = require('../../bin/rpc-handlers/module.js');

const reply = {
  success(data: unknown) { return { success: true, data }; },
  failure(error: string) { return { success: false, error }; },
};

caseTest('Module RPC registry consistently gates installation commands outside Desktop', async () => {
  const handlers = createModuleRpcHandlers({
    desktopMode: false,
    installer: {},
    registry: { modules: new Map(), get() { return undefined; } },
    reloadModules() {},
    setModuleEnabled() {},
    hasActiveModule() { return false; },
    overview() { return {}; },
    errorMessage(error: unknown) { return String(error); },
  });
  const expected = 'Module installation is only available in the desktop app';
  for (const [type, handler] of Object.entries(handlers) as Array<[string, { handle(command: unknown, response: unknown): Promise<unknown> | unknown }]>) {
    assert.deepEqual(await handler.handle({ type }, reply), { success: false, error: expected });
  }
});
