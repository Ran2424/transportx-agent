const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createPlatformRpcHandlers } = require('../bin/rpc-handlers/platform.js');

test('Platform RPC registry serves the current overview', () => {
  const handlers = createPlatformRpcHandlers(() => ({ modules: 3 }));
  assert.deepEqual(handlers.get_platform_overview.handle({ type: 'get_platform_overview' }, {
    success(data: unknown) { return { success: true, data }; },
    failure(error: string) { return { success: false, error }; },
  }), { success: true, data: { modules: 3 } });
});
