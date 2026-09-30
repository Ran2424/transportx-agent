const { registerSuite } = require('../support/test-suite.ts');
require('../cases/auth-cookie.cases.ts');
require('../cases/auth-rpc-handler.cases.ts');
registerSuite('auth');
