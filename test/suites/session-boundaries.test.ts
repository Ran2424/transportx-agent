const { registerSuite } = require('../support/test-suite.ts');
require('../cases/session-workspace.cases.ts');
require('../cases/session-rpc-handler.cases.ts');
registerSuite('session-boundaries');
