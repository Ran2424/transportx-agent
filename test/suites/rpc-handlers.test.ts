const { registerSuite } = require('../support/test-suite.ts');
require('../cases/html-export-rpc-handler.cases.ts');
require('../cases/module-rpc-handler.cases.ts');
require('../cases/native-rpc-handler.cases.ts');
require('../cases/platform-rpc-handler.cases.ts');
registerSuite('rpc-handlers');
